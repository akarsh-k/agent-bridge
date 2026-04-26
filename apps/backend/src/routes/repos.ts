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
  type RepoResponse,
} from '@agent-bridge/shared'
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

export function toRepoResponse(row: RepoRow): RepoResponse {
  return repoResponseSchema.parse({
    id: row.id,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
    localPath: row.localPath,
    status: row.status,
    lastIndexedAt: row.lastIndexedAt ? row.lastIndexedAt.toISOString() : null,
    lastError: row.lastError,
    gitPat: envelopeToSentinel(row.gitPatEnvelope),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
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
        return c.json(
          {
            ok: true as const,
            existed: true,
            repo: toRepoResponse(existing),
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

    return c.json({
      ok: true as const,
      repos: rows.map(toRepoResponse),
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

      return c.json({ ok: true as const, repo: toRepoResponse(row) })
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

      return c.json({ ok: true as const, repo: toRepoResponse(row) })
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
