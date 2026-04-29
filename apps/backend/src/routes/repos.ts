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
 *     cascades to `agent_repos` AND `repo_edges` via FK; any agent that had
 *     this repo attached loses the attachment and any edges referencing it.
 *     Caller-facing: a single 200 with the deleted id.
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
      const [existing] = await db
        .select()
        .from(schema.repos)
        .where(
          and(
            eq(schema.repos.remoteUrl, body.remoteUrl),
            eq(schema.repos.branch, branch),
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

      const [row] = await db
        .insert(schema.repos)
        .values({
          remoteUrl: body.remoteUrl,
          branch,
          gitPatEnvelope,
        })
        .returning()

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

      // Cascades to agent_repos and repo_edges via FK ON DELETE CASCADE.
      const [row] = await db
        .delete(schema.repos)
        .where(eq(schema.repos.id, id))
        .returning({ id: schema.repos.id })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type ReposRouter = typeof reposRouter
