/**
 * `GET /api/runs?source=bridge|ui&limit=50&agentId=<uuid>` — global
 * runs feed.
 *
 * Phase 5 introduces this endpoint to power the IDE bridge view's
 * "live IDE invocations" feed (filters `source=bridge`). Built generic
 * (not bridge-specific) so a future Phase 6 "all runs" UI view can
 * reuse the same shape with `source=ui`.
 *
 * Source-by-prefix:
 *   `runs.stream_id` carries `'run:<uuid>'` for UI-chat runs and
 *   `'bridge:<uuid>'` for IDE-bridge runs (Phase 5 source-tagging
 *   decision — no `runs.source` column needed). The query translates
 *   `source=ui` → `LIKE 'run:%'` and `source=bridge` → `LIKE 'bridge:%'`.
 *   `unknown` is reserved for forward-compat and isn't a valid filter.
 *
 * Pagination:
 *   Limit-only (max 100, default 50), ordered `started_at DESC`. Cursor
 *   pagination would let the UI scroll back further, but for a
 *   "recent IDE activity" feed 50 entries is comfortable. Adding a
 *   cursor later is additive — `before=<runId>` would translate to
 *   `WHERE (started_at, id) < (cursor.started_at, cursor.id)`.
 *
 * Joins:
 *   We `LEFT JOIN agents` so each row carries the agent's
 *   `slug` + `name`. Agents are ON DELETE CASCADE on `runs`, so the
 *   join can never miss in practice; `LEFT JOIN` keeps the response
 *   defensive against a future schema change.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { and, asc, desc, eq, like } from 'drizzle-orm'
import { z } from 'zod'
import {
  RUN_LIST_PREVIEW_CHARS,
  runListQuerySchema,
  type RunDetailEvent,
  type RunDetailResponse,
  type RunDetailRow,
  type RunListResponse,
  type RunListRow,
  type RunSource,
  type RunStatus,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpValidationError } from '../lib/errors.js'

const DEFAULT_LIMIT = 50

/**
 * Translate a UI-facing `source` filter into a SQL `LIKE` pattern.
 * The `:` suffix matters — it pins the prefix so a future
 * `'runtime:'` source can't accidentally match `source=run`.
 */
function streamIdPrefixForSource(
  source: 'ui' | 'bridge',
): string {
  return source === 'bridge' ? 'bridge:%' : 'run:%'
}

/**
 * Derive the surfaceable `source` from a stored `stream_id`. Anything
 * outside the known prefixes maps to `'unknown'` — list rows include
 * the raw `streamId` too, so the UI can still render unfamiliar
 * prefixes if needed.
 */
function deriveSource(streamId: string): RunSource {
  if (streamId.startsWith('bridge:')) return 'bridge'
  if (streamId.startsWith('run:')) return 'ui'
  return 'unknown'
}

function preview(value: string | null): string | null {
  if (value === null) return null
  if (value.length <= RUN_LIST_PREVIEW_CHARS) return value
  return value.slice(0, RUN_LIST_PREVIEW_CHARS - 1) + '…'
}

export const runsRouter = new Hono().get(
  '/',
  zValidator('query', runListQuerySchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const q = c.req.valid('query')
    const limit = q.limit ?? DEFAULT_LIMIT
    const handle = getDb()

    const filters = []
    if (q.source) {
      filters.push(like(schema.runs.streamId, streamIdPrefixForSource(q.source)))
    }
    if (q.agentId) {
      filters.push(eq(schema.runs.agentId, q.agentId))
    }

    // Drizzle's `where(and(...))` spread requires at least 2 args; for
    // single-filter queries we pass the predicate directly. Using
    // `undefined` for "no filter" lets the chain stay one expression.
    const whereClause =
      filters.length === 0
        ? undefined
        : filters.length === 1
          ? filters[0]
          : and(...filters)

    const rows = await handle.db
      .select({
        id: schema.runs.id,
        agentId: schema.runs.agentId,
        status: schema.runs.status,
        streamId: schema.runs.streamId,
        inputPrompt: schema.runs.inputPrompt,
        outputSummary: schema.runs.outputSummary,
        errorMessage: schema.runs.errorMessage,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        promptTokens: schema.runs.promptTokens,
        completionTokens: schema.runs.completionTokens,
        agentSlug: schema.agents.slug,
        agentName: schema.agents.name,
      })
      .from(schema.runs)
      .leftJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
      .where(whereClause)
      .orderBy(desc(schema.runs.startedAt))
      .limit(limit)

    const out: RunListRow[] = rows.map((r) => {
      const startedAt = r.startedAt.toISOString()
      const finishedAt = r.finishedAt ? r.finishedAt.toISOString() : null
      const durationMs = r.finishedAt
        ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime())
        : null
      // The LEFT JOIN returns null agent fields if the agent was
      // deleted — defensive fallbacks keep the wire shape valid even
      // for orphan rows that the FK cascade should have caught.
      return {
        id: r.id,
        agentId: r.agentId,
        agentSlug: r.agentSlug ?? '<deleted>',
        agentName: r.agentName ?? '(deleted agent)',
        status: r.status as RunStatus,
        source: deriveSource(r.streamId),
        streamId: r.streamId,
        inputPromptPreview: preview(r.inputPrompt) ?? '',
        outputSummaryPreview: preview(r.outputSummary),
        errorMessage: r.errorMessage,
        startedAt,
        finishedAt,
        durationMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
      }
    })

    const body: RunListResponse = { ok: true, runs: out }
    return c.json(body)
  },
).get(
  '/:id',
  zValidator(
    'param',
    z.object({ id: z.uuid() }),
    (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    },
  ),
  async (c) => {
    const { id } = c.req.valid('param')
    const handle = getDb()

    // One run row + LEFT JOIN agents for slug/name. Same defensive
    // join the list endpoint does.
    const [row] = await handle.db
      .select({
        id: schema.runs.id,
        agentId: schema.runs.agentId,
        status: schema.runs.status,
        streamId: schema.runs.streamId,
        inputPrompt: schema.runs.inputPrompt,
        outputSummary: schema.runs.outputSummary,
        errorMessage: schema.runs.errorMessage,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
        promptTokens: schema.runs.promptTokens,
        completionTokens: schema.runs.completionTokens,
        agentSlug: schema.agents.slug,
        agentName: schema.agents.name,
      })
      .from(schema.runs)
      .leftJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
      .where(eq(schema.runs.id, id))
      .limit(1)

    if (!row) {
      return c.json({ ok: false, code: 'not_found' as const, message: `Run ${id} not found` }, 404)
    }

    // All events for this run, oldest first (the timeline reads top-down).
    // Index `run_events_run_ts_idx` covers (run_id, ts) so this is cheap
    // even with thousands of events on one run.
    const eventRows = await handle.db
      .select({
        id: schema.runEvents.id,
        ts: schema.runEvents.ts,
        kind: schema.runEvents.kind,
        payloadJson: schema.runEvents.payloadJson,
      })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, id))
      .orderBy(asc(schema.runEvents.ts), asc(schema.runEvents.id))

    const startedAt = row.startedAt.toISOString()
    const finishedAt = row.finishedAt ? row.finishedAt.toISOString() : null
    const durationMs = row.finishedAt
      ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime())
      : null

    const run: RunDetailRow = {
      id: row.id,
      agentId: row.agentId,
      agentSlug: row.agentSlug ?? '<deleted>',
      agentName: row.agentName ?? '(deleted agent)',
      status: row.status as RunStatus,
      source: deriveSource(row.streamId),
      streamId: row.streamId,
      inputPrompt: row.inputPrompt ?? '',
      outputSummary: row.outputSummary,
      errorMessage: row.errorMessage,
      startedAt,
      finishedAt,
      durationMs,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    }

    const events: RunDetailEvent[] = eventRows.map((e) => ({
      // bigserial — stringify so JSON.parse on the wire doesn't lose
      // precision past 2^53. The UI uses it as an opaque key.
      id: e.id.toString(),
      ts: e.ts.toISOString(),
      kind: e.kind,
      payload: e.payloadJson,
    }))

    const body: RunDetailResponse = { ok: true, run, events }
    return c.json(body)
  },
)

export type RunsRouter = typeof runsRouter
