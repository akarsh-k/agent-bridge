/**
 * `/api/agents/:agentId/skills` — nested CRUD for agent skills.
 *
 * Agent-scoping invariant (critical):
 *   Every per-item query MUST filter by BOTH `agentId` (from URL) AND `id`
 *   (from URL). Otherwise a caller could PATCH a skill owned by agent-A
 *   via URL `/api/agents/B/skills/<A's skill id>`. A mismatch resolves to
 *   "not found" — same response as a truly missing row, so we don't leak
 *   cross-agent existence.
 *
 * Deleting the parent agent cascades to skills via FK (`onDelete: 'cascade'`).
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  skillAgentParamSchema,
  skillCreateInputSchema,
  skillItemParamSchema,
  skillResponseSchema,
  skillUpdateInputSchema,
  type SkillResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type SkillRow = typeof schema.skills.$inferSelect

function toSkillResponse(row: SkillRow): SkillResponse {
  return skillResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    markdownBody: row.markdownBody,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

async function agentExists(agentId: string): Promise<boolean> {
  const { db } = getDb()
  const [row] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return Boolean(row)
}

export const skillsRouter = new Hono()
  // ─── POST /api/agents/:agentId/skills ────────────────────────────────────
  .post(
    '/',
    zValidator('param', skillAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', skillCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      if (!(await agentExists(agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      try {
        const [row] = await db
          .insert(schema.skills)
          .values({
            agentId,
            name: body.name,
            markdownBody: body.markdownBody ?? '',
            position: body.position ?? 0,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        return c.json(
          { ok: true as const, skill: toSkillResponse(row) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `skill name "${body.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/skills ─────────────────────────────────────
  .get(
    '/',
    zValidator('param', skillAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { db } = getDb()

      if (!(await agentExists(agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const rows = await db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.agentId, agentId))
        .orderBy(asc(schema.skills.position), asc(schema.skills.createdAt))

      return c.json({
        ok: true as const,
        skills: rows.map(toSkillResponse),
      })
    },
  )
  // ─── PATCH /api/agents/:agentId/skills/:id ───────────────────────────────
  .patch(
    '/:id',
    zValidator('param', skillItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', skillUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.skills.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('markdownBody' in body) patch.markdownBody = body.markdownBody
      if ('position' in body) patch.position = body.position

      try {
        // Double-filter on (id, agentId) enforces cross-agent isolation.
        const [row] = await db
          .update(schema.skills)
          .set(patch)
          .where(
            and(
              eq(schema.skills.id, id),
              eq(schema.skills.agentId, agentId),
            ),
          )
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `skill ${id} not found on agent ${agentId}`,
          })
        }

        return c.json({ ok: true as const, skill: toSkillResponse(row) })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `skill name "${patch.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:agentId/skills/:id ──────────────────────────────
  .delete(
    '/:id',
    zValidator('param', skillItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.skills)
        .where(
          and(
            eq(schema.skills.id, id),
            eq(schema.skills.agentId, agentId),
          ),
        )
        .returning({ id: schema.skills.id })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `skill ${id} not found on agent ${agentId}`,
        })
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type SkillsRouter = typeof skillsRouter
