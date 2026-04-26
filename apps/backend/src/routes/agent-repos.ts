/**
 * `/api/agents/:agentId/repos` — per-agent attachments to the global repo
 * store.
 *
 * The join table (`agent_repos`) carries the per-agent context: what role
 * this repo plays ("frontend"), a description of its relationship to the
 * rest of the graph, and React-Flow canvas coordinates. The global repo's
 * status / PAT / last-indexed fields live on `repos` and are returned
 * nested as `.repo` in every response.
 *
 * Detach is the one place that needs a transaction: the FKs on
 * `repo_edges` don't know about `agent_repos`, so removing an attachment
 * without also removing the edges that reference it would leave orphan
 * connector lines pointing at a non-attached repo. We delete them
 * together, in one atomic txn.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, or } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  agentIdOnlyParamSchema,
  agentRepoParamSchema,
  attachRepoInputSchema,
  attachRepoUpdateInputSchema,
  attachedRepoResponseSchema,
  type AttachedRepoResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import { toRepoResponse } from './repos.js'

type AgentRepoRow = typeof schema.agentRepos.$inferSelect
type RepoRow = typeof schema.repos.$inferSelect

function toAttachedRepoResponse(
  attach: AgentRepoRow,
  repo: RepoRow,
): AttachedRepoResponse {
  return attachedRepoResponseSchema.parse({
    repo: toRepoResponse(repo),
    role: attach.role,
    description: attach.description,
    positionX: attach.positionX,
    positionY: attach.positionY,
    attachedAt: attach.createdAt.toISOString(),
    attachmentUpdatedAt: attach.updatedAt.toISOString(),
  })
}

async function loadAgent(agentId: string) {
  const { db } = getDb()
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return agent
}

export const agentReposRouter = new Hono()
  // ─── POST /api/agents/:agentId/repos ─────────────────────────────────────
  .post(
    '/',
    zValidator('param', agentIdOnlyParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', attachRepoInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      // Pre-check both FKs so we can return a useful "which one?" message.
      // A race between these SELECTs and the INSERT would still be caught
      // by the FK (23503), just with a generic message.
      const agent = await loadAgent(agentId)
      if (!agent) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const [repo] = await db
        .select()
        .from(schema.repos)
        .where(eq(schema.repos.id, body.repoId))
        .limit(1)
      if (!repo) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${body.repoId} not found`,
        })
      }

      try {
        const [row] = await db
          .insert(schema.agentRepos)
          .values({
            agentId,
            repoId: body.repoId,
            role: body.role ?? null,
            description: body.description ?? null,
            positionX: body.positionX ?? 0,
            positionY: body.positionY ?? 0,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        return c.json(
          { ok: true as const, attachment: toAttachedRepoResponse(row, repo) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `repo ${body.repoId} is already attached to this agent`,
          })
        }
        if (isPostgresErrorWithCode(err, PG.FOREIGN_KEY_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message:
              'agent or repo was deleted concurrently; retry with fresh ids',
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/repos ──────────────────────────────────────
  .get(
    '/',
    zValidator('param', agentIdOnlyParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { db } = getDb()

      const agent = await loadAgent(agentId)
      if (!agent) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const rows = await db
        .select({
          attachment: schema.agentRepos,
          repo: schema.repos,
        })
        .from(schema.agentRepos)
        .innerJoin(
          schema.repos,
          eq(schema.agentRepos.repoId, schema.repos.id),
        )
        .where(eq(schema.agentRepos.agentId, agentId))
        .orderBy(asc(schema.agentRepos.createdAt))

      return c.json({
        ok: true as const,
        attachments: rows.map((r) =>
          toAttachedRepoResponse(r.attachment, r.repo),
        ),
      })
    },
  )
  // ─── PATCH /api/agents/:agentId/repos/:repoId ────────────────────────────
  .patch(
    '/:repoId',
    zValidator('param', agentRepoParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', attachRepoUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, repoId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.agentRepos.$inferInsert> = {}
      if ('role' in body) patch.role = body.role ?? null
      if ('description' in body) patch.description = body.description ?? null
      if ('positionX' in body) patch.positionX = body.positionX
      if ('positionY' in body) patch.positionY = body.positionY

      const [attach] = await db
        .update(schema.agentRepos)
        .set(patch)
        .where(
          and(
            eq(schema.agentRepos.agentId, agentId),
            eq(schema.agentRepos.repoId, repoId),
          ),
        )
        .returning()

      if (!attach) {
        return httpError(c, {
          code: 'not_found',
          message: `attachment (${agentId}, ${repoId}) not found`,
        })
      }

      const [repo] = await db
        .select()
        .from(schema.repos)
        .where(eq(schema.repos.id, repoId))
        .limit(1)
      if (!repo) {
        // Should be impossible because of the FK; surface as 500 if it ever
        // happens so we notice a schema drift rather than silently omit.
        return httpError(c, {
          code: 'internal',
          message: `repo ${repoId} vanished during patch`,
        })
      }

      return c.json({
        ok: true as const,
        attachment: toAttachedRepoResponse(attach, repo),
      })
    },
  )
  // ─── DELETE /api/agents/:agentId/repos/:repoId ───────────────────────────
  .delete(
    '/:repoId',
    zValidator('param', agentRepoParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, repoId } = c.req.valid('param')
      const { db } = getDb()

      // Transactional detach: drop any edges referencing this repo for
      // this agent before removing the attachment. If we did it in the
      // other order, a crash between ops would leave dangling edges that
      // violate the per-agent membership invariant.
      const result = await db.transaction(async (tx) => {
        const deletedEdges = await tx
          .delete(schema.repoEdges)
          .where(
            and(
              eq(schema.repoEdges.agentId, agentId),
              or(
                eq(schema.repoEdges.fromRepoId, repoId),
                eq(schema.repoEdges.toRepoId, repoId),
              ),
            ),
          )
          .returning({ id: schema.repoEdges.id })

        const [attach] = await tx
          .delete(schema.agentRepos)
          .where(
            and(
              eq(schema.agentRepos.agentId, agentId),
              eq(schema.agentRepos.repoId, repoId),
            ),
          )
          .returning({ repoId: schema.agentRepos.repoId })

        return {
          attach,
          edgesRemoved: deletedEdges.length,
        }
      })

      if (!result.attach) {
        return httpError(c, {
          code: 'not_found',
          message: `attachment (${agentId}, ${repoId}) not found`,
        })
      }

      return c.json({
        ok: true as const,
        repoId: result.attach.repoId,
        edgesRemoved: result.edgesRemoved,
      })
    },
  )

export type AgentReposRouter = typeof agentReposRouter
