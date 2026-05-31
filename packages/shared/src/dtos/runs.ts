/**
 * Global runs-list DTOs. Browser-safe.
 *
 * `GET /api/runs?source=bridge|ui&limit=50` powers two surfaces:
 *   - The IDE-bridge view (filters `source=bridge`)
 *   - A future "all runs" UI view that the per-agent activity tab
 *     can promote to a global feed.
 *
 * Source is **derived from the `stream_id` prefix** at response time —
 * `'run:'` → `'ui'`, `'bridge:'` → `'bridge'`. We don't store source
 * as a column because the prefix already encodes it (design
 * decision in `docs/ARCHITECTURE.md`).
 *
 * The list-row shape deliberately TRUNCATES `inputPrompt` and
 * `outputSummary` to keep the response under a few hundred KB even
 * for 50 rows of long-running chats. The full text is recoverable via
 * the per-run audit log endpoint (future) or by reading
 * `runs.output_summary` directly via DB tooling.
 */

import { z } from 'zod'
import { runStatuses } from '../domain.js'

/**
 * Source of a run, derived from `stream_id` prefix:
 *   - `ui`      — run started by the UI chat (`run:<id>` prefix)
 *   - `bridge`  — run started by the IDE-facing MCP bridge (`bridge:<id>`)
 *   - `unknown` — anything else (forward-compat for future sources)
 */
export const runSources = ['ui', 'bridge', 'unknown'] as const
export type RunSource = (typeof runSources)[number]

/** Query-side enum, narrower than `RunSource` (no `unknown` filter). */
export const runListSourceFilters = ['ui', 'bridge'] as const
export type RunListSourceFilter = (typeof runListSourceFilters)[number]

/**
 * Truncation cap for prompt + output preview in list rows. ~500 chars
 * is enough to identify the run at a glance; full bodies sit behind a
 * detail endpoint.
 */
export const RUN_LIST_PREVIEW_CHARS = 500

// ─── Callsite (always-on, per-run) ──────────────────────────────────────
//
// Captured at run dispatch time — never user-supplied via chat or tool
// args. Composition order:
//   - bridge handlers build it from the MCP `initialize` clientInfo +
//     the dispatch-time agent record + the tool args the caller passed
//     (repo hints)
//   - the chat backend builds a synthetic `{client: {name: 'web-chat'},
//     tool: {name: 'chat'}, …}` shape so web-chat runs carry the same
//     wire shape as bridge runs
//
// Persisted to `runs.callsite_json` and prepended to the dispatched
// prompt as a single italic `_Request origin: …_` metadata line (see
// `formatCallsiteBlock` below) so operator skills can text-match
// origin / agent ("if origin contains 'web-chat', format X").
//
// Deliberately platform-agnostic. `client + agent + tool + repo +
// started_at` are concepts every MCP caller has — code editor, CLI, CI
// hook, future non-editor client. Caller-specific concepts (editor
// cursor, build context, request id, …) belong in tool args or in a
// separately discriminated context object so this audit shape stays
// uniform across every kind of caller.

const callsiteClientSchema = z
  .object({
    /** Free-form client identifier — whatever the MCP caller advertises
     *  in its `initialize` handshake. Web-chat synthesises `'web-chat'`. */
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().max(120).nullable().optional(),
  })
  .strict()

const callsiteAgentSchema = z
  .object({
    slug: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
  })
  .strict()

const callsiteToolSchema = z
  .object({
    /** `'inspect_codebase'` / a `bridge_tools.name` value / `'chat'`
     *  for web-chat runs. */
    name: z.string().trim().min(1).max(120),
  })
  .strict()

const callsiteRepoSchema = z
  .object({
    /** Operator-friendly repo label (`agent_repos.role` or URL tail). */
    label: z.string().trim().max(200).nullable().optional(),
    remote_url: z.string().trim().max(2_000).nullable().optional(),
    branch: z.string().trim().max(200).nullable().optional(),
    /** Caller-supplied workspace folder name. */
    local_folder: z.string().trim().max(200).nullable().optional(),
  })
  .strict()

export const callsiteSchema = z
  .object({
    client: callsiteClientSchema,
    agent: callsiteAgentSchema,
    tool: callsiteToolSchema,
    /** Populated for inspect_codebase + custom bridge_tools that pass
     *  repo hints; null for web-chat or runs that don't supply one. */
    repo: callsiteRepoSchema.nullable().optional(),
    /** ISO-8601 of when dispatch fired. */
    started_at: z.iso.datetime(),
  })
  .strict()

export type Callsite = z.infer<typeof callsiteSchema>

/**
 * Render the per-run `Callsite` as a quiet single-line metadata prefix
 * to prepend to the user prompt. Returns the empty string when no
 * callsite was supplied so callers can `formatCallsiteBlock(...) + prompt`
 * unconditionally.
 *
 * Format: a single italic line — `_Request origin: <client> · <agent>_`
 * — followed by a blank line, then the user query. Subtle on purpose:
 *
 *   - No `##` heading (was pattern-matching to "this is response
 *     context, give the answer" on weaker models).
 *   - No `---` separator (same reason).
 *   - No markdown list (looked like instructions).
 *   - **No `tool:` line.** That field was being misread by Qwen-class
 *     local models as "the tool has already been invoked, just answer
 *     the question" — the agent then skipped wrapper calls entirely
 *     and answered from training knowledge. Dropped from the prompt;
 *     still available in `runs.callsite_json` for audit + the /logs
 *     badge.
 *   - No `repo` line in the prompt (the IDE hint line already prepends
 *     repo info; duplicating it adds noise).
 *   - No `started_at` (operator skills don't text-match against it;
 *     it's available on the row for /logs).
 *
 * Operator skills can still text-match against `Request origin:` /
 * the client name to vary behavior by source ("if origin contains
 * 'web-chat', use friendly tone; if 'cursor-vscode', terse code").
 *
 * Lives in shared (not the dispatcher) so the bridge handler and the
 * web-chat backend route can both prepend BEFORE persisting
 * `runs.input_prompt`. The dispatcher stays a dumb transport.
 */
/**
 * Sentinel comment used to fence every server-injected prompt
 * enrichment (callsite, attached-files note, eager pre-fetch) so the
 * frontend can strip them when rendering the user bubble. Format:
 *
 *     <!-- ab:enrichment kind=<name> -->
 *     ...body...
 *     <!-- /ab:enrichment -->
 *
 * Chosen because:
 *   - HTML comments are valid markdown but render to nothing in any
 *     viewer (including the rare case the operator pastes the prompt
 *     somewhere else).
 *   - LLMs treat them as markup, not content — none of the local
 *     models we test against echo them back or "react" to them.
 *   - Easy to regex-strip without false-positive-matching real user
 *     text (no one types `<!-- ab:enrichment` by hand).
 *
 * Wrap helpers below build the fence; `stripPromptEnrichments` is the
 * inverse used by the frontend on persisted prompts.
 */
const ENRICHMENT_OPEN = (kind: string): string =>
  `<!-- ab:enrichment kind=${kind} -->`
const ENRICHMENT_CLOSE = '<!-- /ab:enrichment -->'

/** Wrap a prompt-enrichment body in fence markers. Trims so callers
 *  don't have to think about leading/trailing whitespace, and appends
 *  a blank line so adjacent blocks have visual separation in the
 *  LLM's view.
 *
 *  Any literal closing marker found inside `body` is masked first —
 *  otherwise an operator-uploaded file whose chunk contains the
 *  string `<!-- /ab:enrichment -->` would prematurely terminate the
 *  fence, and `stripPromptEnrichments` would cut at the wrong point
 *  and leak the rest of the prompt body into the chat bubble.
 *  Replacing the literal with a sentinel (still HTML-comment so it
 *  stays invisible if anything renders the raw text later) keeps the
 *  fence boundary unambiguous. */
export function wrapPromptEnrichment(kind: string, body: string): string {
  const safe = body
    .trim()
    .replace(/<!--\s*\/?ab:enrichment[^>]*-->/g, '<!-- ab:enrichment-mask -->')
  return `${ENRICHMENT_OPEN(kind)}\n${safe}\n${ENRICHMENT_CLOSE}\n\n`
}

export function formatCallsiteBlock(callsite: Callsite | null): string {
  if (!callsite) return ''
  const clientLine = callsite.client.version
    ? `${callsite.client.name} v${callsite.client.version}`
    : callsite.client.name
  return wrapPromptEnrichment(
    'callsite',
    `_Request origin: ${clientLine} · ${callsite.agent.slug}_`,
  )
}

/**
 * Strip every server-injected enrichment block from a persisted
 * `runs.input_prompt` so the UI can render a clean user bubble.
 *
 * Strips, in order:
 *   1. Fenced blocks `<!-- ab:enrichment ... --> ... <!-- /ab:enrichment -->`.
 *   2. Legacy callsite line `_Request origin: ..._` at the start of
 *      the prompt — needed because rows persisted before the fence
 *      markers shipped don't have the wrapper. Idempotent and a
 *      no-op when neither pattern is present.
 *   3. Leading whitespace left behind after the strip.
 */
export function stripPromptEnrichments(prompt: string): string {
  let out = prompt.replace(
    /<!--\s*ab:enrichment[^>]*-->[\s\S]*?<!--\s*\/ab:enrichment\s*-->\s*/g,
    '',
  )
  // Legacy: pre-fence callsite block at the start of the prompt.
  out = out.replace(/^_Request origin:[^\n]*_\n+/, '')
  return out.replace(/^\s+/, '')
}

/**
 * @deprecated Use {@link stripPromptEnrichments} — it covers the
 * fenced blocks shipped after the prompt-enrichment marker change in
 * addition to the legacy callsite-only format this older helper
 * handled. Kept as a thin alias so external callers don't break
 * mid-rollout.
 */
export function stripCallsiteBlock(prompt: string): string {
  return stripPromptEnrichments(prompt)
}

export const runListRowSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentSlug: z.string(),
  agentName: z.string(),
  status: z.enum(runStatuses),
  source: z.enum(runSources),
  streamId: z.string(),
  /** Truncated to `RUN_LIST_PREVIEW_CHARS`; full prompt via per-run detail. */
  inputPromptPreview: z.string(),
  /** Truncated; `null` until the dispatcher writes `output_summary`. */
  outputSummaryPreview: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nullable(),
  /**
   * Token accounting from the LLM provider's `usage` field. Both
   * nullable: errored runs may not get a usage object, and some local
   * OpenAI-compatible servers don't echo usage at all. Powers the
   * per-thread cumulative footer + the run-history token column.
   */
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  /**
   * Always-on per-run provenance (`client + agent + tool + repo? +
   * cursor? + started_at`). Null only on legacy rows that pre-date
   * the column. Surfaced as a badge on the run row in `/logs`.
   */
  callsite: callsiteSchema.nullable(),
})

export type RunListRow = z.infer<typeof runListRowSchema>

export const runListQuerySchema = z
  .object({
    source: z.enum(runListSourceFilters).optional(),
    /** Cap at 100 to keep the response bounded; default 50. */
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /**
     * Specific agent filter. Useful for the per-agent runs view that
     * the bridge view doesn't need but the future UI runs view does.
     */
    agentId: z.uuid().optional(),
  })
  .strict()

export type RunListQuery = z.infer<typeof runListQuerySchema>

export const runListResponseSchema = z.object({
  ok: z.literal(true),
  runs: z.array(runListRowSchema),
})

export type RunListResponse = z.infer<typeof runListResponseSchema>

/**
 * Per-run detail row. Same fields as `runListRowSchema` plus the FULL
 * (untruncated) prompt + output, used by `GET /api/runs/:id`. Distinct
 * from the list shape so a future "show 5 most recent runs" preview
 * surface keeps shipping a small payload, while the detail page gets
 * everything.
 */
export const runDetailRowSchema = runListRowSchema
  .omit({ inputPromptPreview: true, outputSummaryPreview: true })
  .extend({
    inputPrompt: z.string(),
    outputSummary: z.string().nullable(),
  })

export type RunDetailRow = z.infer<typeof runDetailRowSchema>

/**
 * One row from `run_events`. Mirrors the SSE `RunEvent` envelope shape
 * but with persisted `id` (bigint serialised as string for JSON safety
 * — `bigserial` overflows `Number` past 2^53). The `payloadJson` field
 * is whatever the producer wrote at insert time; consumers should
 * treat it as opaque and parse against the producer's known shapes
 * when displaying.
 */
export const runDetailEventSchema = z.object({
  id: z.string(),
  ts: z.iso.datetime(),
  kind: z.string(),
  payload: z.unknown().nullable(),
})

export type RunDetailEvent = z.infer<typeof runDetailEventSchema>

export const runDetailResponseSchema = z.object({
  ok: z.literal(true),
  run: runDetailRowSchema,
  events: z.array(runDetailEventSchema),
})

export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>

/**
 * Run-detail responses elide any single event payload larger than this
 * (serialized bytes) to a {@link ElidedRunEventPayload} marker, so a run
 * with several full inspection reports / model-request bodies doesn't ship
 * hundreds of KB up front. The UI fetches the full payload on demand via
 * `GET /api/runs/:id/events/:eventId/payload`.
 */
export const RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES = 2048 as const

/**
 * Placeholder swapped in for an over-cap event payload in the run-detail
 * list. The distinctive `__abElided` key can't collide with a real producer
 * payload (no wrapper writes it); `bytes` is the full serialized size for the
 * UI. The index signature carries the preserved structural fields (see
 * {@link ELIDE_PRESERVE_KEYS}).
 */
export interface ElidedRunEventPayload {
  readonly __abElided: true
  readonly bytes: number
  readonly kind: string
  readonly [key: string]: unknown
}

/**
 * Small structural fields kept inline when a payload is elided, so the
 * timeline's pairing (`stepIndex` for model turns, `toolCallId` for tool
 * calls) and labels survive. Everything else is dropped and lazy-loaded.
 */
export const ELIDE_PRESERVE_KEYS = [
  'stepIndex',
  'toolCallId',
  'toolName',
  'wrapperName',
  'tool',
  'purpose',
  'repoLabel',
  'model',
  'finishReason',
] as const

/** Narrow an event payload to the elided-marker shape. */
export function isElidedRunEventPayload(
  payload: unknown,
): payload is ElidedRunEventPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { __abElided?: unknown }).__abElided === true
  )
}

/**
 * Elide an over-cap run-event `payload` to an {@link ElidedRunEventPayload}
 * marker (payloads at or under {@link RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES} pass
 * through unchanged), keeping the {@link ELIDE_PRESERVE_KEYS} fields. Pure; in
 * shared so the backend route and the smoke share one implementation.
 */
export function elideRunEventPayload(payload: unknown, kind: string): unknown {
  if (payload === null || payload === undefined) return payload
  const bytes = JSON.stringify(payload).length
  if (bytes <= RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES) return payload
  const preserved: Record<string, unknown> = {}
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>
    for (const k of ELIDE_PRESERVE_KEYS) {
      if (k in obj) preserved[k] = obj[k]
    }
  }
  return {
    __abElided: true,
    bytes,
    kind,
    ...preserved,
  } satisfies ElidedRunEventPayload
}

/** `GET /api/runs/:id/events/:eventId/payload` response. */
export const runEventPayloadResponseSchema = z.object({
  ok: z.literal(true),
  payload: z.unknown().nullable(),
})

export type RunEventPayloadResponse = z.infer<
  typeof runEventPayloadResponseSchema
>

/**
 * `POST /api/runs/authorize-required` — given a batch of run ids, return the
 * external-MCP connections each run flagged as needing re-authorization (from
 * the persisted `run.mcp.authorize_required` events). Lets the chat
 * reconstruct the "Reconnect" notice durably (after reload) and reliably
 * (when the live SSE frame was missed on a warm-cache run), without replaying
 * the whole event stream.
 */
export const runAuthorizeRequiredQuerySchema = z.object({
  runIds: z.array(z.uuid()).max(500),
})
export type RunAuthorizeRequiredQuery = z.infer<
  typeof runAuthorizeRequiredQuerySchema
>

export const runAuthorizeRequiredConnectionSchema = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
})
export type RunAuthorizeRequiredConnection = z.infer<
  typeof runAuthorizeRequiredConnectionSchema
>

export const runAuthorizeRequiredResponseSchema = z.object({
  ok: z.literal(true),
  /** Keyed by runId; only runs with ≥1 flagged connection appear. */
  byRun: z.record(
    z.string(),
    z.array(runAuthorizeRequiredConnectionSchema),
  ),
})
export type RunAuthorizeRequiredResponse = z.infer<
  typeof runAuthorizeRequiredResponseSchema
>

/**
 * `POST /api/runs/thread-authorize-required` — given a chat thread id (its
 * Mastra thread id), return the external-MCP connections that thread's runs
 * flagged as needing re-authorization and that haven't been reconnected since.
 * Lets the chat rebuild the "Reconnect" notice on a thread/tab switch, where
 * the reloaded messages carry no runId to key the per-run endpoint on.
 */
export const threadAuthorizeRequiredQuerySchema = z.object({
  threadId: z.string().min(1).max(200),
})
export type ThreadAuthorizeRequiredQuery = z.infer<
  typeof threadAuthorizeRequiredQuerySchema
>

export const threadAuthorizeRequiredResponseSchema = z.object({
  ok: z.literal(true),
  connections: z.array(runAuthorizeRequiredConnectionSchema),
})
export type ThreadAuthorizeRequiredResponse = z.infer<
  typeof threadAuthorizeRequiredResponseSchema
>
