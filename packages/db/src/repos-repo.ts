/**
 * Repo-table mutation helpers used by both the backend route (which does the
 * status transitions that prevent double-enqueue races) and the worker
 * (which owns every terminal transition). Keeping both callers behind a
 * single module means the status-field invariants (`localPath` nulled on
 * failure, `lastError` cleared on success, etc.) live in exactly one place
 * and can't silently drift between producer and consumer.
 *
 * Status lifecycle (canonical reference):
 *
 *   pending ─► cloning ─┬─► cloned ─► indexing ─┬─► ready
 *                       │                       └─► error
 *                       └─► error
 *
 *   [any terminal] ─► cloning  (re-clone)
 *   cloned | ready | error ─► indexing  (manual re-index or auto after clone)
 *
 * `lastIndexedAt` is stamped by `finishIndex` on success. `localPath` is
 * the absolute path to the finished `source/` directory; cleared back to
 * `null` on clone failure so the UI doesn't show a stale path. Index
 * failures LEAVE `localPath` intact — the source tree is still on disk,
 * we just couldn't analyze it this time.
 *
 * Wiki lifecycle (orthogonal):
 *
 *   wiki_status: none ─► generating ─┬─► ready
 *                                    └─► error
 *
 *   ready | error ─► generating  (manual re-generate from the UI)
 *
 * The CAS guard for `generating` requires `status='ready'` because
 * `gitnexus wiki` reads `<source>/.gitnexus/meta.json` which only exists
 * post-index. `wiki_*` columns never affect the main `status` — a repo
 * with a failed wiki run is still usable for chat + re-indexing.
 *
 * Node-only.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AgentBridgeDb } from './client.js'
import { repos, type RepoRow } from './schema.js'

/**
 * Flip a repo row from `pending | cloned | ready | error` → `cloning`.
 * Uses a WHERE clause on the old status so two concurrent requests
 * can't both "win" — the second observes `rowCount === 0` and the
 * route surfaces a 409 without ever enqueueing a duplicate job.
 *
 * On success, `lastError` is cleared (stale errors from a prior failed
 * clone shouldn't linger across a fresh attempt) and `localPath` is set to
 * `null` (the old `source/` dir is about to be replaced atomically;
 * exposing the old path during cloning would lie to the UI).
 *
 * `ready` is in the allowed set because re-cloning a fully-indexed repo
 * is a supported action (the UI exposes it as "Re-clone"). The clone
 * worker will tear down `source/` and replace it atomically; a stale
 * `meta.json` briefly survives inside the old `source/` until the
 * rename lands, which is fine — no reader looks at it during a `cloning`
 * status. `indexing` is NOT in the allowed set because gitnexus analyze
 * is still walking `source/`; the clone route pre-checks that case and
 * returns a purpose-built 409 before calling this helper.
 *
 * Returns the updated row, or `null` if the CAS lost (another process
 * already transitioned the row).
 */
export async function markCloning(
  handle: AgentBridgeDb,
  repoId: string,
): Promise<RepoRow | null> {
  const [row] = await handle.db
    .update(repos)
    .set({
      status: 'cloning',
      lastError: null,
      localPath: null,
      // `updatedAt` is bumped by a trigger, but force it so the CAS WHERE
      // clause below doesn't land on a row that was stamped by an earlier
      // call inside the same transaction.
      updatedAt: sql`now()`,
    })
    .where(
      // Only flip from terminal-ish states; blocking same-row concurrent
      // transitions (pending → cloning and cloning → cloning both race,
      // as does cloning → indexing which lives briefly on the hot path).
      and(
        eq(repos.id, repoId),
        inArray(repos.status, ['pending', 'cloned', 'ready', 'error']),
      ),
    )
    .returning()

  return row ?? null
}

export type CloneResult =
  | { readonly status: 'cloned'; readonly localPath: string }
  | { readonly status: 'error'; readonly lastError: string }

/**
 * Terminal transition from `cloning` → `cloned | error`. Worker-only (the
 * HTTP API must never write these columns). `lastError` is cleared on
 * success, `localPath` is cleared on failure — symmetric with `markCloning`.
 *
 * No CAS guard here: the worker is the sole owner of this transition and
 * `concurrency: 1` on the clone queue ensures only one handler per repo
 * runs at a time. We return the row so the caller can publish a consistent
 * `repo.clone.ok` / `.fail` payload without re-fetching.
 */
export async function finishClone(
  handle: AgentBridgeDb,
  repoId: string,
  result: CloneResult,
): Promise<RepoRow | null> {
  if (result.status === 'cloned') {
    const [row] = await handle.db
      .update(repos)
      .set({
        status: 'cloned',
        localPath: result.localPath,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(repos.id, repoId))
      .returning()
    return row ?? null
  }

  // status === 'error'
  const [row] = await handle.db
    .update(repos)
    .set({
      status: 'error',
      localPath: null,
      lastError: result.lastError,
      updatedAt: sql`now()`,
    })
    .where(eq(repos.id, repoId))
    .returning()
  return row ?? null
}

/**
 * Worker-side read of the repo row. Used by the clone job to grab the
 * encrypted PAT envelope + remote URL + branch. Kept separate from the
 * backend's `/api/repos/:id` GET so the worker never has to speak HTTP to
 * its own backend for trivially-local reads.
 *
 * Returns `null` if the repo has been deleted between enqueue and dequeue
 * (in which case the job handler should short-circuit gracefully).
 */
export async function getForWorker(
  handle: AgentBridgeDb,
  repoId: string,
): Promise<RepoRow | null> {
  const [row] = await handle.db
    .select()
    .from(repos)
    .where(eq(repos.id, repoId))
    .limit(1)
  return row ?? null
}

/**
 * Hard-delete a repo row. Cascades drop `agent_repos`, `repo_edges`, and
 * `worker_jobs` (and their `worker_events` via the worker_jobs cascade).
 * Used by the `delete-repo` worker job after the on-disk source dir has
 * been removed; the backend's HTTP DELETE flips `deletion_pending=true`
 * and detaches `agent_repos` first, then enqueues the worker job which
 * calls this once cleanup succeeds.
 *
 * Returns `true` if a row was removed, `false` if it was already gone
 * (idempotent — covers the "manual SQL delete raced our worker" case
 * and re-runs of the same job).
 */
export async function hardDelete(
  handle: AgentBridgeDb,
  repoId: string,
): Promise<boolean> {
  const [row] = await handle.db
    .delete(repos)
    .where(eq(repos.id, repoId))
    .returning({ id: repos.id })
  return Boolean(row)
}

// ─── indexing ────────────────────────────────────────────────────────────

/**
 * Flip a repo row from `cloned | ready | error` → `indexing`. Same CAS
 * pattern as `markCloning`: two concurrent "index now" requests can't
 * both win.
 *
 * Does NOT touch `localPath` — the source tree is still readable while we
 * analyze it. Does NOT touch `lastError` either; a historical clone error
 * is unrelated to the index error we're about to (possibly) produce, and
 * preserving it during the indexing window would be misleading. We clear
 * `lastError` only if the current status is `error` — that's "user clicked
 * retry", so their mental model is "start fresh".
 *
 * Returns the updated row, or `null` if the CAS lost.
 */
export async function markIndexing(
  handle: AgentBridgeDb,
  repoId: string,
): Promise<RepoRow | null> {
  const [row] = await handle.db
    .update(repos)
    .set({
      status: 'indexing',
      // Blanking lastError here is safe even for the `cloned → indexing`
      // path (it's already null) and actively helpful for `error → indexing`.
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(repos.id, repoId),
        inArray(repos.status, ['cloned', 'ready', 'error']),
      ),
    )
    .returning()

  return row ?? null
}

export type IndexResult =
  | { readonly status: 'ready'; readonly indexedAt: Date }
  | { readonly status: 'error'; readonly lastError: string }

/**
 * Terminal transition from `indexing` → `ready | error`. Worker-only.
 * Matches `finishClone`'s ownership model: backend never writes these
 * columns, `concurrency: 1` on the index queue prevents duplicate
 * handlers for the same repo.
 *
 * Success sets `status='ready'` + stamps `lastIndexedAt` so the UI can
 * show "indexed 3 minutes ago" without touching gitnexus artefacts.
 * Failure sets `status='error'` + stores the redacted message. The
 * counts themselves live in `<source>/.gitnexus/meta.json` (see
 * `@agent-bridge/shared/gitnexus`:`readIndexSummary`) and are read
 * lazily by the repo-read endpoints — a failed analyze simply leaves
 * the previous meta.json in place so stale counts still show.
 */
export async function finishIndex(
  handle: AgentBridgeDb,
  repoId: string,
  result: IndexResult,
): Promise<RepoRow | null> {
  if (result.status === 'ready') {
    const [row] = await handle.db
      .update(repos)
      .set({
        status: 'ready',
        lastIndexedAt: result.indexedAt,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(repos.id, repoId))
      .returning()
    return row ?? null
  }

  const [row] = await handle.db
    .update(repos)
    .set({
      status: 'error',
      lastError: result.lastError,
      updatedAt: sql`now()`,
    })
    .where(eq(repos.id, repoId))
    .returning()
  return row ?? null
}

// ─── wiki ────────────────────────────────────────────────────────────────
//
// Wiki state is orthogonal to the main `status` machine — see the design
// note in `@agent-bridge/shared/domain.ts` (`repoWikiStatuses`). The repo
// stays `status='ready'` while wiki gen runs, but `wiki_status` flips
// `none|ready|error → generating → ready|error`. We require
// `status='ready'` on the CAS to claim — gitnexus wiki reads
// `<source>/.gitnexus/meta.json` which only exists after a successful
// `analyze`. Pre-checking saves the worker a wasted spawn.

/**
 * Flip a repo row's wiki state from `none | ready | error` → `generating`,
 * but only when `status='ready'` (i.e. the repo has been successfully
 * indexed). Same CAS pattern as `markCloning` / `markIndexing`: two
 * concurrent "generate now" requests can't both win.
 *
 * Clears `wiki_last_error` (a fresh attempt should not surface a stale
 * error). Does NOT touch the main `status` column or `last_error` —
 * wiki failures belong to wiki state only.
 *
 * Returns the updated row, or `null` if the CAS lost (status not ready,
 * or another wiki job already in flight).
 */
export async function markWikiGenerating(
  handle: AgentBridgeDb,
  repoId: string,
): Promise<RepoRow | null> {
  const [row] = await handle.db
    .update(repos)
    .set({
      wikiStatus: 'generating',
      wikiLastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(repos.id, repoId),
        eq(repos.status, 'ready'),
        inArray(repos.wikiStatus, ['none', 'ready', 'error']),
      ),
    )
    .returning()

  return row ?? null
}

export type WikiResult =
  | {
      readonly status: 'ready'
      readonly generatedAt: Date
      readonly pages: number | null
    }
  | { readonly status: 'error'; readonly lastError: string }

/**
 * Terminal transition `wiki_status='generating' → ready | error`.
 * Worker-only — same ownership model as `finishClone` / `finishIndex`.
 *
 * Success stamps `wiki_generated_at` + the parsed `wiki_pages` count
 * (nullable: a no-op `Mode: up-to-date` run leaves `pages` null and
 * `generated_at` is whatever the worker passed — typically `now()`).
 * Failure sets `wiki_last_error` and leaves the previous
 * `wiki_generated_at` / `wiki_pages` intact so the UI can still link to
 * a stale-but-readable wiki from a prior successful run.
 */
export async function finishWiki(
  handle: AgentBridgeDb,
  repoId: string,
  result: WikiResult,
): Promise<RepoRow | null> {
  if (result.status === 'ready') {
    const [row] = await handle.db
      .update(repos)
      .set({
        wikiStatus: 'ready',
        wikiGeneratedAt: result.generatedAt,
        wikiPages: result.pages,
        wikiLastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(repos.id, repoId))
      .returning()
    return row ?? null
  }

  const [row] = await handle.db
    .update(repos)
    .set({
      wikiStatus: 'error',
      wikiLastError: result.lastError,
      updatedAt: sql`now()`,
    })
    .where(eq(repos.id, repoId))
    .returning()
  return row ?? null
}
