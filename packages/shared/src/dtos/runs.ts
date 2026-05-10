/**
 * Global runs-list DTOs. Browser-safe.
 *
 * `GET /api/runs?source=bridge|ui&limit=50` powers two surfaces:
 *   - The Phase 5 IDE-bridge view (filters `source=bridge`)
 *   - A future "all runs" UI view that the per-agent activity tab
 *     can promote to a global feed.
 *
 * Source is **derived from the `stream_id` prefix** at response time —
 * `'run:'` → `'ui'`, `'bridge:'` → `'bridge'`. We don't store source
 * as a column because the prefix already encodes it (Phase 5 design
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

// ─── Callsite (always-on, per-run) ──────────────────────────────────────
//
// Captured at run dispatch time — never user-supplied via the chat or IDE
// tool args. Composition order:
//   - bridge handlers build it from the MCP `initialize` clientInfo + the
//     dispatch-time agent record + the tool args the IDE LLM passed
//   - the chat backend builds a synthetic `{client: {name: 'web-chat'}}` shape
// Persisted to `runs.callsite_json` and injected as a `## Callsite` system
// message at the top of the run's message stack so operator skills can
// reference it (e.g. "if callsite.client.name = 'cursor', format X").

const callsiteClientSchema = z
  .object({
    /** `'cursor'`, `'claude-code'`, `'codex'`, `'web-chat'`, … */
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
    /** `'inspect_codebase'` / `'ask_agent'` / a `bridge_tools.name` value /
     *  `'chat'` for web-chat runs. */
    name: z.string().trim().min(1).max(120),
  })
  .strict()

const callsiteRepoSchema = z
  .object({
    /** Operator-friendly repo label (`agent_repos.role` or URL tail). */
    label: z.string().trim().max(200).nullable().optional(),
    remote_url: z.string().trim().max(2_000).nullable().optional(),
    branch: z.string().trim().max(200).nullable().optional(),
    /** IDE-supplied workspace folder name. */
    local_folder: z.string().trim().max(200).nullable().optional(),
  })
  .strict()

export const callsiteSchema = z
  .object({
    client: callsiteClientSchema,
    agent: callsiteAgentSchema,
    tool: callsiteToolSchema,
    /** Populated for inspect_codebase + custom bridge_tools that pass repo
     *  hints; left null for ask_agent and web-chat runs that don't supply one. */
    repo: callsiteRepoSchema.nullable().optional(),
    /** ISO-8601 of when dispatch fired. */
    started_at: z.iso.datetime(),
  })
  .strict()

export type Callsite = z.infer<typeof callsiteSchema>
