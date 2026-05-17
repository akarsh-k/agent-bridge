/**
 * `/api/repos` — global deduped store of (remote_url, branch).
 *
 * Semantics worth re-reading before editing:
 *
 *   POST /api/repos
 *     new pair (url, branch)     → 201, `existed: false`, PAT applied
 *     existing pair              → 200, `existed: true`, PAT IGNORED
 *
 *   PATCH /api/repos/:id
 *     gitPat: 'set'              → replace envelope, updated_at ticks
 *     gitPat: 'unchanged'|omitted → no-op (but endpoint requires at least
 *                                  one field, so 'unchanged' is the only
 *                                  valid PATCH if you want a no-op)
 *     gitPat: 'clear'            → envelope → NULL
 *
 *   DELETE /api/repos/:id
 *     soft-deletes: flips `repos.deletion_pending=true`, drops every
 *     `agent_repos` row that referenced the repo (FK cascade), and
 *     enqueues a `delete-repo` job. The worker waits for any in-flight
 *     clone/index/wiki for this repo to finish, `rm -rf`s the on-disk
 *     source dir, then hard-deletes the row. List endpoints filter
 *     `deletion_pending=true` so the repo disappears from the UI
 *     immediately. Idempotent: a second DELETE against an already-pending
 *     row no-ops at 200.
 *
 * Worker-owned columns (`status`, `local_path`, `last_indexed_at`,
 * `last_error`) are READ-ONLY from this router's perspective. They're
 * returned in the response so the UI can show clone/index state, but are
 * never settable via HTTP.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  repoCreateInputSchema,
  repoIdParamSchema,
  repoResponseSchema,
  repoUpdateInputSchema,
  type RepoIndexSummary,
  type RepoResponse,
} from '@agent-bridge/shared'
import { readIndexSummary } from '@agent-bridge/shared/gitnexus'
import { repoSourceDir } from '@agent-bridge/shared/paths'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import { enqueueDeleteRepo } from '../lib/queues.js'
import {
  applySecretInput,
  applySecretInputForCreate,
  envelopeToSentinel,
  SECRET_UNCHANGED,
} from '../lib/secrets.js'

type RepoRow = typeof schema.repos.$inferSelect

/**
 * Build the HTTP-shaped repo response. `summary` is the lazily-read
 * `<source>/.gitnexus/meta.json` blob (see `readIndexSummary`) — `null`
 * when the repo has never been indexed or the source tree was wiped.
 * Passing `undefined` is equivalent to `null`; we keep the param optional
 * so the POST-create path (where the repo hasn't been cloned yet, let
 * alone indexed) doesn't have to manufacture a no-op `null`.
 */
export function toRepoResponse(
  row: RepoRow,
  summary?: RepoIndexSummary | null,
): RepoResponse {
  return repoResponseSchema.parse({
    id: row.id,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
    localPath: row.localPath,
    status: row.status,
    lastIndexedAt: row.lastIndexedAt ? row.lastIndexedAt.toISOString() : null,
    lastError: row.lastError,
    gitPat: envelopeToSentinel(row.gitPatEnvelope),
    indexSummary: summary ?? null,
    wikiStatus: row.wikiStatus,
    wikiGeneratedAt: row.wikiGeneratedAt
      ? row.wikiGeneratedAt.toISOString()
      : null,
    wikiPages: row.wikiPages,
    wikiLastError: row.wikiLastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

/**
 * Read `meta.json` for a single repo row, tolerating the common "never
 * indexed yet" case (returns `null`). Centralised so route handlers don't
 * duplicate the `repoSourceDir(descriptor)` plumbing.
 */
async function loadIndexSummary(
  row: RepoRow,
): Promise<RepoIndexSummary | null> {
  return readIndexSummary(
    repoSourceDir({
      id: row.id,
      remoteUrl: row.remoteUrl,
      branch: row.branch,
    }),
  )
}

const DEFAULT_BRANCH = 'main'

export const reposRouter = new Hono()
  // ─── POST /api/repos ─────────────────────────────────────────────────────
  .post(
    '/',
    zValidator('json', repoCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const body = c.req.valid('json')
      const { db } = getDb()
      const branch = body.branch ?? DEFAULT_BRANCH

      // Idempotent find-or-create: look up the (url, branch) pair first. If
      // it already exists, return it with HTTP 200 and DO NOT apply any PAT
      // the caller sent — that path is reserved for PATCH. Checking first
      // avoids spending encrypt CPU on a secret we're about to discard, and
      // keeps the "PAT ignored on existing" contract obvious in the code.
      // The index summary (if any) is read lazily from `meta.json` so a
      // re-resolve to an already-indexed repo carries its counts through.
      // Excludes deletion-pending rows so re-adding a just-deleted repo
      // doesn't hand the caller a doomed row. If the unique index
      // (`repos_url_branch_uq`) fires because a pending row already
      // exists, the operator can retry once the worker finishes
      // cleanup — typically seconds.
      const [existing] = await db
        .select()
        .from(schema.repos)
        .where(
          and(
            eq(schema.repos.remoteUrl, body.remoteUrl),
            eq(schema.repos.branch, branch),
            eq(schema.repos.deletionPending, false),
          ),
        )
        .limit(1)

      if (existing) {
        const summary = await loadIndexSummary(existing)
        return c.json(
          {
            ok: true as const,
            existed: true,
            repo: toRepoResponse(existing, summary),
          },
          200,
        )
      }

      const gitPatEnvelope = applySecretInputForCreate(body.gitPat)

      let row: RepoRow | undefined
      try {
        ;[row] = await db
          .insert(schema.repos)
          .values({
            remoteUrl: body.remoteUrl,
            branch,
            gitPatEnvelope,
          })
          .returning()
      } catch (err) {
        // Postgres `unique_violation` (23505). The find-above filtered
        // `deletion_pending=true`, so reaching this branch means a row
        // with the same (remote_url, branch) is sitting in soft-delete
        // limbo while the worker `delete-repo` job tears it down.
        // Surface as a focused 409 with retry guidance instead of the
        // generic 500 the unhandled error catch would produce.
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message:
              `a repo with remote_url=${body.remoteUrl} branch=${branch} ` +
              `is currently being deleted; retry in a moment.`,
          })
        }
        throw err
      }

      if (!row) {
        return httpError(c, {
          code: 'internal',
          message: 'insert returned no rows',
        })
      }

      return c.json(
        {
          ok: true as const,
          existed: false,
          repo: toRepoResponse(row),
        },
        201,
      )
    },
  )
  // ─── GET /api/repos ──────────────────────────────────────────────────────
  .get('/', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.deletionPending, false))
      .orderBy(asc(schema.repos.createdAt))

    // Read `meta.json` for every repo in parallel. Each call is one small
    // file read and tolerates a missing file as `null`, so for the
    // expected single-operator scale (tens of repos) this is cheap. If we
    // ever get into the hundreds this becomes the obvious hotspot and a
    // batched registry.json lookup can replace it.
    const summaries = await Promise.all(rows.map((r) => loadIndexSummary(r)))

    return c.json({
      ok: true as const,
      repos: rows.map((row, i) => toRepoResponse(row, summaries[i])),
    })
  })
  // ─── GET /api/repos/:id ──────────────────────────────────────────────────
  .get(
    '/:id',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .select()
        .from(schema.repos)
        .where(eq(schema.repos.id, id))
        .limit(1)

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }

      const summary = await loadIndexSummary(row)
      return c.json({
        ok: true as const,
        repo: toRepoResponse(row, summary),
      })
    },
  )
  // ─── PATCH /api/repos/:id ────────────────────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', repoUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const nextEnvelope = applySecretInput(body.gitPat)
      if (nextEnvelope === SECRET_UNCHANGED) {
        // The schema requires `gitPat` on PATCH, so 'unchanged' here is a
        // valid but pointless request. Return a 422-equivalent using our
        // validation code so the client learns to stop sending it.
        return httpError(c, {
          code: 'validation_failed',
          message:
            'PATCH /api/repos/:id with { gitPat: { action: "unchanged" } } ' +
            'is a no-op; omit the call or use "set"/"clear".',
        })
      }

      const [row] = await db
        .update(schema.repos)
        .set({ gitPatEnvelope: nextEnvelope })
        .where(eq(schema.repos.id, id))
        .returning()

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }

      // A PATCH can't affect meta.json (only gitPat moves here), but we
      // still include the summary so response parity with GET holds —
      // clients that echo PATCH into their store don't accidentally wipe
      // the summary they had a moment ago.
      const summary = await loadIndexSummary(row)

      return c.json({
        ok: true as const,
        repo: toRepoResponse(row, summary),
      })
    },
  )
  // ─── DELETE /api/repos/:id ───────────────────────────────────────────────
  .delete(
    '/:id',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      // Two-phase soft delete:
      //   1. Mark the row `deletion_pending=true` and detach `agent_repos`
      //      so the UI hides it immediately (list routes filter pending).
      //      `agent_repos` rows go via explicit DELETE, not FK cascade,
      //      because the row itself stays around until the worker
      //      finishes; FK cascade would only fire on the eventual hard
      //      delete inside the worker job.
      //   2. Enqueue `delete-repo`. The worker waits for any in-flight
      //      clone/index/wiki on this repo to finish, `rm -rf`s the
      //      on-disk source dir, then hard-deletes the row (which
      //      cascades to `repo_relationships` at that moment).
      // Idempotent: re-DELETE on a pending row re-enqueues the job
      // (cheap; the worker dedupes by id) and returns the same shape.
      const [row] = await db
        .update(schema.repos)
        .set({ deletionPending: true })
        .where(eq(schema.repos.id, id))
        .returning({
          id: schema.repos.id,
          remoteUrl: schema.repos.remoteUrl,
          branch: schema.repos.branch,
        })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }

      await db
        .delete(schema.agentRepos)
        .where(eq(schema.agentRepos.repoId, id))

      try {
        await enqueueDeleteRepo({
          repoId: row.id,
          remoteUrl: row.remoteUrl,
          branch: row.branch,
        })
      } catch (err) {
        // Enqueue failure is rare (Redis down). The row stays pending so
        // the operator can retry the DELETE — the worker job is the only
        // thing that performs the disk cleanup, so we surface this rather
        // than silently leaving the repo half-removed.
        const message = err instanceof Error ? err.message : String(err)
        return httpError(c, {
          code: 'internal',
          message: `failed to enqueue delete-repo job: ${message}`,
        })
      }

      return c.json({
        ok: true as const,
        id: row.id,
        deletionPending: true,
      })
    },
  )

export type ReposRouter = typeof reposRouter
