/**
 * Boilerplate emits for inspector wrapper tools
 * (`docs/ARCHITECTURE.md §10`). Every wrapper emits the same opening (`inspector.tool.called`),
 * the same per-gitnexus-call pair (`inspector.gitnexus.called` /
 * `.gitnexus.result`), and the same closing
 * (`inspector.report.built` + `inspector.tool.result`). Inlined in
 * `find_in_codebase` first; extracted here once we had three more
 * wrappers about to repeat the pattern.
 *
 * Each helper:
 *   - reads the run context via `getInspectorRunContext()` (no-op
 *     when called outside a `runWithInspectorContext` block — same
 *     contract as `emitInspectorEvent`),
 *   - feeds redacted previews through `previewJson` capped at
 *     `INSPECTOR_PREVIEW_BYTES_CAP`,
 *   - returns small handles the wrapper uses to stamp duration on
 *     the matching `result` event.
 */

import { runsRepo } from '@agent-bridge/db'
import {
  INSPECTOR_PREVIEW_BYTES_CAP,
  type InspectorFallbackPayload,
  type InspectorGitnexusCalledPayload,
  type InspectorGitnexusResultPayload,
  type InspectorKeywordCalledPayload,
  type InspectorKeywordResultPayload,
  type InspectorReportBuiltPayload,
  type InspectorToolCalledPayload,
  type InspectorToolResultPayload,
  type InspectorWrapperName,
} from '@agent-bridge/shared'

import {
  emitInspectorEvent,
  getInspectorRunContext,
  previewJson,
} from './run-context.js'
import type { CodebaseInspectionReport } from './types.js'

// ─── Tool-level open/close ───────────────────────────────────────────────

export interface ToolCallHandle {
  readonly runId: string
  readonly startedAt: number
}

export async function emitToolCalled(
  wrapperName: InspectorWrapperName,
  args: unknown,
): Promise<ToolCallHandle> {
  const ctx = getInspectorRunContext()
  const runId = ctx?.runId ?? ''
  const argsPreview = previewJson(args, INSPECTOR_PREVIEW_BYTES_CAP)
  await emitInspectorEvent('inspector.tool.called', {
    runId,
    wrapperName,
    argsPreview: argsPreview.preview,
    truncated: argsPreview.truncated,
  } satisfies InspectorToolCalledPayload)
  return { runId, startedAt: Date.now() }
}

export async function emitToolResult(args: {
  handle: ToolCallHandle
  wrapperName: InspectorWrapperName
  status: InspectorToolResultPayload['status']
  message?: string
}): Promise<void> {
  const payload: InspectorToolResultPayload = {
    runId: args.handle.runId,
    wrapperName: args.wrapperName,
    durationMs: Date.now() - args.handle.startedAt,
    status: args.status,
    ...(args.message ? { message: args.message } : {}),
  }
  await emitInspectorEvent('inspector.tool.result', payload)
}

export async function emitReportBuilt(
  wrapperName: InspectorWrapperName,
  report: CodebaseInspectionReport,
): Promise<void> {
  const ctx = getInspectorRunContext()
  await emitInspectorEvent('inspector.report.built', {
    runId: ctx?.runId ?? '',
    wrapperName,
    fileCount: report.files.length,
    chunkCount: report.files.reduce((acc, f) => acc + f.chunks.length, 0),
    tokensUsed: report.tokens_used,
    tokensCap: report.tokens_cap,
    truncated: report.warnings.some((w) => w.includes('to fit under')),
    ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}),
  } satisfies InspectorReportBuiltPayload)

  // Persist to `runs.codebase_inspection_reports_json`
  // (`docs/ARCHITECTURE.md §10`). Runs unconditionally — chat-tab
  // tool-call cards consume the same column, and the IDE bridge reads it
  // directly. Append handles the 14 KiB total cap with oldest-eviction.
  // Failure is logged but never thrown — telemetry must not take down
  // the wrapper's main result path.
  if (ctx) {
    try {
      await runsRepo.appendCodebaseInspectionReport(ctx.db, ctx.runId, report)
    } catch (err) {
      console.error(
        `[inspector] runs.codebase_inspection_reports_json append failed (run=${ctx.runId}, wrapper=${wrapperName}):`,
        err,
      )
    }
  }
}

export async function emitFallback(
  wrapperName: InspectorWrapperName,
  reason: string,
): Promise<void> {
  await emitInspectorEvent('inspector.fallback', {
    runId: getInspectorRunContext()?.runId ?? '',
    wrapperName,
    reason,
  } satisfies InspectorFallbackPayload)
}

// ─── Per-gitnexus-call wrapper ───────────────────────────────────────────

/**
 * Wrap a single gitnexus call in a `inspector.gitnexus.called/result`
 * pair. The caller hands a thunk that calls one of the
 * `callGitnexus*` helpers; we time it, redact the args + result preview,
 * emit both events, and return the result (or rethrow).
 *
 * Errors are NOT swallowed — the caller decides whether a single failed
 * call should abort the wrapper or just be folded into `warnings`.
 */
export async function withGitnexusCall<T>(
  wrapperName: InspectorWrapperName,
  tool: string,
  args: unknown,
  thunk: () => Promise<T>,
): Promise<T> {
  const runId = getInspectorRunContext()?.runId ?? ''
  const argsPreview = previewJson(args, INSPECTOR_PREVIEW_BYTES_CAP)
  await emitInspectorEvent('inspector.gitnexus.called', {
    runId,
    wrapperName,
    tool,
    argsPreview: argsPreview.preview,
    truncated: argsPreview.truncated,
  } satisfies InspectorGitnexusCalledPayload)

  const startedAt = Date.now()
  try {
    const result = await thunk()
    const resultPreview = previewJson(result, INSPECTOR_PREVIEW_BYTES_CAP)
    await emitInspectorEvent('inspector.gitnexus.result', {
      runId,
      wrapperName,
      tool,
      durationMs: Date.now() - startedAt,
      resultPreview: resultPreview.preview,
      truncated: resultPreview.truncated,
      ok: true,
    } satisfies InspectorGitnexusResultPayload)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitInspectorEvent('inspector.gitnexus.result', {
      runId,
      wrapperName,
      tool,
      durationMs: Date.now() - startedAt,
      resultPreview: message.slice(0, INSPECTOR_PREVIEW_BYTES_CAP),
      truncated: message.length > INSPECTOR_PREVIEW_BYTES_CAP,
      ok: false,
    } satisfies InspectorGitnexusResultPayload)
    throw err
  }
}

// ─── Per-keyword-search wrapper ──────────────────────────────────────────

/**
 * Wrap a single `keywordSearch` invocation in a
 * `inspector.keyword.called/result` pair. Mirrors `withGitnexusCall`'s
 * shape so the Logs UI renders both retrieval paths side-by-side. The
 * caller hands a thunk that runs ripgrep; we time, redact, emit, and
 * return the hit count on success.
 *
 * Errors are caught here (unlike the gitnexus variant which rethrows)
 * because the caller is always set up to fold keyword failures into
 * `warnings` — ripgrep crashes shouldn't take down the wrapper, and
 * the parallel gitnexus call may still produce hits.
 */
export interface KeywordCallResult<T> {
  readonly ok: boolean
  readonly value: T | null
  readonly error?: string
}

export async function withKeywordCall<T extends { length: number }>(
  wrapperName: InspectorWrapperName,
  repoLabel: string,
  queries: readonly string[],
  thunk: () => Promise<T>,
): Promise<KeywordCallResult<T>> {
  const runId = getInspectorRunContext()?.runId ?? ''
  const queriesPreview = previewJson(queries, INSPECTOR_PREVIEW_BYTES_CAP)
  await emitInspectorEvent('inspector.keyword.called', {
    runId,
    wrapperName,
    repoLabel,
    queriesPreview: queriesPreview.preview,
    truncated: queriesPreview.truncated,
  } satisfies InspectorKeywordCalledPayload)

  const startedAt = Date.now()
  try {
    const result = await thunk()
    await emitInspectorEvent('inspector.keyword.result', {
      runId,
      wrapperName,
      repoLabel,
      durationMs: Date.now() - startedAt,
      hitCount: result.length,
      ok: true,
    } satisfies InspectorKeywordResultPayload)
    return { ok: true, value: result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitInspectorEvent('inspector.keyword.result', {
      runId,
      wrapperName,
      repoLabel,
      durationMs: Date.now() - startedAt,
      hitCount: null,
      ok: false,
      message: message.slice(0, INSPECTOR_PREVIEW_BYTES_CAP),
    } satisfies InspectorKeywordResultPayload)
    return { ok: false, value: null, error: message }
  }
}
