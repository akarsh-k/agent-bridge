/**
 * Runs one agent invocation end-to-end:
 *
 *   1. `buildAgent(...)`               — constructs the Mastra Agent,
 *                                        spawning a per-run
 *                                        `gitnexus mcp` subprocess if
 *                                        the agent has indexed repos.
 *   2. `markRunning` + `run.started`   — flips the `runs` row, emits
 *                                        the SSE `run.started` frame,
 *                                        and records the same shape in
 *                                        `run_events` for audit.
 *   3. Iterates `agent.stream(...).fullStream` — maps Mastra's chunk
 *                                        taxonomy onto our own
 *                                        `run.*` event kinds.
 *                                        See the `mapChunk` switch
 *                                        below for the 1:1 table.
 *   4. `run.token` frames fan out LIVE over SSE every chunk, AND get
 *      accumulated into a 200 ms batch buffer. Each flush produces ONE
 *      `run.token.batch` row in `run_events` + one SSE frame for
 *      late-joining subscribers (they can dedupe against the live
 *      frames by `index`).
 *   5. On `finish`:  `markCompleted(outputSummary=<truncated text>)`.
 *   6. On `error`    (either a Mastra `error` chunk or a thrown
 *      exception during iteration):  `markError(errorMessage=<redacted>)`.
 *   7. `finally`     — `built.disconnect()` (idempotent) + flush the
 *                      last token batch.
 *
 * Lifecycle rules:
 *   - Exactly one of `markCompleted` / `markError` runs per call.
 *   - `built.disconnect()` runs even if the dispatch throws; the
 *     built-agent helper itself is idempotent.
 *   - The dispatcher is fire-and-forget from the HTTP handler's
 *     perspective — it logs its own failures but NEVER re-throws.
 *     The POST route has already returned 202 by the time we start.
 *
 * Secrets handling:
 *   - `BuiltAgent.secrets` lists every decrypted plaintext the agent
 *     construction produced (LLM apiKey + MCP credentials). We bind them
 *     into a `RunRedactor` the moment the
 *     agent is built, then route EVERY outgoing event, every
 *     `run_events` row, and every terminal string (`runs.error_message`
 *     / `runs.output_summary`) through it. Scrubbing happens at the
 *     publish boundary — the security rule explicitly calls that out
 *     as "last line of defence" even if upstream code already avoided
 *     leaking.
 *   - If `buildAgent` itself throws, no plaintext was ever formed (the
 *     provider row's apiKey stays ciphertext on the DB-error path; the
 *     in-memory decrypted value is already gone by the time we reach
 *     the outer `catch`). The fallback redactor is a no-op in that
 *     case — no secret exists to leak.
 *
 * Things this phase deliberately does NOT do:
 *   - Run aborts (`POST /runs/:runId/abort`) → follow-up.
 *   - Sharing a built agent across runs (cache by agentId) → perf
 *     follow-up. For now, each run = one subprocess = one teardown.
 *   - Persisting `memory.thread`/`memory.resource` to the `runs` row.
 *     The thread id is derived at dispatch time (default: runId)
 *     and lives only in memory.
 */

// This file moved from `apps/backend/src/lib/run-dispatcher.ts` to
// `packages/agents/` so the IDE-facing MCP bridge
// (`apps/mcp-bridge`) can dispatch runs without a cross-app import.
// Both backend route + bridge consume `dispatchRun` from
// `@agent-bridge/agents`. Behaviour unchanged from the prior location.

import type { BuiltAgent } from './build-agent.js'
import { builtAgentCache } from './built-agent-cache.js'
import {
  agentConfigEventsRepo,
  runsRepo,
  type AgentBridgeDb,
} from '@agent-bridge/db'
import {
  agentStreamId as buildAgentStreamId,
  type RunErrorPayload,
  type RunEvent,
  type RunEventKind,
  type RunFinishedPayload,
  type RunMcpLogPayload,
  type RunModelCalledPayload,
  type RunModelResultPayload,
  type RunStartedPayload,
  type RunStepFinishedPayload,
  type RunStepStartedPayload,
  type RunToolCalledPayload,
  type RunToolResultPayload,
  type RunTokenBatchPayload,
  type RunTokenPayload,
} from '@agent-bridge/shared'
import type { EventBus } from '@agent-bridge/shared/event-bus'
import { createRunRedactor, type RunRedactor } from './run-redactor.js'
import { runWithInspectorContext } from './inspector/run-context.js'

// ─── Tunables ────────────────────────────────────────────────────────────

/**
 * Token-batcher flush cadence. 200 ms is short enough that a browser
 * reconnecting mid-run gets a fresh batch within one UI frame, but
 * long enough that a typical run (8 s at ~80 tokens/s) produces ~40
 * `run_events` rows rather than ~640. Tune by measuring `run_events`
 * table growth.
 */
const TOKEN_BATCH_FLUSH_MS = 200

/**
 * Cap on the text stored in `runs.output_summary`. Enough for the UI
 * "last run" preview + grep-ability in the audit log; the full text
 * is still recoverable by replaying `run_events` token batches, so
 * truncating here is lossless at the system level.
 */
const OUTPUT_SUMMARY_MAX_CHARS = 16_000

// ─── Public entry point ────────────────────────────────────────────────

export interface DispatchRunInput {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  readonly agentId: string
  readonly runId: string
  readonly prompt: string
  /**
   * SSE stream id this run publishes onto. The HTTP route uses
   * `runStreamId(runId)` ('run:<runId>'); the MCP bridge uses
   * `bridgeStreamId(runId)` ('bridge:<runId>') so the UI's run tab can
   * filter by source-prefix without a schema column.
   *
   * Required so the dispatcher never invents a streamId that the
   * caller hasn't already persisted on `runs.stream_id` — the row's
   * column is the source of truth, the dispatcher just plumbs it into
   * `publishAndAudit`.
   */
  readonly streamId: string
  /** Defaults to `runId` if the agent has memory enabled. */
  readonly threadId?: string
  /** Defaults to `agent:<agentId>` if the agent has memory enabled. */
  readonly resourceId?: string
}

/**
 * Fire-and-forget: start the run, return a promise the HTTP layer
 * intentionally does not await. The returned promise resolves whether
 * the run completed or errored; it rejects only if the dispatcher
 * itself is unable to record the failure (e.g. DB is down).
 */
export async function dispatchRun(input: DispatchRunInput): Promise<void> {
  const { db, eventBus, agentId, runId, prompt, streamId } = input
  // Note: the dispatcher does NOT touch the prompt. Callers (bridge
  // handler, web-chat backend) prepend the `_Request origin: …_`
  // metadata line via `formatCallsiteBlock` from `@agent-bridge/shared`
  // and persist the enriched prompt to `runs.input_prompt` BEFORE
  // calling us. That way `runs.input_prompt` faithfully reflects what
  // the LLM actually saw, and the dispatcher stays a dumb transport.
  // Per-agent fan-out channel for the right-rail Activity panel. Every
  // event we publish onto the per-run `streamId` is mirrored here so
  // the operator sees one continuous timeline for the focused agent
  // across multiple runs (chat turns, IDE-bridge calls, …).
  const agentStreamId = buildAgentStreamId(agentId)
  const startedAt = Date.now()

  let built: BuiltAgent | null = null
  let batcher: TokenBatcher | null = null
  let unsubscribeMcpLogs: (() => void) | null = null
  // Start with a no-op redactor so any early failure before buildAgent
  // returns still flows through a well-defined code path. The real one
  // replaces it as soon as we have the decrypted plaintexts.
  let redactor: RunRedactor = createRunRedactor([])

  try {
    // Pull from the process-level cache instead of building fresh on
    // every turn. First call for this agent pays the spawn cost; every
    // subsequent run reuses the live MCP subprocesses (matches how
    // IDE-side MCP clients keep one subprocess alive for the whole
    // session). The cache compares a content hash of `updated_at`s
    // and rebuilds automatically when the agent or its resources
    // change. We do NOT call `disconnect()` in the finally block —
    // the cache owns the subprocess lifetime now.
    built = await builtAgentCache.getOrBuild({ db, agentId })
    redactor = createRunRedactor(built.secrets)

    // Wire MCP stderr BEFORE `markRunning` so the very first `tool-call`
    // the LLM emits already has its stderr tail flowing through the
    // redactor. We also want the subscriber bound before ANY external
    // MCP tool fires — otherwise the operator's `NOTION_TOKEN=...`
    // banner could be printed to a subscriber-less broker and dropped
    // in the best case, or (worse) held in an unredacted buffer.
    unsubscribeMcpLogs = built.subscribeMcpLogs((log) => {
      // Fire-and-forget: the broker invokes us synchronously per line
      // but `publishAndAudit` is async. We swallow errors inside
      // `publishAndAudit` already (audit insert failure is logged,
      // publish errors would bubble) so re-throwing here would only
      // surface as an unhandled rejection — caught by the
      // `.catch(...)` below.
      const event: RunEvent = {
        kind: 'run.mcp.log',
        ts: Date.now(),
        streamId,
        data: {
          runId,
          connectionId: log.connectionId,
          connectionName: log.connectionName,
          level: log.level,
          line: log.line,
        } satisfies RunMcpLogPayload,
      }
      publishAndAudit(
        db,
        eventBus,
        redactor,
        streamId,
        agentStreamId,
        runId,
        event,
      ).catch((err) => {
        console.error(
          `[run-dispatcher] mcp.log publish failed for run ${runId}:`,
          err,
        )
      })
    })

    // Resolve Mastra thread + resource ids up front. For memory-enabled
    // agents we persist them onto the `runs` row BEFORE flipping
    // status to `running` so replay / history joins always see the
    // link — even if the dispatcher dies mid-stream. For memory-
    // disabled agents Mastra never writes a thread, so the columns
    // stay NULL and the SSE `run.started` payload reports `null`
    // so the UI can hide the "thread pill".
    const memoryIds = resolveMemoryIds(built, input)
    if (memoryIds) {
      const linked = await runsRepo.setMastraThread(db, runId, memoryIds)
      if (!linked) {
        // Row vanished between createRun and here (cascaded delete of
        // the agent?). Treat as a hard failure so we don't silently
        // run an orphaned row.
        throw new Error(
          `run ${runId}: setMastraThread found no 'pending'/'running' row to update`,
        )
      }
      // Detect "this is a brand-new thread" by checking whether a row
      // already exists in mastra.mastra_threads for this id. Mastra
      // creates the row lazily during the agent's first generation
      // call, so on a never-before-seen threadId the SELECT returns
      // 0 rows. Fire a config event in that case so the unified
      // Activity timeline shows "thread created" alongside runs +
      // config edits. Best-effort — failure here doesn't block the run.
      try {
        const isNew = await isNewMastraThread(db, memoryIds.mastraThreadId)
        if (isNew) {
          await publishThreadCreated({
            db,
            eventBus,
            agentId,
            agentStreamId,
            threadId: memoryIds.mastraThreadId,
            source: streamId.startsWith('bridge:') ? 'IDE' : 'chat tab',
          })
        }
      } catch (err) {
        // Swallow — the diagnostic log is nice-to-have; we never want
        // it to fail a real run.
        console.warn(
          `[run-dispatcher] thread.created publish failed for run ${runId}:`,
          err,
        )
      }
    }

    const running = await runsRepo.markRunning(db, runId)
    if (!running) {
      // CAS lost: the row was already advanced by another call. This
      // should be impossible today (one dispatcher per run id) but we
      // fail loudly if our assumptions are wrong — silently returning
      // would leak the subprocess.
      throw new Error(
        `run ${runId} was not in 'pending' state; dispatcher refuses to run`,
      )
    }

    const startedEvent: RunEvent = {
      kind: 'run.started',
      ts: Date.now(),
      streamId,
      data: {
        runId,
        agentId,
        agentName: built.meta.agentName,
        providerKind: built.meta.provider.kind,
        modelId: built.meta.provider.modelId,
        gitnexusMounted: built.meta.gitnexus.mounted,
        toolCount: built.meta.gitnexus.toolCount,
        mastraThreadId: memoryIds?.mastraThreadId ?? null,
        mastraResourceId: memoryIds?.mastraResourceId ?? null,
      } satisfies RunStartedPayload,
    }
    await publishAndAudit(
      db,
      eventBus,
      redactor,
      streamId,
      agentStreamId,
      runId,
      startedEvent,
    )

    batcher = new TokenBatcher({
      db,
      eventBus,
      redactor,
      runId,
      streamId,
      agentStreamId,
      flushIntervalMs: TOKEN_BATCH_FLUSH_MS,
    })
    batcher.start()

    // `maxSteps` caps how many model→tool→model loops Mastra runs before
    // terminating. Mastra's default is 5; that's too tight for an
    // inspector-enabled agent that may legitimately need 4-6 wrapper
    // calls before the synthesis turn (a 5-tool-call run hit the cap
    // before getting a chance to write its answer — 0 tokens emitted,
    // empty `output_summary`). 10 covers the typical case
    // (list_repos + 2-3 wrappers + synthesis = ~5) with headroom for
    // the multi-wrapper IDE queries; if a run regularly hits 10, the
    // model is over-searching and the prompt or tool routing needs
    // tightening rather than a bigger budget.
    const streamOptions = memoryIds
      ? {
          memory: {
            thread: memoryIds.mastraThreadId,
            resource: memoryIds.mastraResourceId,
          },
          maxSteps: 10,
        }
      : { maxSteps: 10 }

    // Mastra 1.28 returns `ReadableStream<ChunkType>` for
    // `.fullStream`. It implements async iteration natively.
    let accumulatedText = ''
    let stepCount = 0
    let finishReason: string | null = null
    let errorThrown: { message: string; kind: RunErrorPayload['kind'] } | null =
      null
    // No initializer here — `let X: T | undefined = undefined` narrows
    // out of the closure boundary in TS's CFA (the post-closure read
    // sees only `undefined`). Declaring without an initializer keeps
    // the declared union type intact. semantically identical.
    let lastUsage: RunFinishedPayload['usage'] | undefined

    // Per-dispatch state carried into `mapChunk`. Step + token indices
    // live here (not module globals) so concurrent dispatches don't share
    // counters and so a single chunk's index reflects the real position
    // within THIS run. `currentStepIndex` is bumped only on `step-start`;
    // `tool-call` / `tool-result` / `step-finish` reuse it so they
    // correctly attribute to the same step the model is executing.
    // `currentStepStartedAt` lets `run.model.result` compute the per-
    // step wall-clock duration without subscribers having to subtract
    // adjacent event timestamps.
    const mapState: MapChunkState = {
      currentStepIndex: -1,
      currentStepStartedAt: 0,
      tokenIndex: 0,
      pendingReasoning: '',
    }

    // Wrap the entire stream-iteration block in the inspector run
    // context (`docs/ARCHITECTURE.md §10`). Mastra's tool-execute
    // context exposes `agent.toolCallId` but not our app-level `runId`,
    // so wrapper tools read `{db, eventBus, redactor, runId, …}` from
    // AsyncLocalStorage instead. The dispatcher initiates the stream
    // AND drains it inside the same `run(...)` block — async hooks
    // propagate through `agent.stream`, the for-await loop, and any
    // tool executes Mastra dispatches under the hood.
    const builtAgent = built.agent
    const builtModelId = built.meta.provider.modelId
    const runBatcher = batcher
    await runWithInspectorContext(
      {
        db,
        eventBus,
        redactor,
        runId,
        streamId,
        agentStreamId,
        agentId,
      },
      async () => {
        const output = await builtAgent.stream(prompt, streamOptions)
        for await (const chunk of output.fullStream as AsyncIterable<unknown>) {
      const mapped = mapChunk(chunk, runId, mapState)
      if (!mapped) continue

      if (mapped.kind === 'run.token') {
        const raw = mapped.data as RunTokenPayload
        // Scrub the token text once, up front. The scrubbed string
        // flows into BOTH the live SSE frame AND the accumulated
        // `outputSummary`; redacting here means a secret the LLM
        // echoed never makes it into any persisted column.
        const payload: RunTokenPayload = {
          ...raw,
          text: redactor.redactString(raw.text),
        }
        accumulatedText += payload.text
        const tokenEvent: RunEvent = {
          kind: 'run.token',
          ts: mapped.ts,
          streamId,
          data: payload,
        }
        // Live frame for the chat panel + mirror onto the agent
        // stream so the Activity panel sees the token cadence too.
        // No audit row — `run.token` is high-frequency; the batched
        // `run.token.batch` (via TokenBatcher → publishAndAudit) is
        // the durable history.
        await eventBus.publish(tokenEvent)
        await eventBus.publish({ ...tokenEvent, streamId: agentStreamId })
        runBatcher.push(payload)
        continue
      }

      if (mapped.kind === 'run.step.started') {
        stepCount += 1
      }

      if (mapped.kind === 'run.step.finished') {
        const payload = mapped.data as RunStepFinishedPayload
        if (payload.finishReason) finishReason = payload.finishReason
        if (payload.usage) lastUsage = payload.usage
      }

      if (mapped.kind === 'run.error') {
        // Capture only — `finalizeError` emits the single authoritative
        // `run.error` frame after the stream drains. Publishing here
        // too would double-persist the row. Scrub the message now so
        // `classifyMessage` (already run in `mapChunk`) can't be
        // retroactively tainted by a plaintext we're about to hand to
        // `finalizeError`.
        errorThrown = {
          message: redactor.redactString(
            (mapped.data as RunErrorPayload).message,
          ),
          kind: (mapped.data as RunErrorPayload).kind,
        }
        continue
      }

      // `run.finished` from Mastra's `finish` chunk is emitted only on
      // a clean exit; we derive our own `run.finished` at the end
      // (below) so the payload reflects accumulated state. Swallow
      // Mastra's finish-chunk mapping to avoid double-emitting.
      if (mapped.kind === 'run.finished') {
        // Capture final finishReason/usage if not already set via
        // `step-finish`, then skip publishing.
        const payload = mapped.data as RunFinishedPayload
        if (payload.finishReason) finishReason = payload.finishReason
        if (payload.usage) lastUsage = payload.usage
        continue
      }

      await publishAndAudit(
        db,
        eventBus,
        redactor,
        streamId,
        agentStreamId,
        runId,
        {
          kind: mapped.kind,
          ts: mapped.ts,
          streamId,
          data: mapped.data,
        },
      )

      // Per-step LLM telemetry, emitted alongside the lightweight
      // `run.step.*` lifecycle events. Carries the FULL provider
      // request/response so an operator inspecting "what did the model
      // see, what did it decide?" answers it from the timeline without
      // having to enable provider-side tracing. Capture is a separate
      // concern from `mapChunk` (which handles lifecycle + tools) so
      // either path can evolve without breaking the other.
      const modelEvent = mapChunkToModelEvent(
        chunk,
        runId,
        mapState,
        builtModelId,
        mapped.ts,
      )
      if (modelEvent) {
        await publishAndAudit(
          db,
          eventBus,
          redactor,
          streamId,
          agentStreamId,
          runId,
          {
            kind: modelEvent.kind,
            ts: modelEvent.ts,
            streamId,
            data: modelEvent.data,
          },
        )
      }
        }
      },
    )

    // Drain the final token batch BEFORE publishing run.finished so a
    // subscriber reading events in order sees the last tokens first.
    await batcher.flushAndStop()
    batcher = null

    if (errorThrown) {
      await finalizeError(
        db,
        eventBus,
        redactor,
        streamId,
        agentStreamId,
        runId,
        errorThrown,
      )
      return
    }

    // `accumulatedText` is already scrubbed token-by-token; a second
    // pass is a cheap belt-and-braces against a future refactor that
    // forgets to redact at the token site.
    const outputSummary = redactor.redactString(
      truncateText(accumulatedText, OUTPUT_SUMMARY_MAX_CHARS),
    )
    const finishedPayload: RunFinishedPayload = {
      runId,
      finishReason,
      outputTextLength: accumulatedText.length,
      stepCount,
      durationMs: Date.now() - startedAt,
      ...(lastUsage ? { usage: lastUsage } : {}),
    }

    const finishedEvent: RunEvent = {
      kind: 'run.finished',
      ts: Date.now(),
      streamId,
      data: finishedPayload,
    }

    await runsRepo.markCompleted(db, runId, {
      outputSummary,
      ...(lastUsage?.inputTokens != null
        ? { promptTokens: lastUsage.inputTokens }
        : {}),
      ...(lastUsage?.outputTokens != null
        ? { completionTokens: lastUsage.outputTokens }
        : {}),
    })
    await publishAndAudit(
      db,
      eventBus,
      redactor,
      streamId,
      agentStreamId,
      runId,
      finishedEvent,
    )
  } catch (err) {
    // Includes: buildAgent failures, markRunning CAS failures, and
    // any exception thrown during stream iteration that Mastra didn't
    // surface as an `error` chunk.
    const { message: rawMessage, kind } = classifyError(err)
    const message = redactor.redactString(rawMessage)
    try {
      if (batcher) {
        await batcher.flushAndStop()
        batcher = null
      }
      await finalizeError(
        db,
        eventBus,
        redactor,
        streamId,
        agentStreamId,
        runId,
        { message, kind },
      )
    } catch (auditErr) {
      console.error(
        `[run-dispatcher] could not persist terminal error for run ${runId}:`,
        auditErr,
      )
      // Rethrow so the caller (which should have logged the original)
      // can tell something is genuinely broken.
      throw auditErr
    }
  } finally {
    if (batcher) {
      // Defensive: shouldn't hit this (the branches above null it out),
      // but if the error path throws before we clear it, make sure the
      // timer is gone.
      try {
        await batcher.flushAndStop()
      } catch (flushErr) {
        console.error(
          `[run-dispatcher] trailing batch flush failed for run ${runId}:`,
          flushErr,
        )
      }
    }
    if (unsubscribeMcpLogs) {
      // Drop the subscription BEFORE `built.disconnect()` so any
      // stderr line that arrives mid-teardown doesn't try to publish
      // onto a stream we're about to close. `disconnect()` also calls
      // `LogBroker.destroy()` which forcibly clears handlers — the
      // explicit unsubscribe here just keeps the contract explicit
      // and future-proofs against a `disconnect()` refactor.
      try {
        unsubscribeMcpLogs()
      } catch (err) {
        console.error(
          `[run-dispatcher] mcp-log unsubscribe error for run ${runId}:`,
          err,
        )
      }
      unsubscribeMcpLogs = null
    }
    // NOTE: deliberately no `built.disconnect()` here. The
    // `builtAgentCache` owns the subprocess lifetime now — disconnect
    // happens at process shutdown (`builtAgentCache.dispose()`) or
    // when an entry is evicted (TTL, LRU, or version-hash mismatch).
    // Tearing down per-run was the source of the per-message MCP
    // cold-start tax we explicitly fixed by moving to a cache.
  }
}

// ─── Stream → RunEvent mapping ───────────────────────────────────────────

interface MappedEvent {
  readonly kind: RunEventKind
  readonly ts: number
  readonly data: unknown
}

/**
 * Per-dispatch state threaded into `mapChunk`. Replaces the old module-
 * global counters (which incremented on every chunk type and produced
 * sparse, run-aliased indices like step 0/4/8 instead of 0/1/2).
 *
 * `currentStepIndex` advances ONLY on `step-start`. `tool-call`,
 * `tool-result`, and `step-finish` reuse the value so all chunks emitted
 * during one model turn carry the same step index. `tokenIndex` is
 * monotonic per run; the SSE consumer uses it to detect dropped frames.
 */
interface MapChunkState {
  currentStepIndex: number
  /** Wall-clock ms when the most recent step-start fired, used by
   *  `mapChunkToModelEvent` to compute the per-step `durationMs` on
   *  the matching `run.model.result`. 0 before the first step. */
  currentStepStartedAt: number
  tokenIndex: number
  /**
   * Reasoning text accumulated across `reasoning-delta` chunks within
   * the current step. Reset to '' on each `step-start`; copied into
   * the `reasoning` field on the next `run.model.result`. Reasoning-
   * capable models (Qwen3, DeepSeek R1, o1) emit chain-of-thought as
   * a separate chunk stream; without this, the content is silently
   * dropped while the wrapper tokens (`<think>` / `</think>`) leak
   * into the text stream and look like empty blocks in the chat UI.
   */
  pendingReasoning: string
}

/**
 * Map one Mastra chunk to at most one of our `run.*` events. Chunks
 * we don't surface in 3d (reasoning-*, raw, watch, workflow-*) return
 * `null` and get dropped.
 *
 * Chunk shape:
 *   - `type: string`          — discriminator
 *   - `payload: object`       — type-specific payload
 *   - `runId: string`         — Mastra-internal run id (unrelated to ours)
 *   - `from: ChunkFrom`       — AGENT | USER | SYSTEM | WORKFLOW | NETWORK
 */
function mapChunk(
  chunk: unknown,
  runId: string,
  state: MapChunkState,
): MappedEvent | null {
  if (!isRecord(chunk)) return null
  const type = chunk['type']
  if (typeof type !== 'string') return null
  const payload = isRecord(chunk['payload']) ? chunk['payload'] : {}
  const ts = Date.now()

  switch (type) {
    case 'text-delta': {
      const text = typeof payload['text'] === 'string' ? payload['text'] : ''
      if (text.length === 0) return null
      const idx = state.tokenIndex
      state.tokenIndex += 1
      return {
        kind: 'run.token',
        ts,
        data: {
          runId,
          index: idx,
          text,
        } satisfies RunTokenPayload,
      }
    }
    case 'step-start': {
      // Bump *only* on step-start. If Mastra ever supplies an explicit
      // `stepIndex` we honour it (and snap our counter to it) so sequence
      // matches their telemetry.
      const explicit = stringOrNumberOrNull(payload['stepIndex'])
      state.currentStepIndex =
        explicit !== null ? explicit : state.currentStepIndex + 1
      state.currentStepStartedAt = ts
      // Drop any reasoning carried over from a prior step. Reasoning is
      // per-step; if the next step doesn't emit any, the model.result
      // for it should report `reasoning: null`, not the previous step's.
      state.pendingReasoning = ''
      return {
        kind: 'run.step.started',
        ts,
        data: {
          runId,
          stepIndex: state.currentStepIndex,
          messageId: stringOr(payload['messageId'], ''),
        } satisfies RunStepStartedPayload,
      }
    }
    case 'reasoning-delta': {
      // Accumulate Mastra's per-token reasoning stream into MapState.
      // The matching `run.model.result` reads this on `step-finish` and
      // surfaces it as `reasoning` so /logs can show the model's chain
      // of thought. No event emitted here — the deltas are observability,
      // not first-class lifecycle. The chat tab strips the `<think>`
      // wrappers from the visible text stream separately.
      const text = stringOr(payload['text'], '')
      if (text) state.pendingReasoning += text
      return null
    }
    case 'reasoning-start':
    case 'reasoning-end':
    case 'reasoning-signature':
    case 'redacted-reasoning':
      // Companions to `reasoning-delta` — boundary markers + signed
      // attestations from providers like Anthropic. Swallow silently;
      // they don't carry text we need to surface.
      return null
    case 'step-finish': {
      return {
        kind: 'run.step.finished',
        ts,
        data: {
          runId,
          stepIndex:
            stringOrNumberOrNull(payload['stepIndex']) ??
            Math.max(0, state.currentStepIndex),
          messageId: stringOr(payload['messageId'], ''),
          finishReason: stringOr(payload['finishReason'], null),
          usage: pickUsage(payload['usage']),
        } satisfies RunStepFinishedPayload,
      }
    }
    case 'tool-call': {
      return {
        kind: 'run.tool.called',
        ts,
        data: {
          runId,
          stepIndex:
            stringOrNumberOrNull(payload['stepIndex']) ??
            Math.max(0, state.currentStepIndex),
          toolCallId: stringOr(payload['toolCallId'], ''),
          toolName: stringOr(payload['toolName'], ''),
          input: payload['args'] ?? payload['input'] ?? null,
        } satisfies RunToolCalledPayload,
      }
    }
    case 'tool-result': {
      // MCP tool servers return `{ isError: true, content: [...] }` on
      // failure rather than throwing — Mastra surfaces those as a normal
      // `tool-result` chunk, NOT a `tool-error`. Without this detection
      // the operator sees a green "Tool: foo → ok" row in /logs while
      // the model spins on a buried error envelope (the Notion
      // `Invalid Data Source URL` case). Promote MCP error envelopes
      // to the tool-error event path so the timeline + Errors filter
      // catch them at scan speed.
      const rawOutput = payload['result'] ?? payload['output'] ?? null
      const mcpError = detectMcpErrorEnvelope(rawOutput)
      const stepIdx =
        stringOrNumberOrNull(payload['stepIndex']) ??
        Math.max(0, state.currentStepIndex)
      const toolCallId = stringOr(payload['toolCallId'], '')
      const toolName = stringOr(payload['toolName'], '')
      if (mcpError !== null) {
        return {
          kind: 'run.tool.result',
          ts,
          data: {
            runId,
            stepIndex: stepIdx,
            toolCallId,
            toolName,
            error: mcpError,
          } satisfies RunToolResultPayload,
        }
      }
      return {
        kind: 'run.tool.result',
        ts,
        data: {
          runId,
          stepIndex: stepIdx,
          toolCallId,
          toolName,
          output: rawOutput,
        } satisfies RunToolResultPayload,
      }
    }
    case 'tool-error': {
      return {
        kind: 'run.tool.result',
        ts,
        data: {
          runId,
          stepIndex:
            stringOrNumberOrNull(payload['stepIndex']) ??
            Math.max(0, state.currentStepIndex),
          toolCallId: stringOr(payload['toolCallId'], ''),
          toolName: stringOr(payload['toolName'], ''),
          error: errorMessageFromPayload(payload),
        } satisfies RunToolResultPayload,
      }
    }
    case 'error': {
      const message = errorMessageFromPayload(payload)
      return {
        kind: 'run.error',
        ts,
        data: {
          runId,
          message,
          kind: classifyMessage(message),
        } satisfies RunErrorPayload,
      }
    }
    case 'finish': {
      return {
        kind: 'run.finished',
        ts,
        data: {
          runId,
          finishReason: stringOr(payload['finishReason'], null),
          // These fields get overwritten with accumulated state after
          // the stream drains; the dispatcher ignores this payload's
          // fields except `finishReason` + `usage`.
          outputTextLength: 0,
          stepCount: 0,
          durationMs: 0,
          usage: pickUsage(payload['usage']),
        } satisfies RunFinishedPayload,
      }
    }
    default:
      return null
  }
}

/**
 * Map a Mastra chunk to a `run.model.*` event when applicable. Runs
 * alongside `mapChunk` (which handles lifecycle + tool events) so the
 * two concerns can evolve independently. Returns `null` for chunk
 * types that don't carry LLM-call telemetry.
 *
 * The captured payloads are FULL — no preview cap. Postgres TOAST
 * absorbs the JSONB, the frontend viewer truncates display (not
 * storage), and `RunRedactor` scrubs secrets at the publish boundary.
 * This is a deliberate departure from the inspector subsystem's 2KB
 * convention; see `RunModelCalledPayload` for the reasoning.
 */
function mapChunkToModelEvent(
  chunk: unknown,
  runId: string,
  state: MapChunkState,
  modelId: string,
  ts: number,
): MappedEvent | null {
  if (!isRecord(chunk)) return null
  const type = chunk['type']
  if (typeof type !== 'string') return null
  const payload = isRecord(chunk['payload']) ? chunk['payload'] : {}

  switch (type) {
    case 'step-start': {
      // `request` field shape is provider-specific and Mastra-version-
      // dependent. We pass through whatever's there (or `null` when
      // absent) and let the frontend's `EventPayloadBody` render it.
      const request = payload['request'] ?? null
      const warnings = Array.isArray(payload['warnings'])
        ? (payload['warnings'] as ReadonlyArray<unknown>)
        : []
      return {
        kind: 'run.model.called',
        ts,
        data: {
          runId,
          stepIndex: state.currentStepIndex,
          model: modelId,
          request,
          warnings,
        } satisfies RunModelCalledPayload,
      }
    }
    case 'step-finish': {
      // Mastra's step-finish chunk includes the assembled assistant
      // text + tool-call decisions for THIS step (different from the
      // run-level `outputSummary` which concatenates all steps). The
      // `response` field carries the raw provider response when
      // surfaced; we forward it opaquely.
      const text = stringOr(payload['text'], '')
      const toolCalls = Array.isArray(payload['toolCalls'])
        ? (payload['toolCalls'] as ReadonlyArray<unknown>)
        : []
      // Reasoning comes from MapState (accumulated across `reasoning-
      // delta` chunks during this step), NOT from the step-finish
      // payload — Mastra streams reasoning separately and step-finish
      // doesn't carry it. Fall back to `payload['reasoning']` for any
      // future provider that does surface it on step-finish, then to
      // null when neither has it.
      const reasoning =
        state.pendingReasoning.length > 0
          ? state.pendingReasoning
          : stringOr(payload['reasoning'], null)
      const response = payload['response'] ?? null
      const durationMs =
        state.currentStepStartedAt > 0
          ? Math.max(0, ts - state.currentStepStartedAt)
          : 0
      return {
        kind: 'run.model.result',
        ts,
        data: {
          runId,
          stepIndex: state.currentStepIndex,
          model: modelId,
          text,
          toolCalls,
          reasoning,
          finishReason: stringOr(payload['finishReason'], null),
          durationMs,
          usage: pickUsage(payload['usage']),
          response,
        } satisfies RunModelResultPayload,
      }
    }
    default:
      return null
  }
}

function pickUsage(raw: unknown): RunFinishedPayload['usage'] {
  if (!isRecord(raw)) return undefined
  const input = toNumberOrNull(raw['inputTokens'] ?? raw['promptTokens'])
  const output = toNumberOrNull(raw['outputTokens'] ?? raw['completionTokens'])
  const total = toNumberOrNull(raw['totalTokens'])
  if (input === null && output === null && total === null) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
  }
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === 'string' ? value : fallback
}

function stringOrNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Detect the MCP "tool returned an error" envelope shape:
 *
 *   { isError: true, content: [{ type: 'text', text: '…' }, …] }
 *
 * Returns the extracted error message string when matched, or null
 * when the value isn't an MCP error envelope. The message comes from
 * the first `text` content part — for most MCP servers that's a JSON
 * blob with the upstream API error inside, which is verbose but
 * forwarded verbatim so operators can debug. Models also see it
 * verbatim via Mastra's tool-result, so the diagnosis the model
 * receives matches what /logs shows.
 *
 * Defensive — every shape mismatch returns null so a malformed
 * envelope falls through to the success path. The previous behavior
 * (always treating tool-result as success) is the safe fallback.
 */
function detectMcpErrorEnvelope(output: unknown): string | null {
  if (!isRecord(output)) return null
  if (output['isError'] !== true) return null
  const content = output['content']
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        isRecord(part) &&
        part['type'] === 'text' &&
        typeof part['text'] === 'string' &&
        part['text'].length > 0
      ) {
        return part['text']
      }
    }
  }
  return 'MCP tool returned isError: true (no text content)'
}

function errorMessageFromPayload(payload: Record<string, unknown>): string {
  const err = payload['error']
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (isRecord(err)) {
    const msg = err['message']
    if (typeof msg === 'string') return msg
  }
  const msg = payload['message']
  if (typeof msg === 'string') return msg
  return 'Unknown stream error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve Mastra's `{ thread, resource }` pair for this run, or `null`
 * when the agent has `memoryEnabled=false` (Mastra ignores the memory
 * config in that case; persisting a thread id would be misleading).
 *
 * Default rules:
 *   - `threadId` falls back to the runId so a "new conversation"
 *     button on the UI (which doesn't pass a threadId) gets a thread
 *     that matches the run 1:1 — identical to "no memory" but with
 *     the Mastra book-keeping present. Chat clients that want
 *     multi-turn memory mint a `crypto.randomUUID()` and reuse it
 *     across turns (see `apps/frontend/src/lib/use-chat`).
 *   - `resourceId` falls back to `agent:<agentId>` so every run of
 *     one agent shares a resource — the scope Mastra uses for
 *     semantic recall / cross-thread summaries. Future multi-user
 *     auth will replace this with real user ids.
 */
function resolveMemoryIds(
  built: BuiltAgent,
  input: DispatchRunInput,
): { mastraThreadId: string; mastraResourceId: string } | null {
  if (!built.meta.memoryEnabled) return null
  return {
    mastraThreadId: input.threadId ?? input.runId,
    mastraResourceId: input.resourceId ?? `agent:${input.agentId}`,
  }
}

async function publishAndAudit(
  db: AgentBridgeDb,
  eventBus: EventBus,
  redactor: RunRedactor,
  streamId: string,
  agentStreamId: string,
  runId: string,
  event: RunEvent,
): Promise<void> {
  // Scrub at the boundary so both Redis (pub/sub → SSE) and
  // `run_events` (audit) see the same redacted payload. A separate
  // scrub for each sink would be redundant and risks drift if a future
  // caller bypasses one.
  const scrubbed = redactor.redactEvent(event)
  // Publish to the per-run stream first (chat panel subscribes here).
  // In the worst case where audit fails, the browser still sees the
  // frame. Audit failures are logged below.
  await eventBus.publish(scrubbed)
  // Fan out to the per-agent stream so the Activity panel sees a
  // single timeline across multiple runs without having to track
  // individual run ids. Same scrubbed payload, different `streamId`.
  // Audit row stays single (keyed by `runId`) — the agent stream is
  // a derived broadcast, not a second source of truth.
  await eventBus.publish({ ...scrubbed, streamId: agentStreamId })
  try {
    await runsRepo.appendEvent(db, {
      runId,
      kind: scrubbed.kind,
      payload: scrubbed.data ?? null,
      ts: new Date(scrubbed.ts),
    })
  } catch (err) {
    console.error(
      `[run-dispatcher] audit insert failed (stream=${streamId}, kind=${scrubbed.kind}):`,
      err,
    )
  }
}

async function finalizeError(
  db: AgentBridgeDb,
  eventBus: EventBus,
  redactor: RunRedactor,
  streamId: string,
  agentStreamId: string,
  runId: string,
  err: { message: string; kind: RunErrorPayload['kind'] },
): Promise<void> {
  // `err.message` is already redacted by the caller, but we scrub
  // again here so a refactor that calls this helper with a raw string
  // can't silently leak. Cheap — it's a no-op when the plaintexts
  // list is empty.
  const safeMessage = redactor.redactString(err.message)
  await runsRepo.markError(db, runId, { errorMessage: safeMessage })
  const event: RunEvent = {
    kind: 'run.error',
    ts: Date.now(),
    streamId,
    data: {
      runId,
      message: safeMessage,
      kind: err.kind,
    } satisfies RunErrorPayload,
  }
  await publishAndAudit(
    db,
    eventBus,
    redactor,
    streamId,
    agentStreamId,
    runId,
    event,
  )
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (truncated)`
}

function classifyError(err: unknown): {
  message: string
  kind: RunErrorPayload['kind']
} {
  const message = err instanceof Error ? err.message : String(err)
  // AI_APICallError (from @ai-sdk/provider-utils) and similar errors
  // carry structured info we can classify without string matching.
  // Fall back to the regex pass when we can't read it off the object.
  const structured = classifyFromStatusCode(err)
  if (structured) return { message, kind: structured }
  return { message, kind: classifyMessage(message) }
}

/**
 * Pull a numeric HTTP status off common SDK error shapes. Walks one
 * level of `cause` because `ai-sdk` sometimes wraps the original
 * `APICallError` in a retry error. We stop there — deeper walking
 * tends to false-positive on unrelated 4xx/5xx numbers in strings.
 */
function classifyFromStatusCode(err: unknown): RunErrorPayload['kind'] | null {
  const code = extractStatusCode(err)
  if (code === null) return null
  if (code === 401 || code === 403) return 'auth'
  if (code === 429) return 'upstream'
  if (code >= 500 && code <= 599) return 'upstream'
  return null
}

function extractStatusCode(err: unknown): number | null {
  if (!isRecord(err)) return null
  const direct = err['statusCode']
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const cause = err['cause']
  if (isRecord(cause)) {
    const nested = cause['statusCode']
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  }
  return null
}

/**
 * Coarse classifier. Kept intentionally pattern-based (no SDK
 * coupling) so we don't rot when the OpenAI-compatible provider
 * changes its error shape. A proper structured-error pipeline that
 * can also drive UI icons would replace this.
 */
function classifyMessage(message: string): RunErrorPayload['kind'] {
  if (
    /\b(401|403|unauthor|invalid api key|incorrect api key|invalid authentication|missing api key)\b/i.test(
      message,
    )
  ) {
    return 'auth'
  }
  if (/\b(429|rate.?limit|too many requests|quota)\b/i.test(message)) {
    return 'upstream'
  }
  if (
    /\b(5\d\d|upstream|timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET)\b/i.test(
      message,
    )
  ) {
    return 'upstream'
  }
  if (/\btool\b/i.test(message)) {
    return 'tool'
  }
  return 'internal'
}

// ─── Token batcher ───────────────────────────────────────────────────────

interface TokenBatcherInput {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  readonly redactor: RunRedactor
  readonly runId: string
  readonly streamId: string
  readonly agentStreamId: string
  readonly flushIntervalMs: number
}

/**
 * Buffers `run.token` payloads in-memory and flushes them to Redis +
 * `run_events` on a fixed interval (or on `flushAndStop`). Each flush
 * emits ONE `run.token.batch` event — the SSE frame lets late-joining
 * subscribers catch up without replaying the live token stream; the
 * DB row gives replay endpoints a compact audit log.
 *
 * The buffer never spans more than `flushIntervalMs` wall-clock
 * (roughly), so memory pressure is bounded by the LLM's token rate.
 * For a 100 tok/s provider at 200 ms flushes that's ~20 tokens per
 * batch, well under any practical memory limit.
 */
class TokenBatcher {
  private readonly input: TokenBatcherInput
  private buffer: RunTokenPayload[] = []
  private timer: NodeJS.Timeout | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(input: TokenBatcherInput) {
    this.input = input
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      // Chain so two flushes don't interleave their `appendEvent`s
      // (order matters for audit replay).
      this.flushChain = this.flushChain.then(() => this.flushNow())
    }, this.input.flushIntervalMs)
    // Don't block process shutdown on the batcher's timer.
    this.timer.unref()
  }

  push(payload: RunTokenPayload): void {
    if (this.stopped) return
    this.buffer.push(payload)
  }

  async flushAndStop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Wait for any in-flight flush first, then one final drain.
    await this.flushChain
    await this.flushNow()
  }

  private async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return
    const drained = this.buffer
    this.buffer = []

    const first = drained[0]
    const last = drained[drained.length - 1]
    if (!first || !last) return

    const payload: RunTokenBatchPayload = {
      runId: this.input.runId,
      startIndex: first.index,
      endIndex: last.index,
      text: drained.map((t) => t.text).join(''),
      durationMs: 0, // TokenBatcher doesn't track per-batch wall time
    }

    const event: RunEvent = {
      kind: 'run.token.batch',
      ts: Date.now(),
      streamId: this.input.streamId,
      data: payload,
    }

    await publishAndAudit(
      this.input.db,
      this.input.eventBus,
      this.input.redactor,
      this.input.streamId,
      this.input.agentStreamId,
      this.input.runId,
      event,
    )
  }
}

/**
 * Check whether a Mastra thread row exists already. Returns `true`
 * when the thread is brand-new (no row for this id yet). Used by
 * the dispatcher to decide whether to fire a "thread.created" config
 * event for the Activity timeline.
 */
async function isNewMastraThread(
  handle: AgentBridgeDb,
  threadId: string,
): Promise<boolean> {
  const result = await handle.pool.query(
    'SELECT 1 FROM mastra.mastra_threads WHERE id = $1 LIMIT 1',
    [threadId],
  )
  return result.rowCount === 0
}

/**
 * Publish + persist an `agent.config.changed` event for a fresh
 * Mastra thread. Same plumbing the backend's `publishAgentConfig`
 * uses (SSE frame + agent_config_events row), inlined here so the
 * dispatcher can emit it without depending on backend's singletons.
 */
async function publishThreadCreated(args: {
  db: AgentBridgeDb
  eventBus: EventBus
  agentId: string
  agentStreamId: string
  threadId: string
  source: 'IDE' | 'chat tab'
}): Promise<void> {
  const ts = Date.now()
  const label = args.threadId.slice(0, 8)
  const detail = `started from ${args.source}`

  // Persist for the unified timeline.
  await agentConfigEventsRepo.appendConfigEvent(args.db, {
    agentId: args.agentId,
    action: 'created',
    resource: 'thread',
    label,
    detail,
    ts: new Date(ts),
  })

  // Live SSE for any open Activity panel.
  const event: RunEvent = {
    kind: 'agent.config.changed',
    ts,
    streamId: args.agentStreamId,
    data: {
      agentId: args.agentId,
      action: 'created',
      resource: 'thread',
      label,
      detail,
    },
  }
  await args.eventBus.publish(event)
}
