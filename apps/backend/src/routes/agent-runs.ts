/**
 * `POST /api/agents/:agentId/runs` — start an agent run.
 *
 * Contract:
 *   202 { ok: true, runId, streamId: 'run:<uuid>' }
 *     → row inserted as `status='pending'`. The dispatcher flips it
 *       to `running` before the first chunk, publishes the
 *       `run.started` SSE frame, and then streams tokens / tool
 *       events on `/api/events/<streamId>`.
 *   400 — validation failure (empty prompt, too long, bad threadId).
 *   404 — agent not found.
 *   409 — agent has no `llm_provider_id` (can't build).
 *
 * Same 202-then-SSE pattern as the repo clone/index jobs in
 * `repo-jobs.ts`: the HTTP response only proves the run STARTED, not
 * that it finished. The run's terminal state (`completed` / `error`)
 * lives in the `runs` row + `run_events` audit log, and is surfaced
 * to the client via the SSE tail (never this HTTP response).
 *
 * Why nested under `/agents/:agentId/runs` instead of flat
 * `/agents/:id/run`? The collection path leaves room for
 * `GET /agents/:agentId/runs` (history) and
 * `GET /agents/:agentId/runs/:runId/events` (replay) to land without
 * re-routing clients. The plan's original sketch was flat; we picked
 * the nested shape in the 3d scoping question.
 *
 * Dispatcher fire-and-forget:
 *   We intentionally do NOT `await` the dispatcher inside the route
 *   handler. Mastra streams live in-process; blocking the request
 *   until `finish` would tie the browser's POST to the whole run
 *   duration. Browsers would also hit request timeouts on long runs.
 *   Instead the handler returns 202 with the streamId and the browser
 *   opens the SSE tail, which reconnects cleanly if the tab closes.
 */

import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import {
  agentRunCreateInputSchema,
  agentRunsAgentIdParamSchema,
  runStreamId,
} from '@agent-bridge/shared'
import { runsRepo, schema } from '@agent-bridge/db'
import { eq } from 'drizzle-orm'
import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { dispatchRun } from '@agent-bridge/agents'

export const agentRunsRouter = new Hono().post(
  '/',
  zValidator('param', agentRunsAgentIdParamSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  zValidator('json', agentRunCreateInputSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const { agentId } = c.req.valid('param')
    const body = c.req.valid('json')
    const db = getDb()

    // Pre-flight: confirm agent exists AND has a provider so we can
    // return a focused 409 before creating an orphan `runs` row. The
    // dispatcher itself also validates this (via buildAgent) — this
    // early check is for UX: the HTTP POST returns before the row
    // lands, so the UI doesn't flash a failed run it has to clean up.
    const [agent] = await db.db
      .select({
        id: schema.agents.id,
        slug: schema.agents.slug,
        name: schema.agents.name,
        llmProviderId: schema.agents.llmProviderId,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1)

    if (!agent) {
      return httpError(c, {
        code: 'not_found',
        message: `agent ${agentId} not found`,
      })
    }

    if (!agent.llmProviderId) {
      return httpError(c, {
        code: 'conflict',
        message:
          `agent ${agentId} has no llm_provider configured — attach one ` +
          `before starting a run`,
      })
    }

    // Generate the run id in JS so we can pin the derived `streamId =
    // 'run:' + id` atomically in the INSERT (see `runsRepo.createRun`
    // for the rationale). The uniqueness argument is the same as for
    // `gen_random_uuid()`: `crypto.randomUUID()` uses the same v4
    // algorithm, and the probability of collision with any existing
    // row is negligible at our scale.
    const runId = randomUUID()
    const streamId = runStreamId(runId)

    // Synthesize a `web-chat` callsite for UI-originated runs. Persisted
    // on the row + injected as a `## Callsite` block in the dispatcher
    // so operator skills can vary behavior by source (web chat vs IDE).
    const callsite: import('@agent-bridge/shared').Callsite = {
      client: { name: 'web-chat' },
      agent: { slug: agent.slug, name: agent.name },
      tool: { name: 'chat' },
      started_at: new Date().toISOString(),
    }

    const run = await runsRepo.createRun(db, {
      id: runId,
      agentId,
      inputPrompt: body.prompt,
      streamId,
      callsite,
    })

    // Fire-and-forget. Dispatcher owns its own lifecycle + cleanup.
    void dispatchRun({
      db,
      eventBus: getEventBus(),
      agentId,
      runId: run.id,
      streamId,
      prompt: body.prompt,
      callsite,
      ...(body.threadId ? { threadId: body.threadId } : {}),
      ...(body.resourceId ? { resourceId: body.resourceId } : {}),
    }).catch((err) => {
      // dispatchRun has its own error path that writes to run_events;
      // this catch is only reached if BOTH the LLM call AND the audit
      // writer failed. Log loudly; don't attempt to recover.
      console.error(
        `[agent-runs] dispatchRun blew up after terminal audit failed for run ${run.id}:`,
        err,
      )
    })

    return c.json(
      {
        ok: true as const,
        runId: run.id,
        streamId,
      },
      202,
    )
  },
)

export type AgentRunsRouter = typeof agentRunsRouter
