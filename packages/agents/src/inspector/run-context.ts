/**
 * Run-scoped context for inspector wrapper tools
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Mastra's tool-execute context exposes `agent.toolCallId` but not our
 * app-level `runId`, so the dispatcher threads runtime state via
 * AsyncLocalStorage. The dispatcher wraps the `for await (chunk of
 * output.fullStream)` loop with `inspectorRunContext.run({...}, ...)`;
 * any wrapper tool the LLM invokes during that iteration calls
 * `getInspectorRunContext()` and emits events via the helper below.
 *
 * No context = no event emission. Wrappers tolerate a missing context
 * gracefully (test scripts, smoke runs without a dispatcher) so the
 * `mountInspectorTools(...)` factory doesn't need a special test mode.
 *
 * AsyncLocalStorage is part of Node's `node:async_hooks` module and
 * propagates through every async resumption (await, .then, for-await,
 * setTimeout). It's the same primitive Mastra itself uses for tracing,
 * so we're not introducing a new mechanism.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { runsRepo } from '@agent-bridge/db'
import type { AttachedRepo, RunEvent } from '@agent-bridge/shared'
import type { EventBus } from '@agent-bridge/shared/event-bus'

import type { RunRedactor } from '../run-redactor.js'
import {
  resolveRepoFromHint,
  type MatchedSignal,
  type RepoResolveResult,
} from './repo-resolve.js'

// ─── Shape ───────────────────────────────────────────────────────────────

/**
 * Result of the bridge handler's pre-resolution of the IDE's structured
 * `inspect_codebase` hint. The bridge resolves once at run start (using
 * `remote_url` / `local_folder` / `repo_hint` from the IDE) and stuffs
 * the result here; wrappers consult this BEFORE their LLM-supplied
 * `repo_hint` arg.
 *
 * Why: the IDE knows the remote URL from `git remote get-url origin`,
 * which is the highest-fidelity signal we can get. Passing it through
 * structured plumbing avoids the LLM-as-translator step (e.g. the
 * model echoing `repo_hint: "\"react-stripe-js\""` with quote chars).
 *
 * `null` for chat-tab runs (no IDE handshake) and bridge runs where the
 * IDE didn't supply any hint signals. Wrappers fall back to their own
 * resolution path in that case.
 */
export interface IdePreResolvedRepo {
  readonly repo: AttachedRepo
  readonly matched_signal: MatchedSignal
}

export interface InspectorRunContext {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  readonly redactor: RunRedactor
  readonly runId: string
  /** Per-run channel `run:<uuid>` (chat panel) or `bridge:<uuid>` (IDE). */
  readonly streamId: string
  /** Per-agent fan-out channel `agent:<uuid>` (Activity panel). */
  readonly agentStreamId: string
  readonly agentId: string
  /** See `IdePreResolvedRepo`. `null` outside the bridge path. */
  readonly idePreResolvedRepo: IdePreResolvedRepo | null
}

const storage = new AsyncLocalStorage<InspectorRunContext>()

/**
 * Run a callback with the supplied context active. Any inspector
 * wrapper invoked inside (directly or through Mastra's tool-execute
 * machinery) sees this context via `getInspectorRunContext()`. Returns
 * the callback's resolved value.
 */
export function runWithInspectorContext<T>(
  ctx: InspectorRunContext,
  cb: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, cb)
}

/**
 * Read the current context. Returns `null` outside any
 * `runWithInspectorContext(...)` block — wrappers should treat that as
 * "no telemetry surface, run silently".
 */
export function getInspectorRunContext(): InspectorRunContext | null {
  return storage.getStore() ?? null
}

// ─── Event emission ──────────────────────────────────────────────────────

/**
 * Mirrors the dispatcher's `publishAndAudit` pattern: scrub the event
 * through the per-run redactor, publish to the per-run channel, fan out
 * to the per-agent channel, append a `run_events` audit row. Failures
 * are logged but never thrown — telemetry must NOT take down a wrapper.
 *
 * The `event.streamId` is overwritten by the caller via the context
 * fields so wrapper code only has to supply `kind` + `data` + `ts`.
 *
 * `null` context (testing / smoke without dispatcher): no-op, returns
 * resolved void. Logs nothing — production code paths always have a
 * context, so a missing one is intentional.
 */
export async function emitInspectorEvent(
  kind: RunEvent['kind'],
  data: unknown,
): Promise<void> {
  const ctx = getInspectorRunContext()
  if (!ctx) return
  const ts = Date.now()
  const event: RunEvent = {
    kind,
    ts,
    streamId: ctx.streamId,
    data,
  }
  const scrubbed = ctx.redactor.redactEvent(event)
  try {
    await ctx.eventBus.publish(scrubbed)
    await ctx.eventBus.publish({ ...scrubbed, streamId: ctx.agentStreamId })
  } catch (err) {
    console.error(
      `[inspector] eventBus.publish failed (kind=${kind}, run=${ctx.runId}):`,
      err,
    )
  }
  try {
    await runsRepo.appendEvent(ctx.db, {
      runId: ctx.runId,
      kind: scrubbed.kind,
      payload: (scrubbed.data as Record<string, unknown>) ?? null,
      ts: new Date(scrubbed.ts),
    })
  } catch (err) {
    console.error(
      `[inspector] audit insert failed (kind=${kind}, run=${ctx.runId}):`,
      err,
    )
  }
}

// ─── Wrapper-side resolver helper ────────────────────────────────────────

/**
 * Thin wrapper around `resolveRepoFromHint` that automatically pulls
 * the bridge-handler pre-resolved repo out of run context and threads
 * it as a `fallback`. Wrappers call this instead of `resolveRepoFromHint`
 * directly so the IDE's structured signal flows down without each
 * wrapper having to know about run context.
 */
export function resolveRepoForWrapper(args: {
  readonly repos: readonly AttachedRepo[]
  readonly hint: string | null | undefined
  readonly allowAll?: boolean
}): RepoResolveResult {
  const ctx = getInspectorRunContext()
  return resolveRepoFromHint({
    repos: args.repos,
    hint: args.hint,
    allowAll: args.allowAll,
    fallback: ctx?.idePreResolvedRepo ?? null,
  })
}

// ─── Preview helpers ─────────────────────────────────────────────────────

/**
 * Truncate any value to a printable preview, capped at the byte limit
 * promised in `INSPECTOR_PREVIEW_BYTES_CAP` (events.ts). Returns
 * `{ preview, truncated }` so callers can stamp `truncated` on the
 * event payload without re-measuring.
 */
export function previewJson(
  value: unknown,
  cap: number,
): { preview: string; truncated: boolean } {
  let raw: string
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    raw = String(value)
  }
  if (raw.length <= cap) return { preview: raw, truncated: false }
  return {
    preview: raw.slice(0, Math.max(cap - 1, 0)) + '…',
    truncated: true,
  }
}
