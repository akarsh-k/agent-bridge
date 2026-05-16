/**
 * `useTimeAgo` — render a "5s ago" / "12m ago" / "3h ago" label that
 * ticks forward on its own (every 30s) so the page stops lying after
 * the user has been reading for a few minutes. React Compiler forbids
 * calling `Date.now()` during render (impure), so we route the clock
 * through `useSyncExternalStore`.
 *
 * The store is a single shared, reference-counted ticking clock —
 * `getSnapshot` returns a cached value that's only advanced inside
 * the interval. Returning a fresh `Date.now()` per call would make
 * React think the store mutated on every check and infinite-loop
 * (the bug this module exists to prevent).
 */

import { useSyncExternalStore } from 'react'

interface UseTimeAgoOptions {
  /** Placeholder for null / NaN dates. Default ''. */
  readonly fallback?: string
  /**
   * Coarse-grained label that skips the sub-minute bucket — sub-minute
   * times render as "just now" instead of "Xs ago", and the remaining
   * buckets round down (floor) rather than to nearest. Good for status
   * lines where second-level precision is noise. Default false.
   */
  readonly compact?: boolean
}

export function useTimeAgo(
  date: Date | null,
  options: UseTimeAgoOptions = {},
): string {
  const { fallback = '', compact = false } = options
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (!date) return fallback
  const ms = now - date.getTime()
  if (Number.isNaN(ms)) return fallback
  const round = compact ? Math.floor : Math.round
  if (compact) {
    if (ms < 60_000) return 'just now'
  } else {
    const sec = round(ms / 1000)
    if (sec < 60) return `${sec}s ago`
  }
  const min = round(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = round(ms / 3_600_000)
  if (hr < 24) return `${hr}h ago`
  const day = round(ms / 86_400_000)
  return `${day}d ago`
}

let cachedNow = Date.now()
const listeners = new Set<() => void>()
let intervalId: ReturnType<typeof setInterval> | null = null

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  if (intervalId === null) {
    intervalId = setInterval(() => {
      cachedNow = Date.now()
      for (const listener of listeners) listener()
    }, 30_000)
  }
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
}

function getSnapshot(): number {
  return cachedNow
}

function getServerSnapshot(): number {
  // Pre-hydration snapshot. We never actually SSR, but
  // useSyncExternalStore requires this callback to exist so the
  // pre-paint render doesn't try to call Date.now().
  return 0
}
