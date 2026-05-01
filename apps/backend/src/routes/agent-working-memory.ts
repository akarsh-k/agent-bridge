/**
 * `GET /api/agents/:agentId/working-memory[?threadId=X]`
 *   → current state of the agent's working-memory scratchpad. Powers
 *     the read-only "Current scratchpad" panel on the Memory tab.
 *
 * `threadId` is required when the agent's working-memory scope is
 * 'thread' (each thread has its own scratchpad). For 'resource'
 * scope the param is ignored.
 *
 * Read-only. The viewer pass doesn't expose write/reset endpoints —
 * those go through Mastra's updateWorkingMemory API and are out of
 * scope for v1.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  agentRunsAgentIdParamSchema,
  type WorkingMemoryResponse,
} from '@agent-bridge/shared'
import { getCurrentWorkingMemory } from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

const querySchema = z
  .object({
    threadId: z.string().min(1).optional(),
  })
  .strict()

export const agentWorkingMemoryRouter = new Hono().get(
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
    const { threadId } = c.req.valid('query')
    const handle = getDb()
    try {
      const result = await getCurrentWorkingMemory(handle, agentId, threadId)
      const body: WorkingMemoryResponse = { ok: true, ...result }
      return c.json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'read failed'
      if (message.includes('not found')) {
        return httpError(c, { code: 'not_found', message })
      }
      throw err
    }
  },
)

export type AgentWorkingMemoryRouter = typeof agentWorkingMemoryRouter
