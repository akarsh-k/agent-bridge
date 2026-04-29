/**
 * `/api/agents/:agentId/bridge-tools` — nested CRUD for the outbound
 * MCP tools an agent exposes to IDEs (Phase 7).
 *
 * Agent-scoping invariant (same rule as skills/tools/repos):
 *   Every per-item query filters by BOTH `agentId` (URL) AND `id` (URL).
 *   Mismatch → 404, identical to a truly missing row, so we don't leak
 *   cross-agent existence.
 *
 * Reserved-prefix defence-in-depth:
 *   1. UI rejects `query_*` client-side.
 *   2. `bridgeToolCreateInputSchema` / `bridgeToolUpdateInputSchema`
 *      reject the same prefix at the edge.
 *   3. DB CHECK constraint `bridge_tools_name_not_reserved` is the
 *      last line — surfaces as `23514`, mapped to a 409 here.
 *
 * Name uniqueness is global (MCP spec requires per-server uniqueness;
 * one bridge process = one MCP server). Duplicate name → 409.
 *
 * Cascading delete of the parent agent removes its bridge tools via
 * FK `onDelete: 'cascade'`.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  bridgeToolAgentParamSchema,
  bridgeToolCreateInputSchema,
  bridgeToolItemParamSchema,
  bridgeToolResponseSchema,
  bridgeToolUpdateInputSchema,
  type BridgeToolResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type BridgeToolRow = typeof schema.bridgeTools.$inferSelect

function toResponse(row: BridgeToolRow): BridgeToolResponse {
  return bridgeToolResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema,
    promptTemplate: row.promptTemplate,
    enabled: row.enabled,
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

/**
 * Map a `23514` (CHECK violation) to a friendlier message. The two
 * CHECK constraints on `bridge_tools` (`bridge_tools_name_not_reserved`
 * and `bridge_tools_name_format`) carry their own constraint names so
 * we can route each to a precise hint.
 */
function checkViolationToError(
  err: unknown,
): { code: 'conflict' | 'validation_failed'; message: string } | null {
  if (!isPostgresErrorWithCode(err, PG.CHECK_VIOLATION)) return null
  const cause = (err as { cause?: { constraint_name?: string } }).cause
  const constraint = cause?.constraint_name
  if (constraint === 'bridge_tools_name_not_reserved') {
    return {
      code: 'validation_failed',
      message: 'name "query_*" is reserved for the auto-derived default tool',
    }
  }
  if (constraint === 'bridge_tools_name_format') {
    return {
      code: 'validation_failed',
      message:
        'name must start with a letter and contain only letters, digits, and underscores (≤64 chars)',
    }
  }
  return null
}

export const bridgeToolsRouter = new Hono()
  // ─── POST /api/agents/:agentId/bridge-tools ──────────────────────────────
  .post(
    '/',
    zValidator('param', bridgeToolAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', bridgeToolCreateInputSchema, (result, c) => {
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
          .insert(schema.bridgeTools)
          .values({
            agentId,
            name: body.name,
            description: body.description ?? '',
            inputSchema: body.inputSchema ?? {},
            promptTemplate: body.promptTemplate ?? '',
            enabled: body.enabled ?? true,
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
          detail: 'bridge tool',
        })
        return c.json(
          { ok: true as const, bridgeTool: toResponse(row) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `bridge tool name "${body.name}" is already in use`,
          })
        }
        const checkErr = checkViolationToError(err)
        if (checkErr) return httpError(c, checkErr)
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/bridge-tools ───────────────────────────────
  .get(
    '/',
    zValidator('param', bridgeToolAgentParamSchema, (result, c) => {
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
        .from(schema.bridgeTools)
        .where(eq(schema.bridgeTools.agentId, agentId))
        .orderBy(asc(schema.bridgeTools.name), asc(schema.bridgeTools.createdAt))

      return c.json({
        ok: true as const,
        bridgeTools: rows.map(toResponse),
      })
    },
  )
  // ─── PATCH /api/agents/:agentId/bridge-tools/:id ─────────────────────────
  .patch(
    '/:id',
    zValidator('param', bridgeToolItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', bridgeToolUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.bridgeTools.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description
      if ('inputSchema' in body) patch.inputSchema = body.inputSchema
      if ('promptTemplate' in body) patch.promptTemplate = body.promptTemplate
      if ('enabled' in body) patch.enabled = body.enabled

      try {
        // Double-filter on (id, agentId) — the agent-scoping invariant.
        const [row] = await db
          .update(schema.bridgeTools)
          .set(patch)
          .where(
            and(
              eq(schema.bridgeTools.id, id),
              eq(schema.bridgeTools.agentId, agentId),
            ),
          )
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `bridge tool ${id} not found on agent ${agentId}`,
          })
        }

        publishAgentConfig({
          agentId,
          action: 'updated',
          resource: 'tool',
          label: row.name,
          detail: 'bridge tool',
        })
        return c.json({ ok: true as const, bridgeTool: toResponse(row) })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `bridge tool name "${patch.name}" is already in use`,
          })
        }
        const checkErr = checkViolationToError(err)
        if (checkErr) return httpError(c, checkErr)
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:agentId/bridge-tools/:id ────────────────────────
  .delete(
    '/:id',
    zValidator('param', bridgeToolItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.bridgeTools)
        .where(
          and(
            eq(schema.bridgeTools.id, id),
            eq(schema.bridgeTools.agentId, agentId),
          ),
        )
        .returning({
          id: schema.bridgeTools.id,
          name: schema.bridgeTools.name,
        })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `bridge tool ${id} not found on agent ${agentId}`,
        })
      }

      publishAgentConfig({
        agentId,
        action: 'removed',
        resource: 'tool',
        label: row.name,
        detail: 'bridge tool',
      })
      return c.json({ ok: true as const, id: row.id })
    },
  )

export type BridgeToolsRouter = typeof bridgeToolsRouter
