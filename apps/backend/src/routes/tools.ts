/**
 * `/api/agents/:agentId/tools` — nested CRUD for agent-native tools.
 *
 * Agent-scoping invariant: same as skills. Per-item queries filter by BOTH
 * `agentId` AND `id`. A mismatch → 404 (don't leak cross-agent existence).
 *
 * `kind` is immutable post-creation (update DTO omits it). Deleting the
 * parent agent cascades via FK.
 *
 * `configJson` is NOT narrowed by `kind` at this layer — shape validation
 * at execution time lives in `packages/agents`. Here we only
 * enforce the byte-size cap so a rogue caller can't write an enormous blob.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  toolAgentParamSchema,
  toolCreateInputSchema,
  toolItemParamSchema,
  toolResponseSchema,
  toolUpdateInputSchema,
  type ToolResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type ToolRow = typeof schema.tools.$inferSelect

function toToolResponse(row: ToolRow): ToolResponse {
  return toolResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    configJson: row.configJson,
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

export const toolsRouter = new Hono()
  // ─── POST /api/agents/:agentId/tools ─────────────────────────────────────
  .post(
    '/',
    zValidator('param', toolAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', toolCreateInputSchema, (result, c) => {
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
          .insert(schema.tools)
          .values({
            agentId,
            kind: body.kind,
            name: body.name,
            description: body.description ?? null,
            configJson: body.configJson ?? {},
            position: body.position ?? 0,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        publishAgentConfig({
          agentId,
          action: 'added',
          resource: 'tool',
          label: row.name,
          detail: `kind=${row.kind}`,
        })
        return c.json(
          { ok: true as const, tool: toToolResponse(row) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `tool name "${body.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/tools ──────────────────────────────────────
  .get(
    '/',
    zValidator('param', toolAgentParamSchema, (result, c) => {
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
        .from(schema.tools)
        .where(eq(schema.tools.agentId, agentId))
        .orderBy(asc(schema.tools.position), asc(schema.tools.createdAt))

      return c.json({ ok: true as const, tools: rows.map(toToolResponse) })
    },
  )
  // ─── PATCH /api/agents/:agentId/tools/:id ────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', toolItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', toolUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.tools.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description ?? null
      if ('configJson' in body) patch.configJson = body.configJson
      if ('position' in body) patch.position = body.position

      try {
        const [row] = await db
          .update(schema.tools)
          .set(patch)
          .where(
            and(
              eq(schema.tools.id, id),
              eq(schema.tools.agentId, agentId),
            ),
          )
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `tool ${id} not found on agent ${agentId}`,
          })
        }

        publishAgentConfig({
          agentId,
          action: 'updated',
          resource: 'tool',
          label: row.name,
        })
        return c.json({ ok: true as const, tool: toToolResponse(row) })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `tool name "${patch.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:agentId/tools/:id ───────────────────────────────
  .delete(
    '/:id',
    zValidator('param', toolItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.tools)
        .where(
          and(
            eq(schema.tools.id, id),
            eq(schema.tools.agentId, agentId),
          ),
        )
        .returning({ id: schema.tools.id, name: schema.tools.name })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `tool ${id} not found on agent ${agentId}`,
        })
      }

      publishAgentConfig({
        agentId,
        action: 'removed',
        resource: 'tool',
        label: row.name,
      })
      return c.json({ ok: true as const, id: row.id })
    },
  )

export type ToolsRouter = typeof toolsRouter
