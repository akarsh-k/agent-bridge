import { z } from 'zod'
import type { RepoIndexSummary } from './domain.js'

/**
 * Shared SSE event envelope. Backend emits these on `/api/events/:streamId`;
 * frontend consumes them verbatim.
 *
 * Browser-safe.
 */

export const runEventKinds = [
  'run.started',
  /**
   * `run.token` is a SSE-only frame — high-frequency, not persisted. The
   * audit log receives `run.token.batch` rows instead (one per ~200ms
   * flush window) so `run_events` stays O(5-50 rows/run) instead of
   * O(1k+/run). See `docs/ARCHITECTURE.md` §3d for the trade-off.
   */
  'run.token',
  'run.token.batch',
  'run.step.started',
  'run.step.finished',
  /**
   * Per-step LLM-call telemetry. Emitted alongside `run.step.started` /
   * `run.step.finished` (one pair per model turn), carrying the FULL
   * request body sent to the provider and the FULL assistant response —
   * not the 2KB previews used by the inspector subsystem. Operators
   * inspecting "why did the model not call tool X?" or "what did the
   * system prompt look like with skills composed in?" answer those
   * questions from these rows.
   *
   * Cost is bounded by the `RunRedactor` pass + Postgres TOAST (JSONB
   * scales to MB-class values without index pressure). Skipping the
   * cap on purpose — see `docs/ARCHITECTURE.md` notes around
   * `run.model.*`.
   *
   * Pairs by `stepIndex` in the timeline UI.
   */
  'run.model.called',
  'run.model.result',
  'run.tool.called',
  'run.tool.result',
  /**
   * One line of stderr (or structured MCP log) from an external MCP
   * connection mounted for this run. Scrubbed through the
   * RunRedactor before emit; persisted to `run_events` verbatim so
   * late subscribers can reconstruct the log tail.
   */
  'run.mcp.log',
  'run.error',
  'run.finished',
  'worker.progress',
  'worker.log',
  'worker.finished',
  'worker.error',
  'repo.clone.started',
  'repo.clone.progress',
  'repo.clone.ok',
  'repo.clone.fail',
  'repo.index.started',
  'repo.index.progress',
  'repo.index.ok',
  'repo.index.fail',
  'repo.wiki.started',
  'repo.wiki.progress',
  'repo.wiki.ok',
  'repo.wiki.fail',
  /**
   * Repo deletion lifecycle. Published by the `delete-repo` worker on
   * the same `repo:<id>` stream as clone/index/wiki so the Logs UI
   * can render the cleanup in the same timeline. Sequence:
   *
   *   `repo.delete.started`    enqueued and the handler picked it up
   *   `repo.delete.waiting`    polling siblings; one event per poll
   *                            cycle that found in-flight work
   *   `repo.delete.ok`         disk + row removed cleanly
   *   `repo.delete.fail`       wait timed out or rm failed (BullMQ
   *                            will retry once before terminal failure)
   */
  'repo.delete.started',
  'repo.delete.waiting',
  'repo.delete.ok',
  'repo.delete.fail',
  /**
   * Emitted by mutating CRUD routes (skills, tools, repos, edges, MCP
   * allowlist, agent core fields) AFTER the DB write succeeds, on the
   * per-agent fan-out channel `agent:<agentId>`. Lets the Activity
   * panel show config edits inline with runtime events. NOT persisted
   * to `run_events` — the DB row itself + `updated_at` is the audit
   * trail; the SSE frame is just for the live feed.
   *
   * Payload shape: `AgentConfigChangedPayload`.
   */
  'agent.config.changed',
  /**
   * Coding-agent toolkit telemetry (P6). Emitted from the bridge
   * handler before/around the `dispatchRun` call so the Activity
   * panel can render IDE-originated traffic distinctly from chat.
   *
   * - `coding-agent.repo.resolved`. the resolver picked a single
   *   repo (or fanned out to `__all__`). Payload carries the score
   *   table + matched signal so operators can debug bad matches at
   *   a glance.
   * - `coding-agent.repo.clarification_requested`. multi-repo
   *   agent + no hint, OR `__all__` rejected by a single-repo-only
   *   tool. Logged as a normal event (NOT an error) so it doesn't
   *   bias the failure-rate dashboards.
   * - `coding-agent.tool.completed`. fires after the LLM-backed
   *   path finishes (success OR schema-unmatched). Carries
   *   `groundedness` + `confidence` so the operator can spot
   *   chronically low-confidence tools or low-grounding answers.
   *
   * Persisted in `run_events` for resolve / completed events tied
   * to a real run; `clarification_requested` is fan-out-only (no
   * `runs` row exists when the resolver short-circuits).
   */
  'coding-agent.repo.resolved',
  'coding-agent.repo.clarification_requested',
  'coding-agent.tool.completed',
  /**
   * Repo-embedding lifecycle (`docs/ARCHITECTURE.md §10`). Emitted by the
   * worker around the `gitnexus analyze --embeddings` segment so the
   * Logs UI can show embedding progress alongside clone/index/wiki on
   * the same `repo:<id>` stream. Kept separate from `repo.index.*` even
   * though gitnexus runs them in one process — operators want to see
   * "indexed but not embedded" as a distinct state.
   */
  'repo.embed.started',
  'repo.embed.ok',
  'repo.embed.fail',
  /**
   * Wrapper-tool path telemetry (`docs/ARCHITECTURE.md §10` A4). Emitted from
   * `packages/agents/src/inspector/*` around every wrapper invocation,
   * every internal LLM call (term-expansion), every gitnexus client
   * call, and the mini-repo finalisation. Routed through the same
   * `RunRedactor` as everything else so payloads are scrubbed before
   * audit/SSE. Logs UI's `wrapper` filter chip subscribes to these.
   *
   * Per-event payload shapes are defined further down (`Inspector*Payload`).
   * All payloads carry `wrapper_name` so the UI can group events into
   * a per-call timeline.
   *
   *  - `inspector.tool.called`      wrapper invocation begins
   *  - `inspector.tool.result`      wrapper invocation finishes
   *  - `inspector.llm.called`       internal LLM call starts (e.g.
   *                                 term expansion). Carries a
   *                                 truncated prompt preview (≤ 2KB).
   *  - `inspector.llm.result`       internal LLM call finishes with a
   *                                 truncated response preview.
   *  - `inspector.gitnexus.called`  one gitnexus client call from
   *                                 inside a wrapper (query / impact
   *                                 / context / cypher / detect_changes).
   *                                 Args truncated to 2KB.
   *  - `inspector.gitnexus.result`  matching result event with
   *                                 truncated payload preview.
   *  - `inspector.minirepo.built`   mini-repo finalised. Carries file
   *                                 count, total tokens, truncation
   *                                 stats. NOT the mini-repo body
   *                                 itself — that lands on
   *                                 `runs.minirepo_json` per D17.
   *  - `inspector.fallback`         the LLM term-expansion failed or
   *                                 was unparsable. Wrapper continues
   *                                 with raw query as the only
   *                                 expansion.
   */
  'inspector.tool.called',
  'inspector.tool.result',
  'inspector.llm.called',
  'inspector.llm.result',
  'inspector.gitnexus.called',
  'inspector.gitnexus.result',
  /**
   * Local keyword retrieval (`docs/ARCHITECTURE.md §10`). Emitted around
   * each `keywordSearch` invocation alongside the gitnexus calls — one
   * pair per wrapper invocation, per repo. Stand-in for gitnexus's
   * broken BM25 arm (gitnexus#1287); deletable when upstream lands a
   * fix. Same redaction + 2KB preview cap as the other inspector
   * events.
   */
  'inspector.keyword.called',
  'inspector.keyword.result',
  'inspector.minirepo.built',
  'inspector.fallback',
  'ping',
] as const

export type RunEventKind = (typeof runEventKinds)[number]

export const runEventSchema = z.object({
  kind: z.enum(runEventKinds),
  ts: z.number().int(),
  streamId: z.string().min(1),
  data: z.unknown().optional(),
})

export type RunEvent = z.infer<typeof runEventSchema>

/** Format an event object as a single SSE frame. */
export function formatSseFrame(event: RunEvent): string {
  const payload = JSON.stringify(event)
  return `event: ${event.kind}\ndata: ${payload}\n\n`
}

// ─── `repo.clone.*` payload shapes ────────────────────────────────────────
//
// Typed payloads for the four new clone events. Not part of the SSE envelope
// validation (`runEventSchema.data` is `unknown`); used by producers +
// consumers that want compile-time safety on the payload.

export interface RepoCloneStartedPayload {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
}

/**
 * One git progress line, forwarded verbatim (after secret redaction).
 * Git emits these to stderr — e.g. "Receiving objects: 42% (210/500)".
 */
export interface RepoCloneProgressPayload {
  readonly repoId: string
  readonly line: string
}

export interface RepoCloneOkPayload {
  readonly repoId: string
  readonly localPath: string
  readonly durationMs: number
}

export interface RepoCloneFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

// ─── `repo.index.*` payload shapes ────────────────────────────────────────
//
// The index pipeline publishes on the same `repo:<id>` stream as the clone
// pipeline — the frontend can render a continuous timeline from "cloning"
// through "indexing" in a single log component. `mode` lets the UI choose
// between "Indexing…" (initial) and "Re-indexing…" banners without the
// worker caring about copy.

/**
 * `mode` mirrors the `IndexRepoJob.mode` discriminant:
 *   - `initial`  — first analyze pass, auto-enqueued by the clone worker
 *   - `reindex`  — manual re-run from the UI (force-refresh or retry-after-error)
 */
export type RepoIndexMode = 'initial' | 'reindex'

export interface RepoIndexStartedPayload {
  readonly repoId: string
  readonly mode: RepoIndexMode
}

/**
 * One line of gitnexus stdout/stderr, forwarded verbatim after redaction.
 * gitnexus uses `cli-progress` which emits `\r`-terminated updates — the
 * worker splits on both `\r` and `\n` so the log stays readable.
 */
export interface RepoIndexProgressPayload {
  readonly repoId: string
  readonly line: string
}

export interface RepoIndexOkPayload {
  readonly repoId: string
  readonly durationMs: number
  readonly summary: RepoIndexSummary
}

export interface RepoIndexFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

// ─── `repo.wiki.*` payload shapes ─────────────────────────────────────────
//
// Wiki generation publishes on the same `repo:<id>` stream as clone + index
// so the inspector log can render a continuous timeline across all three
// pipelines. `mode` mirrors the `GenerateWikiJob.mode` discriminant — the
// frontend uses it to label the banner ("Generating wiki…" vs "Re-generating
// wiki (force)…") and the worker forwards it as the `--force` flag toggle.

export type RepoWikiMode = 'initial' | 'force'

export interface RepoWikiStartedPayload {
  readonly repoId: string
  readonly mode: RepoWikiMode
  /**
   * Hint for the UI banner — surfaces which provider is being charged for
   * this run. The backend resolves it from `llm_providers.kind` at enqueue
   * time so the worker doesn't need to publish a "started" frame at all
   * (the backend publishes one before the job lands on the queue, the
   * worker publishes a second one once it actually picks up the job —
   * same idempotent contract as `repo.index.started`).
   */
  readonly providerKind: string
}

/**
 * One line of `gitnexus wiki` stdout/stderr after redaction. The CLI
 * streams a `cli-progress` bar that emits `\r`-terminated phase updates
 * ("Generating pages... (12s)") plus newline-terminated free-form lines.
 * Our line buffer splits on both so the log stays glanceable.
 */
export interface RepoWikiProgressPayload {
  readonly repoId: string
  readonly line: string
}

export interface RepoWikiOkPayload {
  readonly repoId: string
  readonly durationMs: number
  readonly mode: RepoWikiMode
  /**
   * Page count parsed from the final stdout summary ("Pages: N"). `null`
   * when the run was a no-op (`Mode: up-to-date`) and the CLI didn't emit
   * a fresh count, OR when the parser couldn't find the line (defensive —
   * gitnexus could change the output format in a future minor bump).
   */
  readonly pages: number | null
  /**
   * gitnexus's own `WikiResult.mode` value, parsed from stdout
   * ("Mode: incremental" / "full" / "up-to-date"). `null` if not found.
   * Lets the UI distinguish "regenerated everything" from "rebuilt only
   * the diff" without an extra column.
   */
  readonly resultMode: string | null
}

export interface RepoWikiFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

// ─── `repo.delete.*` payload shapes ──────────────────────────────────────

export interface RepoDeleteStartedPayload {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
}

/**
 * Emitted on each polling cycle that finds in-flight clone/index/wiki
 * jobs for this repo. `pendingByQueue` lets the UI tell the operator
 * which kind of job is blocking ("waiting on index-repo …").
 */
export interface RepoDeleteWaitingPayload {
  readonly repoId: string
  readonly elapsedMs: number
  readonly pendingByQueue: Readonly<Record<string, number>>
}

export interface RepoDeleteOkPayload {
  readonly repoId: string
  readonly waitedMs: number
  readonly diskRemoved: boolean
  readonly rowRemoved: boolean
}

export interface RepoDeleteFailPayload {
  readonly repoId: string
  readonly message: string
  /** `true` when the failure was the 5-minute wait-for-in-flight ceiling. */
  readonly waitTimeout?: boolean
}

/** Build the SSE `streamId` for per-repo clone + index + wiki + delete progress. */
export function repoStreamId(repoId: string): string {
  return `repo:${repoId}`
}

// ─── `run.*` payload shapes ──────────────────────────────────────────────
//
// Typed payloads for every `run.*` event the `POST /agents/:id/runs`
// dispatcher can emit. Like the `repo.*` payloads above, these are NOT
// part of the wire schema (`runEventSchema.data` stays `unknown`); they
// exist so the producer (`apps/backend/src/lib/run-dispatcher.ts`) and
// consumer (frontend chat UI in 3e) both type-check against the same
// shape, with drift caught by TypeScript rather than at runtime.
//
// Stream ID convention: `run:<runId>`, matching the `repo:<repoId>`
// style used by the clone+index pipeline. See `runStreamId()` at the
// bottom of this section.

/**
 * Emitted once, right after the `runs` row flips to `running`. Carries
 * the minimum metadata the UI needs to render the run card without a
 * second fetch (agent + model + mount summary).
 */
export interface RunStartedPayload {
  readonly runId: string
  readonly agentId: string
  readonly agentName: string
  readonly providerKind: string
  readonly modelId: string
  /**
   * `true` iff the run has a `gitnexus mcp` subprocess attached. Lets
   * the UI decide whether to render the "tools" column on the timeline.
   */
  readonly gitnexusMounted: boolean
  /** Count of Mastra tools wired into the Agent (gitnexus + future MCPs). */
  readonly toolCount: number
  /**
   * Mastra thread id this run writes to — mirrors the value persisted
   * on `runs.mastra_thread_id`. `null` when the agent has
   * `memoryEnabled=false`, in which case Mastra never creates a
   * thread and there is nothing to link to.
   */
  readonly mastraThreadId: string | null
  /**
   * Mastra resource id this run writes to. `null` on memory-disabled
   * agents (same rule as `mastraThreadId`). Defaults to
   * `agent:<agentId>` server-side when the client doesn't supply one.
   */
  readonly mastraResourceId: string | null
}

/**
 * Per-token SSE frame. One per Mastra `text-delta` chunk. NOT persisted
 * individually — see `RunTokenBatchPayload` for the audit row shape.
 * `index` is monotonic within a run so a client that missed earlier
 * frames can detect the gap and fall back to the batch rows.
 */
export interface RunTokenPayload {
  readonly runId: string
  readonly index: number
  readonly text: string
}

/**
 * Batched token row, written to `run_events` every ~200ms (or on
 * `run.finished`/`run.error`, whichever comes first). `startIndex` and
 * `endIndex` are the monotonic `RunTokenPayload.index` bounds this
 * batch covers, so a replay endpoint can reconstruct the full token
 * sequence by concatenating the batches in order.
 *
 * This event IS also published to SSE so late-joining subscribers can
 * "catch up" without the backend having to re-stream the whole history.
 * UI should treat it as a fallback for token frames it already rendered
 * (dedupe by `index`).
 */
export interface RunTokenBatchPayload {
  readonly runId: string
  readonly startIndex: number
  readonly endIndex: number
  readonly text: string
  /** Wall-clock ms between the first and last token in this batch. */
  readonly durationMs: number
}

/**
 * Mastra `step-start` chunk. A "step" is one LLM call in a multi-step
 * run (e.g. the model asks for a tool, gets a result, then finishes —
 * that's 2 steps). `stepIndex` is zero-based; Mastra's own `runId` is
 * per-chunk and opaque, so we don't forward it.
 */
export interface RunStepStartedPayload {
  readonly runId: string
  readonly stepIndex: number
  readonly messageId: string
}

/**
 * Mastra `step-finish` chunk. `finishReason` values come from
 * `LanguageModelV2FinishReason` (e.g. `stop`, `tool-calls`, `length`,
 * `content-filter`). `usage` is optional because some providers omit
 * it when streaming.
 */
export interface RunStepFinishedPayload {
  readonly runId: string
  readonly stepIndex: number
  readonly messageId: string
  readonly finishReason: string | null
  readonly usage?: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly totalTokens: number | null
  }
}

/**
 * `run.model.called` payload. Emitted from the dispatcher right after
 * the matching `run.step.started`, carrying the FULL request body Mastra
 * shipped to the provider for this step (system + message history + tool
 * definitions + sampling params). Operators answer "what did the model
 * actually see this turn?" from this row.
 *
 * Intentionally uncapped — JSONB / TOAST handles MB-scale values, and
 * the frontend `EventPayloadViewer` already truncates DISPLAY (with a
 * "Show all" affordance) so storage stays full while the UI stays calm.
 * The 2KB cap on `inspector.llm.*` is a separate convention for that
 * subsystem's high-frequency previews; it does not apply here.
 *
 * `request` is `unknown` because the body shape is provider-specific
 * (OpenAI vs Anthropic vs Google formats). Consumers treat it opaquely;
 * the `EventPayloadBody` knows how to render it as a key/value tree.
 */
export interface RunModelCalledPayload {
  readonly runId: string
  readonly stepIndex: number
  /** Provider model id (e.g. `gpt-4o-mini`, `claude-sonnet-4-6`). Lifted
   *  from the agent meta so the operator sees the model on every call
   *  event without joining to the run row. */
  readonly model: string
  /** Full provider request body (messages, tools, sampling). `null` when
   *  Mastra didn't surface it on this chunk — older versions or some
   *  streaming paths only emit the messageId on `step-start`. */
  readonly request: unknown | null
  /** Mastra warnings from this step-start (e.g. "tool X has no schema",
   *  "temperature ignored by provider"). Useful for spotting silent
   *  provider rejections. Empty array, not undefined, when none. */
  readonly warnings: ReadonlyArray<unknown>
}

/**
 * `run.model.result` payload. Emitted alongside `run.step.finished` with
 * the FULL assistant response for this step — text, tool-call decisions,
 * reasoning content (for reasoning models), and the raw provider
 * response body when Mastra surfaces it. Pairs with `run.model.called`
 * by `stepIndex` in the timeline UI.
 *
 * `text` is the assistant text emitted by THIS step only (not the
 * concatenated `runs.output_summary`) so multi-step runs can be debugged
 * one turn at a time: "step 2 said X before requesting tool Y, step 3
 * came back and said Z."
 */
export interface RunModelResultPayload {
  readonly runId: string
  readonly stepIndex: number
  readonly model: string
  /** Assistant text from this step only. Empty when the step ended in a
   *  pure tool-call without surfacing user-visible text. */
  readonly text: string
  /** Tool calls the model decided to make this step. Each entry mirrors
   *  the `tool-call` chunk: `{ toolCallId, toolName, input }`. Repeated
   *  here so the operator sees decisions and arguments on the response
   *  row without having to scan for the matching `run.tool.called`. */
  readonly toolCalls: ReadonlyArray<unknown>
  /** Reasoning content from reasoning-capable models (Claude reasoning,
   *  o1, etc.). `null` when the model isn't a reasoning model or the
   *  provider didn't emit it. */
  readonly reasoning: string | null
  readonly finishReason: string | null
  /** Wall-clock duration from step-start to step-finish. Lets the
   *  operator spot which step was the slow one in a multi-step run
   *  without doing arithmetic on adjacent timestamps. */
  readonly durationMs: number
  readonly usage?: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly totalTokens: number | null
  }
  /** Raw provider response body if Mastra surfaced it on the
   *  `step-finish` chunk, else null. Provider-specific shape. */
  readonly response: unknown | null
}

/**
 * Mastra `tool-call` chunk. `input` is the JSON-deserialised arguments
 * object the LLM sent. Providers emit these as arg-name/value pairs;
 * Mastra buffers the streaming deltas so we only see completed calls
 * here, not partials.
 */
export interface RunToolCalledPayload {
  readonly runId: string
  readonly stepIndex: number
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

/**
 * Mastra `tool-result` OR `tool-error` chunk. The error path folds into
 * the same event (with `error` set) so the frontend only needs one
 * timeline row per tool invocation. `output` is whatever the tool's
 * `execute()` returned — for gitnexus tools that's typically the raw
 * MCP response payload (Mastra passes it through).
 */
export interface RunToolResultPayload {
  readonly runId: string
  readonly stepIndex: number
  readonly toolCallId: string
  readonly toolName: string
  readonly output?: unknown
  readonly error?: string
}

/**
 * One stderr / log line from an external MCP subprocess (stdio transport)
 * surfacing live in the run UI. Goes through the same redactor +
 * publishAndAudit path as every other run event, so plaintext env /
 * headers values baked into `BuiltAgent.secrets` never leak.
 *
 * `level` is a best-effort classification:
 *   - `error` when the line starts with MCP-spec level prefixes
 *     (`ERROR`, `FATAL`) or common stderr fatal markers.
 *   - `warn` when it starts with `WARN` / `WARNING`.
 *   - `info` otherwise — that's the majority of stdio MCP output, which
 *     tends to be plain startup banners + JSON-RPC trace lines.
 *
 * `connectionName` is the user-visible `mcp_connections.name`; the UI
 * uses it to group log rows under the right tool card.
 */
export interface RunMcpLogPayload {
  readonly runId: string
  readonly connectionId: string
  readonly connectionName: string
  readonly level: 'info' | 'warn' | 'error'
  readonly line: string
}

/**
 * Fatal run error. Published once, right before the `runs` row lands in
 * `status='error'`. `message` is already redacted by the dispatcher (we
 * strip any plaintext API keys the provider might have echoed back).
 */
export interface RunErrorPayload {
  readonly runId: string
  readonly message: string
  /**
   * Coarse classifier the UI maps to icons:
   *   - `auth`        — 401/403 from the LLM provider.
   *   - `upstream`    — other provider errors (5xx, rate limit, model not found).
   *   - `tool`        — a tool handler threw outside `tool-error` (rare).
   *   - `internal`    — anything else (spawn failure, DB error, etc.).
   */
  readonly kind: 'auth' | 'upstream' | 'tool' | 'internal'
}

/**
 * Mastra `finish` chunk. Closes out the run — the audit row captures
 * usage + finishReason + text length so the UI can render a compact
 * summary without reading the full message list.
 */
export interface RunFinishedPayload {
  readonly runId: string
  readonly finishReason: string | null
  readonly outputTextLength: number
  readonly stepCount: number
  readonly durationMs: number
  readonly usage?: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly totalTokens: number | null
  }
}

/** Build the SSE `streamId` for per-run agent output. */
export function runStreamId(runId: string): string {
  return `run:${runId}`
}

/**
 * Build the SSE `streamId` for a run started by the IDE-facing MCP
 * bridge. Uses `bridge:` instead of `run:` so the runs tab
 * (and any future filter) can distinguish IDE-originated runs from
 * UI-chat runs without a schema column. The persisted
 * `runs.stream_id` carries the same prefix; the dispatcher just
 * plumbs whatever the caller persisted.
 */
export function bridgeStreamId(runId: string): string {
  return `bridge:${runId}`
}

/**
 * Build the SSE `streamId` for the per-agent activity feed. Every
 * dispatcher event for an agent's runs (and, in the future, every
 * worker event for repos attached to that agent) is fanned out onto
 * this channel in ADDITION to the per-run / per-repo channel. The
 * Activity panel in the right rail subscribes here so it sees the
 * full timeline for the focused agent across many runs without
 * having to know individual run ids.
 *
 * NOT persisted on `runs.stream_id` — that column tracks the per-run
 * channel the chat panel subscribes to. The agent channel is a
 * derived fan-out; the audit log already captures the full sequence
 * keyed by `run_id`.
 */
export function agentStreamId(agentId: string): string {
  return `agent:${agentId}`
}

// ─── `agent.config.changed` payload ──────────────────────────────────────

/**
 * Resource categories that the Activity panel knows how to render.
 * Kept as a closed list so the UI can map each value to an icon + colour
 * without a fallback path. Add new entries here when a new mutating
 * resource lands.
 */
export const agentConfigResources = [
  'agent',
  'skill',
  'tool',
  'repo',
  'repo_edge',
  'mcp_allowlist',
  // Not a config resource in the literal sense, but it ships through
  // the same persistence + SSE pipeline so the unified Activity log
  // can show "new thread started" entries alongside config edits.
  // Fired by the dispatcher the first time it sees a new threadId.
  'thread',
] as const
export type AgentConfigResource = (typeof agentConfigResources)[number]

/**
 * Verbs the Activity panel surfaces. We use `attached`/`detached` for
 * `repo` (since a repo is a global resource that's attached to an
 * agent, not created by it) and `added`/`removed`/`updated` for
 * everything else. `replaced` is reserved for set-style PUTs (e.g. the
 * MCP allowlist, where the request body becomes the canonical state).
 */
export const agentConfigActions = [
  'added',
  'updated',
  'removed',
  'attached',
  'detached',
  'replaced',
  // Reserved for thread starts — the dispatcher fires a 'created'
  // event for `resource: 'thread'` on the first run of a new
  // threadId. Distinct from 'added' since threads are session-scoped
  // not user-edited.
  'created',
] as const
export type AgentConfigAction = (typeof agentConfigActions)[number]

export interface AgentConfigChangedPayload {
  readonly agentId: string
  readonly action: AgentConfigAction
  readonly resource: AgentConfigResource
  /**
   * Short human label — the resource's name / slug / "3 tools" for
   * a set-replace. Trim aggressively at the producer; the Activity card
   * renders this verbatim.
   */
  readonly label: string
  /** Optional one-line context. Shown in the card's hover/expand state. */
  readonly detail?: string
}

// ─── Coding-agent telemetry payloads ─────────────────────────────────────

/**
 * Names of the six virtual bridge tools. Mirrors
 * `CODING_AGENT_TOOL_NAMES` in `dtos/coding-agent.ts`. Re-declared here
 * so the events module stays free of cross-DTO imports (events.ts is
 * the lowest layer; everything imports from it).
 */
export type CodingAgentEventToolName =
  | 'plan_feature'
  | 'plan_bugfix'
  | 'ask_general'
  | 'investigate_codebase'
  | 'assess_impact'
  | 'list_repos'

/**
 * `CodingAgentConfidence`, `MatchedSignal`, `ClarificationKind`, and
 * `RepoMatchScore` already live in `dtos/coding-agent.ts`. we don't
 * re-declare them here to avoid name collisions on the barrel
 * export. `events.ts` is the lowest layer in `@agent-bridge/shared`,
 * so the payload types reference the local re-aliases below to
 * avoid an upward import.
 */
export type CodingAgentEventMatchedSignal =
  | 'remote_url'
  | 'role'
  | 'alias'
  | 'local_folder'
  | 'url_tail'

export type CodingAgentEventScope = 'single' | 'all'

export type CodingAgentEventClarificationKind =
  | 'repo_or_all'
  | 'single_repo_required'

export type CodingAgentEventConfidence = 'high' | 'medium' | 'low'

export interface CodingAgentEventRepoMatchScore {
  readonly repo_id: string
  readonly label: string
  readonly score: number
  readonly matched_signal: CodingAgentEventMatchedSignal
}

/**
 * `coding-agent.repo.resolved` payload. Captures the resolver's
 * decision so an operator inspecting `run_events` can answer "why
 * did the bridge pick this repo?". `picked` is null when scope was
 * `all` (the bridge fanned out instead of selecting one repo).
 */
export interface CodingAgentRepoResolvedPayload {
  readonly runId: string
  readonly tool: CodingAgentEventToolName
  readonly hint: {
    readonly repo_hint?: string
    readonly remote_url?: string
    readonly local_folder?: string
    readonly branch?: string
  }
  readonly scope: CodingAgentEventScope
  readonly picked: {
    readonly repo_id: string
    readonly label: string
    readonly matched_signal: CodingAgentEventMatchedSignal
    readonly confidence: CodingAgentEventConfidence
  } | null
  readonly score_table: ReadonlyArray<CodingAgentEventRepoMatchScore>
  /** `agent_repos.aliases` length on the picked repo (audit hint). */
  readonly picked_alias_count?: number
  /** Number of related-repo hints the IDE supplied that did not resolve. */
  readonly unresolved_related_count: number
}

/**
 * `coding-agent.repo.clarification_requested` payload. Fan-out only;
 * not persisted (no `runs` row exists at this point. the resolver
 * short-circuits before `dispatchRun`).
 */
export interface CodingAgentRepoClarificationPayload {
  readonly tool: CodingAgentEventToolName
  readonly kind: CodingAgentEventClarificationKind
  /** Number of candidate repos surfaced to the IDE for re-prompting. */
  readonly candidate_count: number
  /** True when `__all__` is a valid reply for the calling tool. */
  readonly allow_all_repos: boolean
}

/**
 * `coding-agent.tool.completed` payload. Fires once per LLM-backed
 * call after `dispatchRun` returns. `confidence` and `groundedness`
 * come from the LLM's JSON output (or the schema-unmatched fallback);
 * `duration_ms` is the bridge-side wall clock around `dispatchRun`.
 *
 * `schema_unmatched` flips true when the LLM's output failed to
 * parse as JSON. useful for spotting chronically misbehaving
 * model + prompt combinations.
 */
export interface CodingAgentToolCompletedPayload {
  readonly runId: string
  readonly tool: CodingAgentEventToolName
  readonly scope: CodingAgentEventScope
  readonly confidence: CodingAgentEventConfidence
  readonly groundedness?: {
    readonly claims: number
    readonly grounded: number
    readonly ungrounded: number
  }
  readonly duration_ms: number
  readonly schema_unmatched?: boolean
}

// ─── `repo.embed.*` payload shapes ───────────────────────────────────────
//
// Lifecycle around the embedding leg of `gitnexus analyze --embeddings`.
// The worker emits these on the same `repo:<id>` stream as clone / index
// / wiki so the inspector log renders one continuous timeline. Embedding
// happens inside gitnexus's process; we forward the discrete state
// transitions, not per-batch progress.

export interface RepoEmbedStartedPayload {
  readonly repoId: string
  /**
   * Provider kind of the embedding provider gitnexus was configured with
   * (mirrors `llm_providers.kind`). Lets the UI banner say "Embedding via
   * openai…" without re-querying the DB. Derived once per job at enqueue.
   */
  readonly providerKind: string
  readonly model: string
}

export interface RepoEmbedOkPayload {
  readonly repoId: string
  readonly durationMs: number
  /**
   * File count gitnexus reported as embedded. Optional. older gitnexus
   * versions don't surface this; we leave it `null` rather than fabricate.
   */
  readonly files: number | null
}

export interface RepoEmbedFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

// ─── `inspector.*` payload shapes ────────────────────────────────────────
//
// Wrapper-tool path telemetry. Every payload carries `runId` + `wrapperName`
// so the UI can group events under a single wrapper invocation. Previews
// of prompts / args / results are truncated at the producer (cap below) and
// pass through the existing `RunRedactor` so secrets stay scrubbed.

/**
 * Hard cap on every redacted preview field before publish. 2KB matches
 * what was promised in `docs/ARCHITECTURE.md §10` A4. Producers must enforce this;
 * the schema doesn't (string lengths aren't validated on `data: unknown`).
 */
export const INSPECTOR_PREVIEW_BYTES_CAP = 2048

/**
 * Canonical wrapper-tool names. Mirrors `docs/ARCHITECTURE.md §10` §4. Kept here
 * (not in dtos) because event payloads are consumed by the frontend via
 * the shared package's browser-safe entry.
 */
export const inspectorWrapperNames = [
  'find_in_codebase',
  'trace_flow',
  'assess_change_impact',
  'debug_help',
  'understand_module',
  'list_repos',
] as const
export type InspectorWrapperName = (typeof inspectorWrapperNames)[number]

export interface InspectorToolCalledPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  /** Redacted JSON-stringified args, truncated to `INSPECTOR_PREVIEW_BYTES_CAP`. */
  readonly argsPreview: string
  /** Whether `argsPreview` was truncated (length > cap). */
  readonly truncated: boolean
}

export interface InspectorToolResultPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  readonly durationMs: number
  /** `'ok' | 'fallback' | 'error'`. mirrors the wrapper's terminal state. */
  readonly status: 'ok' | 'fallback' | 'error'
  /** Optional message — populated on `error`/`fallback`. */
  readonly message?: string
}

export interface InspectorLlmCalledPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  /** Why the LLM was hit. today only `'expand'` (term expansion). */
  readonly purpose: 'expand'
  readonly model: string
  /** Redacted prompt preview, capped. */
  readonly promptPreview: string
  readonly truncated: boolean
}

export interface InspectorLlmResultPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  readonly purpose: 'expand'
  readonly durationMs: number
  /** Redacted response preview, capped. */
  readonly responsePreview: string
  readonly truncated: boolean
  /**
   * Approximate token usage. Optional because not every provider returns
   * usage and we don't want to fabricate.
   */
  readonly tokens?: {
    readonly input: number
    readonly output: number
  }
}

export interface InspectorGitnexusCalledPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  /** Gitnexus tool name (e.g. `gitnexus_query`). */
  readonly tool: string
  /** Redacted JSON-stringified args, capped. */
  readonly argsPreview: string
  readonly truncated: boolean
}

export interface InspectorGitnexusResultPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  readonly tool: string
  readonly durationMs: number
  /** Redacted result preview, capped. */
  readonly resultPreview: string
  readonly truncated: boolean
  /** `false` when the gitnexus call surfaced an error. */
  readonly ok: boolean
}

/**
 * Local keyword retrieval. Stand-in for gitnexus's broken
 * BM25 arm. The wrapper-tool emits a `.called` frame before each
 * `keywordSearch` spawn and a `.result` frame after, with a redacted
 * preview of the queries + hit count. Deletable when gitnexus#1287
 * is fixed upstream.
 */
export interface InspectorKeywordCalledPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  /** Friendly repo label (mirrors what's on the gitnexus calls). */
  readonly repoLabel: string
  /** Comma-joined preview of the query terms, capped. */
  readonly queriesPreview: string
  readonly truncated: boolean
}

export interface InspectorKeywordResultPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  readonly repoLabel: string
  readonly durationMs: number
  /** Number of hits returned (post-rank, post-limit). `null` on error. */
  readonly hitCount: number | null
  /** `false` when ripgrep errored or timed out. */
  readonly ok: boolean
  /** Optional error/warning message, capped. */
  readonly message?: string
}

export interface InspectorMinirepoBuiltPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  readonly fileCount: number
  readonly chunkCount: number
  readonly tokensUsed: number
  readonly tokensCap: number
  /** `true` when truncation rules in §5 fired. */
  readonly truncated: boolean
}

export interface InspectorFallbackPayload {
  readonly runId: string
  readonly wrapperName: InspectorWrapperName
  /** Why we fell back: LLM error, parse error, empty output, etc. */
  readonly reason: string
}
