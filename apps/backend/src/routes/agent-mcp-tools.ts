/**
 * `/api/agents/:agentId/mcp-tools` — per-agent MCP tool allowlist.
 *
 * Only mutating verb is `PUT`: full set-replace. No granular POST/PATCH/DELETE
 * per tool. Rationale (also in `PLAN.md` §1C.3):
 *
 *   - Matches the schema invariant: "Users must explicitly opt in —
 *     never 'everything on by default'." A single write is the simplest
 *     way to keep the UI + server in lockstep.
 *   - Transactional replace (DELETE + INSERTs) avoids the race where a
 *     granular PATCH leaves the agent half-configured.
 *
 * Cascade behaviour:
 *   - Deleting an agent cascades to its allowlist via FK.
 *   - Deleting an mcp_connections row cascades to all allowlist entries
 *     for that connection across all agents, again via FK.
 */

import { zValidator } from '@hono/zod-validator'
import { asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  agentMcpToolsAgentParamSchema,
  allowlistEntryResponseSchema,
  setAllowlistInputSchema,
  type AllowlistEntryResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'

async function loadAgent(agentId: string) {
  const { db } = getDb()
  const [row] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return row
}

export const agentMcpToolsRouter = new Hono()
  // ─── GET /api/agents/:agentId/mcp-tools ──────────────────────────────────
  .get(
    '/',
    zValidator('param', agentMcpToolsAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { db } = getDb()

      // Parity with PUT: an allowlist for a non-existent agent is not
      // "an empty allowlist", it's 404. Otherwise the API would be a
      // side-channel leak for agent-id existence via timing/shape diffs.
      const agent = await loadAgent(agentId)
      if (!agent) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const rows = await db
        .select({
          mcpConnectionId: schema.agentMcpTools.mcpConnectionId,
          mcpConnectionName: schema.mcpConnections.name,
          toolName: schema.agentMcpTools.toolName,
          enabled: schema.agentMcpTools.enabled,
          createdAt: schema.agentMcpTools.createdAt,
        })
        .from(schema.agentMcpTools)
        .innerJoin(
          schema.mcpConnections,
          eq(schema.agentMcpTools.mcpConnectionId, schema.mcpConnections.id),
        )
        .where(eq(schema.agentMcpTools.agentId, agentId))
        .orderBy(
          asc(schema.mcpConnections.name),
          asc(schema.agentMcpTools.toolName),
        )

      const tools: AllowlistEntryResponse[] = rows.map((r) =>
        allowlistEntryResponseSchema.parse({
          mcpConnectionId: r.mcpConnectionId,
          mcpConnectionName: r.mcpConnectionName,
          toolName: r.toolName,
          enabled: r.enabled,
          createdAt: r.createdAt.toISOString(),
        }),
      )

      // No publish on GET — read-only.
      return c.json({ ok: true as const, tools })
    },
  )
  // ─── PUT /api/agents/:agentId/mcp-tools (set-replace) ────────────────────
  .put(
    '/',
    zValidator('param', agentMcpToolsAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', setAllowlistInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const agent = await loadAgent(agentId)
      if (!agent) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      // Pre-check connection existence (not a DB constraint on the
      // payload shape, but a nicer error than a raw FK violation).
      const connectionIds = Array.from(
        new Set(body.tools.map((t) => t.mcpConnectionId)),
      )

      if (connectionIds.length > 0) {
        const existing = await db
          .select({ id: schema.mcpConnections.id })
          .from(schema.mcpConnections)
          .where(inArray(schema.mcpConnections.id, connectionIds))

        const existingSet = new Set(existing.map((r) => r.id))
        const missing = connectionIds.filter((id) => !existingSet.has(id))
        if (missing.length > 0) {
          return httpError(c, {
            code: 'conflict',
            message: `unknown mcpConnectionId(s): ${missing.join(', ')}`,
          })
        }
      }

      // Transactional set-replace. A single DELETE + multi-row INSERT
      // inside one txn gives us atomic swap semantics — never observable
      // as a partial allowlist.
      await db.transaction(async (tx) => {
        await tx
          .delete(schema.agentMcpTools)
          .where(eq(schema.agentMcpTools.agentId, agentId))

        if (body.tools.length > 0) {
          await tx.insert(schema.agentMcpTools).values(
            body.tools.map((t) => ({
              agentId,
              mcpConnectionId: t.mcpConnectionId,
              toolName: t.toolName,
              enabled: t.enabled ?? true,
            })),
          )
        }
      })

      // Return the fresh state. A second SELECT is cheap and avoids the
      // trap of trying to synthesise `created_at` from the insert input.
      const rows = await db
        .select({
          mcpConnectionId: schema.agentMcpTools.mcpConnectionId,
          mcpConnectionName: schema.mcpConnections.name,
          toolName: schema.agentMcpTools.toolName,
          enabled: schema.agentMcpTools.enabled,
          createdAt: schema.agentMcpTools.createdAt,
        })
        .from(schema.agentMcpTools)
        .innerJoin(
          schema.mcpConnections,
          eq(schema.agentMcpTools.mcpConnectionId, schema.mcpConnections.id),
        )
        .where(eq(schema.agentMcpTools.agentId, agentId))
        .orderBy(
          asc(schema.mcpConnections.name),
          asc(schema.agentMcpTools.toolName),
        )

      const tools: AllowlistEntryResponse[] = rows.map((r) =>
        allowlistEntryResponseSchema.parse({
          mcpConnectionId: r.mcpConnectionId,
          mcpConnectionName: r.mcpConnectionName,
          toolName: r.toolName,
          enabled: r.enabled,
          createdAt: r.createdAt.toISOString(),
        }),
      )

      publishAgentConfig({
        agentId,
        action: 'replaced',
        resource: 'mcp_allowlist',
        label: `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
      })
      return c.json({ ok: true as const, tools })
    },
  )

export type AgentMcpToolsRouter = typeof agentMcpToolsRouter
