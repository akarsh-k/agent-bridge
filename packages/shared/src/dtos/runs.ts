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
