/**
 * Minimal history-based router (no JSX / components in this file — the
 * `<Link>` component lives in `./link.tsx` so that Vite's fast-refresh
 * plugin stays happy).
 *
 * Why no library: with two routes (`/agents`, `/agents/:id`) pulling in
 * React Router (or similar) costs more in bundle size and mental overhead
 * than it's worth. This file is <60 lines and easy to delete when we
 * outgrow it.
 *
 * How it works:
 *   - Subscribes to `popstate` and an internal `pushState` event so both
 *     back/forward navigation and programmatic `navigate()` trigger a
 *     React re-render via `useSyncExternalStore`.
 *   - `matchAgentDetail` is the one match-helper we need; add more as
 *     routes appear.
 *
 * Vite dev server auto-serves `index.html` on non-asset paths, so
 * deep-linking to `/agents/<uuid>` works without extra config.
 */

import { useSyncExternalStore } from 'react'

export const PUSH_EVENT = 'agentbridge:pushstate'

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback)
  window.addEventListener(PUSH_EVENT, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(PUSH_EVENT, callback)
  }
}

/** Read the current path. Re-renders the caller whenever it changes. */
export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  )
}

/** Programmatic navigation. Fires the same event `<Link>` uses internally. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search
  if (to === current && !opts.replace) return
  if (opts.replace) {
    window.history.replaceState({}, '', to)
  } else {
    window.history.pushState({}, '', to)
  }
  window.dispatchEvent(new Event(PUSH_EVENT))
}

/**
 * Match `/agents/<uuid>` and return the id, or `null` otherwise. One helper
 * per concrete route; avoids a generic regex-matcher and keeps intent
 * obvious at call sites.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function matchAgentDetail(path: string): { id: string } | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'agents') return null
  const id = parts[1]!
  if (!UUID_RE.test(id)) return null
  return { id }
}
