/**
 * `GET /api/agents/:agentId/config-events`
 *   → newest-first list of persisted `agent.config.changed` events
 *     for one agent. Powers the unified Activity timeline so audit
 *     entries (skill added, repo attached, MCP allowlist replaced …)
 *     survive page reloads and SSE re-subscribes.
 *
 * Append-only on the producer side (`publishAgentConfig`); this route
 * is read-only. Agent existence is checked first so deleted agents
 * 404 cleanly instead of returning the empty list.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  agentRunsAgentIdParamSchema,
  type AgentConfigEventListResponse,
  type AgentConfigEventResponse,
  type AgentConfigAction,
  type AgentConfigResource,
} from '@agent-bridge/shared'
import { agentConfigEventsRepo, schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict()

async function assertAgentExists(
  db: ReturnType<typeof getDb>,
  agentId: string,
): Promise<boolean> {
  const [row] = await db.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return !!row
}

export const agentConfigEventsRouter = new Hono().get(
  '/',
  zValidator('param', agentRunsAgentIdParamSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  zValidator('query', querySchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const { agentId } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    const db = getDb()
    if (!(await assertAgentExists(db, agentId))) {
      return httpError(c, {
        code: 'not_found',
        message: `agent ${agentId} not found`,
      })
    }
    const rows = await agentConfigEventsRepo.listConfigEvents(db, {
      agentId,
      ...(limit !== undefined ? { limit } : {}),
    })
    const events: AgentConfigEventResponse[] = rows.map((r) => ({
      id: String(r.id),
      agentId: r.agentId,
      ts: r.ts.toISOString(),
      // The DB stores plain strings — narrow back into the typed enum
      // so the response shape matches the DTO without a runtime
      // re-validation pass. Bad data here would only happen if a
      // future producer wrote an unknown value, which the producer's
      // own typed input prevents.
      action: r.action as AgentConfigAction,
      resource: r.resource as AgentConfigResource,
      label: r.label,
      detail: r.detail,
    }))
    return c.json<AgentConfigEventListResponse>({ ok: true, events })
  },
)

export type AgentConfigEventsRouter = typeof agentConfigEventsRouter
