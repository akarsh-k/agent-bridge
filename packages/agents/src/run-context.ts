/**
 * Per-run async context propagated through tool executions.
 *
 * `buildAgent`'s `BuiltAgent` cache is keyed by agent id, so the same
 * Agent instance handles many turns across many threads. Anything that
 * varies per-turn — the current thread id, chat-scope file
 * attachments, operator-explicit file references via `@`-mention —
 * can't live in the agent's closure. AsyncLocalStorage does the
 * heavy lifting: the dispatcher wraps `agent.stream()` with a
 * `runContext.run({...}, () => ...)` and tools call
 * `runContext.getStore()` to read.
 *
 * Tools should treat the store as best-effort context — if it's
 * unset (e.g. the tool is invoked outside a dispatched run, as in
 * the smoke test), they fall back to the build-time defaults.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** What the dispatcher publishes to per-run async context. */
export interface RunContextStore {
  /** Mastra thread id this run is firing on. `null` for memory-
   *  disabled agents where no thread row was created. */
  readonly threadId: string | null
  /** Files attached at chat scope (drag-dropped into the conversation).
   *  Merged into `search_knowledge`'s scope alongside the agent's
   *  `agent_files` attachments. Empty list when no thread files. */
  readonly threadFiles: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description: string
  }>
  /** Files the operator explicitly referenced this turn via
   *  `referencedFileIds` (the @-mention path). When non-empty, the
   *  tool clamps its default scope to these ids (a hard filter) and
   *  the per-burst cap is raised since multi-mention queries
   *  legitimately fan out. */
  readonly referencedFileIds: ReadonlyArray<string>
}

const EMPTY_STORE: RunContextStore = {
  threadId: null,
  threadFiles: [],
  referencedFileIds: [],
}

const storage = new AsyncLocalStorage<RunContextStore>()

/** Read the current run's context. Returns an empty store when no
 *  run is active (tool called outside a dispatched run). */
export function getRunContext(): RunContextStore {
  return storage.getStore() ?? EMPTY_STORE
}

/** Wrap `fn` so any AsyncLocalStorage reads inside resolve to
 *  `store`. The dispatcher uses this around `agent.stream()` so
 *  every tool the LLM kicks off sees the per-run scope. */
export function withRunContext<T>(store: RunContextStore, fn: () => T): T {
  return storage.run(store, fn)
}
