/**
 * Time-throttle helper for the per-line progress events the
 * clone / index / wiki jobs publish.
 *
 * Why: gitnexus's analyze pass on a big repo emits one stderr line
 * per file/symbol (10k+ lines is normal on sqlalchemy-scale repos).
 * Each line used to publish a `repo.*.progress` event over the event
 * bus and persist a row in `worker_events`. The repo-detail page
 * then hydrates the entire history on every mount + re-derives the
 * collapsed log feed on every render, which on a 10k-event run
 * makes the page laggy.
 *
 * The fix is to coalesce: at most one progress event per
 * `minIntervalMs` (default 1 s). Intermediate lines are dropped on
 * the floor — they were noise (each "Receiving objects: NN%" line
 * supersedes the previous one). Terminal lifecycle events
 * (`repo.*.ok` / `*.fail` / `*.started`) are published via different
 * code paths so they ride through unaffected.
 *
 * Errors are NOT throttled: a caller hooks `looksLikeFatalLine`
 * detection in front of the throttler so the final error message
 * captured by the job still reflects every line, even the dropped
 * ones.
 */

export interface ProgressThrottle {
  /** Returns true if the caller should publish the event now;
   *  false if it should drop the line. Updates the internal "last
   *  emitted at" timestamp on a `true` result. */
  shouldEmit(): boolean
  /** Count of lines suppressed since the last emit. Useful for
   *  occasional debugging — callers don't have to read it. */
  droppedSinceLastEmit(): number
  /** Resets the throttler so the next call always emits. Use this
   *  after the underlying subprocess closes so the final "Done"
   *  line surfaces immediately even if it lands inside the throttle
   *  window. (Most jobs don't need this — the lifecycle `.ok`/`.fail`
   *  event is what marks completion, not a progress line.) */
  forceNext(): void
}

export function makeProgressThrottle(minIntervalMs = 1000): ProgressThrottle {
  let lastAt = 0
  let dropped = 0
  return {
    shouldEmit(): boolean {
      const now = Date.now()
      if (now - lastAt < minIntervalMs) {
        dropped++
        return false
      }
      lastAt = now
      dropped = 0
      return true
    },
    droppedSinceLastEmit(): number {
      return dropped
    },
    forceNext(): void {
      lastAt = 0
    },
  }
}
