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
   * O(1k+/run). See `docs/PLAN.md` §3d for the trade-off.
   */
  'run.token',
  'run.token.batch',
  'run.step.started',
  'run.step.finished',
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

/** Build the SSE `streamId` for per-repo clone + index + wiki progress. */
export function repoStreamId(repoId: string): string {
  return `repo:${repoId}`
}

// ─── `run.*` payload shapes (Phase 3d) ───────────────────────────────────
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
   * thread and there is nothing to link to. Populated in Phase 3g.
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
 * bridge. Phase 5 uses `bridge:` instead of `run:` so the runs tab
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
