/**
 * `/api/agents/:agentId/repo-edges` — per-agent directed edges between
 * attached repos.
 *
 * Invariants:
 *   - CHECK constraint `repo_edges_distinct_repos` prevents self-loops at
 *     the DB level (Zod also catches this at the edge, for a nicer error).
 *   - Both `fromRepoId` and `toRepoId` must be in `agent_repos` for this
 *     agent. Enforced here in a transaction so the SELECT + INSERT can't
 *     race. The DB has no way to model this cross-table invariant with a
 *     FK, so it lives in the application.
 *   - Duplicate edges between the same pair are ALLOWED (different connector
 *     labels are a legitimate modelling choice); no unique constraint.
 *
 * Cascade behaviour:
 *   - Deleting an agent cascades to its edges via FK.
 *   - Deleting a repo cascades to any edges that reference it via FK.
 *   - Detaching a repo from an agent (DELETE /api/agents/:id/repos/:repoId)
 *     removes matching edges in the same txn — that logic lives in the
 *     agent-repos router, not here.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  agentIdOnlyParamSchema,
  repoEdgeCreateInputSchema,
  repoEdgeParamSchema,
  repoEdgeResponseSchema,
  repoEdgeUpdateInputSchema,
  type RepoEdgeResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type RepoEdgeRow = typeof schema.repoEdges.$inferSelect

function toRepoEdgeResponse(row: RepoEdgeRow): RepoEdgeResponse {
  return repoEdgeResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    fromRepoId: row.fromRepoId,
    toRepoId: row.toRepoId,
    connector: row.connector,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export const repoEdgesRouter = new Hono()
  // ─── POST /api/agents/:agentId/repo-edges ────────────────────────────────
  .post(
    '/',
    zValidator('param', agentIdOnlyParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', repoEdgeCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      // Cross-table invariant: both endpoints must already be attached.
      // A txn makes this race-safe against a concurrent detach.
      try {
        const row = await db.transaction(async (tx) => {
          const attachments = await tx
            .select({ repoId: schema.agentRepos.repoId })
            .from(schema.agentRepos)
            .where(
              and(
                eq(schema.agentRepos.agentId, agentId),
                inArray(schema.agentRepos.repoId, [
                  body.fromRepoId,
                  body.toRepoId,
                ]),
              ),
            )

          const attached = new Set(attachments.map((a) => a.repoId))
          const missing: string[] = []
          if (!attached.has(body.fromRepoId)) missing.push(body.fromRepoId)
          if (!attached.has(body.toRepoId)) missing.push(body.toRepoId)

          if (missing.length > 0) {
            throw new EdgeMembershipError(agentId, missing)
          }

          const [inserted] = await tx
            .insert(schema.repoEdges)
            .values({
              agentId,
              fromRepoId: body.fromRepoId,
              toRepoId: body.toRepoId,
              connector: body.connector,
              description: body.description ?? null,
            })
            .returning()

          return inserted
        })

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        publishAgentConfig({
          agentId,
          action: 'added',
          resource: 'repo_edge',
          label: row.connector,
        })
        return c.json(
          { ok: true as const, edge: toRepoEdgeResponse(row) },
          201,
        )
      } catch (err) {
        if (err instanceof EdgeMembershipError) {
          return httpError(c, {
            code: 'conflict',
            message: `repo(s) not attached to agent ${err.agentId}: ${err.missing.join(', ')}`,
          })
        }
        if (isPostgresErrorWithCode(err, PG.CHECK_VIOLATION)) {
          // `repo_edges_distinct_repos` — Zod already rejects this, so
          // seeing it here means someone bypassed validation.
          return httpError(c, {
            code: 'validation_failed',
            message: 'fromRepoId and toRepoId must differ',
          })
        }
        if (isPostgresErrorWithCode(err, PG.FOREIGN_KEY_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: 'agent or repo was deleted concurrently; retry',
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/repo-edges ─────────────────────────────────
  .get(
    '/',
    zValidator('param', agentIdOnlyParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { db } = getDb()

      // No separate agent-exists check: an unknown agent just yields an
      // empty list, which is indistinguishable for the caller anyway. We
      // keep the 404 for mutating endpoints because the blast radius
      // matters there.
      const rows = await db
        .select()
        .from(schema.repoEdges)
        .where(eq(schema.repoEdges.agentId, agentId))
        .orderBy(asc(schema.repoEdges.createdAt))

      return c.json({
        ok: true as const,
        edges: rows.map(toRepoEdgeResponse),
      })
    },
  )
  // ─── PATCH /api/agents/:agentId/repo-edges/:edgeId ───────────────────────
  .patch(
    '/:edgeId',
    zValidator('param', repoEdgeParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', repoEdgeUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, edgeId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.repoEdges.$inferInsert> = {}
      if ('connector' in body) patch.connector = body.connector
      if ('description' in body) patch.description = body.description ?? null

      const [row] = await db
        .update(schema.repoEdges)
        .set(patch)
        .where(
          and(
            eq(schema.repoEdges.id, edgeId),
            eq(schema.repoEdges.agentId, agentId),
          ),
        )
        .returning()

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `edge ${edgeId} not found on agent ${agentId}`,
        })
      }

      publishAgentConfig({
        agentId,
        action: 'updated',
        resource: 'repo_edge',
        label: row.connector,
      })
      return c.json({ ok: true as const, edge: toRepoEdgeResponse(row) })
    },
  )
  // ─── DELETE /api/agents/:agentId/repo-edges/:edgeId ──────────────────────
  .delete(
    '/:edgeId',
    zValidator('param', repoEdgeParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, edgeId } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.repoEdges)
        .where(
          and(
            eq(schema.repoEdges.id, edgeId),
            eq(schema.repoEdges.agentId, agentId),
          ),
        )
        .returning({
          id: schema.repoEdges.id,
          connector: schema.repoEdges.connector,
        })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `edge ${edgeId} not found on agent ${agentId}`,
        })
      }

      publishAgentConfig({
        agentId,
        action: 'removed',
        resource: 'repo_edge',
        label: row.connector,
      })
      return c.json({ ok: true as const, id: row.id })
    },
  )

export type RepoEdgesRouter = typeof repoEdgesRouter

/**
 * Thrown inside the create-edge transaction so the outer handler can map
 * it to a clean `conflict` response without depending on PG error codes.
 */
class EdgeMembershipError extends Error {
  readonly agentId: string
  readonly missing: readonly string[]

  constructor(agentId: string, missing: readonly string[]) {
    super(
      `repo(s) not attached to agent ${agentId}: ${missing.join(', ')}`,
    )
    this.name = 'EdgeMembershipError'
    this.agentId = agentId
    this.missing = missing
  }
}
