/**
 * `GET    /api/agents/:agentId/threads`
 *   → list past chat threads for the agent.
 *
 * `GET    /api/agents/:agentId/threads/:threadId/messages`
 *   → replay messages for a thread.
 *
 * `DELETE /api/agents/:agentId/threads/:threadId`
 *   → remove a thread.
 *
 * All three wrap Mastra's `mastra.threads` + `mastra.messages` storage
 * via helpers in `@agent-bridge/agents/threads`. The agent existence
 * check guards orphan thread queries — the runs route does the same
 * preflight.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  agentRunsAgentIdParamSchema,
  agentThreadParamSchema,
} from '@agent-bridge/shared'
import { runsRepo, schema } from '@agent-bridge/db'
import {
  deleteAgentThread,
  getAgentThreadMessages,
  listAgentThreads,
} from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

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

export const agentThreadsRouter = new Hono()
  .get(
    '/',
    zValidator('param', agentRunsAgentIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const db = getDb()
      if (!(await assertAgentExists(db, agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }
      const summaries = await listAgentThreads(db, agentId)
      return c.json({
        ok: true as const,
        threads: summaries.map((t) => ({
          threadId: t.threadId,
          title: t.title,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
          messageCount: t.messageCount,
        })),
      })
    },
  )
  .get(
    '/:threadId/messages',
    zValidator('param', agentThreadParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, threadId } = c.req.valid('param')
      const db = getDb()
      if (!(await assertAgentExists(db, agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }
      const messages = await getAgentThreadMessages(db, threadId)
      return c.json({
        ok: true as const,
        threadId,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          createdAt: m.createdAt.toISOString(),
        })),
      })
    },
  )
  .get(
    '/:threadId/active-run',
    zValidator('param', agentThreadParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, threadId } = c.req.valid('param')
      const db = getDb()
      if (!(await assertAgentExists(db, agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }
      // Returns the most recent pending/running run for this thread,
      // or null if every run for it has already finished. The chat
      // tab uses this on mount to recover from a route change that
      // unmounted the previous SSE subscription.
      const active = await runsRepo.findActiveForThread(db, agentId, threadId)
      return c.json({ ok: true as const, run: active })
    },
  )
  .delete(
    '/:threadId',
    zValidator('param', agentThreadParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, threadId } = c.req.valid('param')
      const db = getDb()
      if (!(await assertAgentExists(db, agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }
      await deleteAgentThread(db, threadId)
      return c.json({ ok: true as const })
    },
  )

export type AgentThreadsRouter = typeof agentThreadsRouter
