/**
 * `GET /api/agents/:agentId/token-estimate`
 *   → structured token breakdown of the per-call payload buildAgent
 *     would ship for this agent. Powers the Context budget card on
 *     the Configure tab.
 *
 * Read-only. Cheap to call (no subprocesses, no LLM calls). Safe to
 * fetch on Configure-tab open + after edits.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import {
  agentRunsAgentIdParamSchema,
  type TokenEstimateResponse,
} from '@agent-bridge/shared'
import { estimateAgentTokens } from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

export const agentTokenEstimateRouter = new Hono().get(
  '/',
  zValidator('param', agentRunsAgentIdParamSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const { agentId } = c.req.valid('param')
    const handle = getDb()
    try {
      const estimate = await estimateAgentTokens(handle, agentId)
      const body: TokenEstimateResponse = {
        ok: true,
        // Strip the readonly modifiers — the DTO uses Zod-inferred
        // mutable arrays, the helper returns readonly. Same data.
        estimate: {
          ...estimate,
          parts: {
            ...estimate.parts,
            skills: [...estimate.parts.skills],
            tools: [...estimate.parts.tools],
            files: [...estimate.parts.files],
          },
        },
      }
      return c.json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'estimate failed'
      // estimateAgentTokens throws "agent not found" for unknown ids;
      // surface that as 404. Anything else is a 500.
      if (message.includes('not found')) {
        return httpError(c, { code: 'not_found', message })
      }
      throw err
    }
  },
)

export type AgentTokenEstimateRouter = typeof agentTokenEstimateRouter
