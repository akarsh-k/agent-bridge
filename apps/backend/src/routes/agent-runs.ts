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
  formatCallsiteBlock,
  runStreamId,
  type Callsite,
} from '@agent-bridge/shared'
import { runsRepo, schema } from '@agent-bridge/db'
import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import {
  agentStreamId,
  KNOWLEDGE_PREVIEW_BYTES_CAP,
  wrapPromptEnrichment,
  type KnowledgePrefetchCalledPayload,
  type KnowledgePrefetchResultPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { dispatchRun, eagerPrefetchKnowledge } from '@agent-bridge/agents'

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

    // Synthesise a `web-chat` callsite so chat-tab runs carry the same
    // wire shape as IDE-bridge runs. Persisted on the row + prepended
    // to the prompt right here so `runs.input_prompt` matches what the
    // LLM saw. Lets operator skills branch on `client.name`.
    const callsite: Callsite = {
      client: { name: 'web-chat' },
      agent: { slug: agent.slug, name: agent.name },
      tool: { name: 'chat' },
      started_at: new Date().toISOString(),
    }

    // Knowledge-file prompt enrichment (Phase 2 polish):
    //   - synthetic system note when files appeared mid-thread
    //   - eager pre-fetch when the user @-mentions exactly one file
    //     in a short message
    // Both happen BEFORE we persist `runs.input_prompt` so the
    // captured row matches what the LLM actually saw.
    const enrichments = await buildPromptEnrichments({
      db,
      threadId: body.threadId,
      agentId,
      userPrompt: body.prompt,
      referencedFileIds: body.referencedFileIds ?? [],
      runId,
      streamId,
    })
    const prompt =
      formatCallsiteBlock(callsite) + enrichments.preamble + body.prompt

    const run = await runsRepo.createRun(db, {
      id: runId,
      agentId,
      inputPrompt: prompt,
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
      prompt,
      ...(body.threadId ? { threadId: body.threadId } : {}),
      ...(body.resourceId ? { resourceId: body.resourceId } : {}),
      ...(body.referencedFileIds && body.referencedFileIds.length > 0
        ? { referencedFileIds: body.referencedFileIds }
        : {}),
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

// ─── Prompt enrichment for knowledge files ───────────────────────────────

/**
 * If new thread files appeared since this thread's last finished
 * run, build a one-turn synthetic system note announcing them. AND
 * for short single-@-mention messages, eagerly pre-fetch top-3
 * chunks for that file and prepend them as context — saves the LLM
 * a `search_knowledge` round-trip on the obvious one-shot path.
 *
 * Returns a `preamble` string (possibly empty) that the caller
 * prepends to the user prompt before persisting + dispatching.
 */
async function buildPromptEnrichments(args: {
  db: ReturnType<typeof getDb>
  threadId: string | undefined
  agentId: string
  userPrompt: string
  referencedFileIds: ReadonlyArray<string>
  /** Generated upstream of this call. Used to tag SSE frames so the
   *  Activity panel correlates the pre-fetch with the run that owns it. */
  runId: string
  streamId: string
}): Promise<{ preamble: string }> {
  const {
    db,
    threadId,
    userPrompt,
    referencedFileIds,
    agentId,
    runId,
    streamId,
  } = args
  const sections: string[] = []

  // ── Synthetic system note for newly-attached thread files ─────────
  if (threadId) {
    const newFiles = await loadNewlyAttachedThreadFiles(db, threadId)
    if (newFiles.length > 0) {
      const lines = newFiles.map((f) => {
        const desc = f.description.trim()
        return desc
          ? `- \`${f.name}\`: ${desc}`
          : `- \`${f.name}\` (no description yet)`
      })
      sections.push(
        wrapPromptEnrichment(
          'attached-files',
          [
            '_The user just attached the following file(s) to this conversation:_',
            ...lines,
            '_Search via `search_knowledge` if a request mentions them; ' +
              'the system already knows their ids._',
          ].join('\n'),
        ),
      )
    }
  }

  // ── Synthetic system note for connections re-authenticated this thread ──
  // After a dead external-MCP connection is reconnected, the model otherwise
  // keeps reading the stale "needs re-authorization" tool message left in the
  // conversation history and answers "not authenticated" without retrying. A
  // factual status note (no action requested, the user drives what happens
  // next) lets it use the tools when the next message calls for them. Persists
  // until the connection is re-flagged.
  if (threadId) {
    const reconnected = await runsRepo.getThreadReconnectedConnections(
      db,
      threadId,
    )
    if (reconnected.length > 0) {
      const names = reconnected
        .map((c) => `\`${c.connectionName}\``)
        .join(', ')
      sections.push(
        wrapPromptEnrichment(
          'mcp-reconnected',
          reconnected.length === 1
            ? `_The ${names} connection was re-authenticated and is available ` +
                `again. Any earlier message that it needs re-authorization is ` +
                `now out of date._`
            : `_These connections were re-authenticated and are available ` +
                `again: ${names}. Any earlier message that they need ` +
                `re-authorization is now out of date._`,
        ),
      )
    }
  }

  // ── Eager pre-fetch for short single-@-mention prompts ────────────
  // Heuristic: short user text (≤120 chars after trim) AND exactly
  // one @-mention. Skip when the message ends in a question word —
  // the LLM should research multi-step rather than reusing a
  // pre-baked snippet.
  const isShort = userPrompt.trim().length <= 120
  const onlyOneMention = referencedFileIds.length === 1
  // Authorization: only pre-fetch from files attached to THIS agent
  // (agent_files) or to THIS thread (thread_files). Without this
  // check, an operator could `@`-mention any workspace file by id
  // and have its chunks land in the agent's prompt even though the
  // agent isn't supposed to read it — bypassing the same
  // authorization that `search_knowledge` enforces inside the tool.
  const fileId = onlyOneMention ? referencedFileIds[0]! : null
  const prefetchAuthorized =
    isShort && fileId
      ? await isFileAuthorizedForAgent({ db, agentId, threadId, fileId })
      : false
  if (isShort && onlyOneMention && prefetchAuthorized && fileId) {
    // Pre-fetch telemetry. The pre-fetch runs in the route handler
    // BEFORE the dispatcher's run loop starts, so the inspector run
    // context isn't active yet and we can't go through
    // `emitInspectorEvent`. Publish directly onto the per-run + per-
    // agent stream channels — the Activity panel (always subscribed
    // to `agent:<id>`) catches it even before the chat panel finishes
    // connecting to the per-run stream. No `run_events` audit row
    // because the `runs` row hasn't been created yet at this point
    // (the FK would fail); the prefetched chunks ARE captured in
    // `runs.input_prompt` so the durable record exists there.
    const bus = getEventBus()
    const queryPreview = clipQueryPreview(userPrompt)
    const startedAt = Date.now()
    const callPayload: KnowledgePrefetchCalledPayload = {
      runId,
      fileId,
      query: queryPreview.preview,
      queryTruncated: queryPreview.truncated,
      topK: 3,
    }
    await publishPrefetchEvent(bus, {
      kind: 'knowledge.prefetch.called',
      ts: startedAt,
      streamId,
      data: callPayload,
    }, agentId)
    const chunks = await eagerPrefetchKnowledge({
      db,
      fileId,
      query: userPrompt,
      topK: 3,
    })
    const resultPayload: KnowledgePrefetchResultPayload = {
      runId,
      fileId,
      durationMs: Date.now() - startedAt,
      chunkCount: chunks.length,
    }
    await publishPrefetchEvent(bus, {
      kind: 'knowledge.prefetch.result',
      ts: Date.now(),
      streamId,
      data: resultPayload,
    }, agentId)
    if (chunks.length > 0) {
      // Look up the file's display name for the heading. Defaults to
      // "this file" if the row vanished between mention and dispatch.
      const [fileRow] = await db.db
        .select({ name: schema.files.name })
        .from(schema.files)
        .where(eq(schema.files.id, fileId))
        .limit(1)
      const head = fileRow?.name ?? 'this file'
      const body = chunks
        .map((c, i) => {
          const cite =
            (c.page != null ? `p.${c.page}` : 'chunk') +
            (c.sectionPath ? ` · ${c.sectionPath}` : '')
          return `[${i + 1}] (${cite}) ${c.snippet}`
        })
        .join('\n\n')
      sections.push(
        wrapPromptEnrichment(
          'prefetch',
          [
            `_Pre-fetched top-${chunks.length} passages from \`${head}\` ` +
              'matching the user\'s message. Use these to ground your reply ' +
              'and cite by file name and page; call `search_knowledge` only ' +
              'if these are insufficient._',
            '',
            body,
          ].join('\n'),
        ),
      )
    }
  }

  // Each section is already self-fenced + trailing-blank-line padded
  // by `wrapPromptEnrichment`, so a plain concat is correct here. No
  // outer join — that would double the blank lines between sections.
  return { preamble: sections.join('') }
}

/**
 * Files attached to this thread whose `created_at` is later than the
 * last terminal `runs.finished_at` for the same thread. On the very
 * first turn (no prior runs), every thread file is "new". Only
 * surfaces `ingest_status='ready'` files — half-ingested ones aren't
 * useful for the LLM to know about yet.
 */
async function loadNewlyAttachedThreadFiles(
  handle: ReturnType<typeof getDb>,
  threadId: string,
): Promise<
  ReadonlyArray<{ id: string; name: string; description: string }>
> {
  const { db } = handle
  const [lastRun] = await db
    .select({ finishedAt: schema.runs.finishedAt })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.mastraThreadId, threadId),
        inArray(schema.runs.status, ['completed', 'error']),
      ),
    )
    .orderBy(desc(schema.runs.finishedAt))
    .limit(1)

  const baselineQuery = db
    .select({
      id: schema.files.id,
      name: schema.files.name,
      description: schema.files.description,
    })
    .from(schema.threadFiles)
    .innerJoin(schema.files, eq(schema.threadFiles.fileId, schema.files.id))

  const cutoff = lastRun?.finishedAt ?? null
  return await baselineQuery.where(
    cutoff
      ? and(
          eq(schema.threadFiles.threadId, threadId),
          eq(schema.files.ingestStatus, 'ready'),
          gt(schema.threadFiles.createdAt, cutoff),
        )
      : and(
          eq(schema.threadFiles.threadId, threadId),
          eq(schema.files.ingestStatus, 'ready'),
        ),
  )
}

// ─── Event helpers ───────────────────────────────────────────────────────

function clipQueryPreview(
  raw: string,
): { preview: string; truncated: boolean } {
  if (raw.length <= KNOWLEDGE_PREVIEW_BYTES_CAP)
    return { preview: raw, truncated: false }
  return {
    preview: raw.slice(0, KNOWLEDGE_PREVIEW_BYTES_CAP - 1) + '…',
    truncated: true,
  }
}

/**
 * Publish a prefetch event to both the per-run stream (so the chat
 * panel picks it up once it subscribes) AND the per-agent fan-out
 * stream (so the Activity panel sees it live). Failures are swallowed
 * — telemetry never blocks a run from starting.
 */
async function publishPrefetchEvent(
  bus: ReturnType<typeof getEventBus>,
  event: RunEvent,
  agentId: string,
): Promise<void> {
  try {
    await bus.publish(event)
    await bus.publish({ ...event, streamId: agentStreamId(agentId) })
  } catch (err) {
    console.warn(
      `[agent-runs] prefetch event publish failed (${event.kind}):`,
      err,
    )
  }
}

/**
 * Is this file visible to the agent for the current turn?
 *
 * The two authorization sources are:
 *   - `agent_files` — permanent attachments selected from the
 *     Resources panel.
 *   - `thread_files` — per-thread chat-drop attachments scoped to
 *     this conversation.
 *
 * Returns true if the file appears in either set. Mirrors the
 * `authorized = agent_files ∪ thread_files` rule the `search_knowledge`
 * tool enforces at call time. Without this check, an operator could
 * `@`-mention any workspace file by id and the eager pre-fetch would
 * happily inject its chunks into the prompt regardless of whether the
 * agent is supposed to read it.
 *
 * threadId may be undefined (chat-tab without a thread yet); in that
 * case we only check agent_files.
 */
async function isFileAuthorizedForAgent(args: {
  db: ReturnType<typeof getDb>
  agentId: string
  threadId: string | undefined
  fileId: string
}): Promise<boolean> {
  const { db, agentId, threadId, fileId } = args
  const [attached] = await db.db
    .select({ fileId: schema.agentFiles.fileId })
    .from(schema.agentFiles)
    .where(
      and(
        eq(schema.agentFiles.agentId, agentId),
        eq(schema.agentFiles.fileId, fileId),
      ),
    )
    .limit(1)
  if (attached) return true
  if (!threadId) return false
  const [dropped] = await db.db
    .select({ fileId: schema.threadFiles.fileId })
    .from(schema.threadFiles)
    .where(
      and(
        eq(schema.threadFiles.threadId, threadId),
        eq(schema.threadFiles.fileId, fileId),
      ),
    )
    .limit(1)
  return Boolean(dropped)
}
