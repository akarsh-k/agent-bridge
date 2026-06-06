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
import { requestNavigation } from '../nav-guard'

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

/**
 * Programmatic navigation. Fires the same event `<Link>` uses internally.
 *
 * Routes through `requestNavigation` so a registered dirty-form guard
 * (see `lib/nav-guard`) can hold the navigation and surface the global
 * "unsaved changes" modal. Set `skipGuard: true` to bypass the guard
 * — used by callers that already consulted the guard themselves (e.g.
 * the agent detail page's tab switcher, where React state and URL
 * both have to flip together).
 */
export function navigate(
  to: string,
  opts: { replace?: boolean; skipGuard?: boolean } = {},
): void {
  const apply = () => {
    const current = window.location.pathname + window.location.search
    if (to === current && !opts.replace) return
    if (opts.replace) {
      window.history.replaceState({}, '', to)
    } else {
      window.history.pushState({}, '', to)
    }
    window.dispatchEvent(new Event(PUSH_EVENT))
  }
  if (opts.skipGuard) {
    apply()
  } else {
    requestNavigation(apply)
  }
}

/**
 * Match `/agents/<uuid>` and return the id, or `null` otherwise. One helper
 * per concrete route; avoids a generic regex-matcher and keeps intent
 * obvious at call sites.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Recognised sub-tabs for the agent detail page. Anything else
 * after the id falls through to "not found".
 */
// Active tabs: configure, resources, chat, scorecard, bridge.
// Legacy aliases (build, memory, tools, test) still match here so
// existing bookmarks resolve; the page-level dispatch redirects them
// to the new tab they were folded into.
const AGENT_TABS = [
  'configure',
  'resources',
  'chat',
  'scorecard',
  'bridge',
  // legacy aliases — kept so old bookmarks resolve. 'logs' redirects
  // to the global /logs page (handled in the AgentDetailPage effect);
  // the others map to a still-active tab via TAB_ALIASES on the page.
  'build',
  'test',
  'memory',
  'tools',
  'logs',
] as const
export type AgentTabSegment = (typeof AGENT_TABS)[number]

export function matchAgentDetail(
  path: string,
): { id: string; tab?: AgentTabSegment; threadId?: string } | null {
  const parts = path.split('/').filter(Boolean)
  // 2 = /agents/:id
  // 3 = /agents/:id/<tab>
  // 4 = /agents/:id/chat/<threadId>  (only chat carries a sub-resource)
  if (parts.length < 2 || parts.length > 4) return null
  if (parts[0] !== 'agents') return null
  const id = parts[1]!
  if (!UUID_RE.test(id)) return null
  if (parts.length === 2) return { id }
  const tab = parts[2] as string
  if (!(AGENT_TABS as ReadonlyArray<string>).includes(tab)) return null
  if (parts.length === 3) return { id, tab: tab as AgentTabSegment }
  // 4-segment form is reserved for the chat tab's per-thread URL so
  // each conversation can be bookmarked / linked. Reject combos like
  // `/agents/:id/resources/<anything>` so we don't accidentally swallow
  // typos as valid routes.
  if (tab !== 'chat') return null
  const threadId = parts[3]!
  if (!UUID_RE.test(threadId)) return null
  return { id, tab: 'chat', threadId }
}

/**
 * Match the IDE bridge view route. Static path; no params.
 * Surfaces the MCP discovery + runs feed under `/bridge`.
 */
export function matchBridge(path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  return parts.length === 1 && parts[0] === 'bridge'
}

/**
 * Match the global Logs page route. `/logs` is the parent-level
 * runs feed (every agent, both UI + bridge sources). Per-agent
 * Logs tab still lives at `/agents/:id/logs` for filtered views.
 * Optional `:runId` segment opens the run detail sheet on load
 * (deep-linkable from a tool-call notification, etc.).
 */
export function matchLogs(path: string): { runId: string | null } | null {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'logs') return null
  if (parts.length === 1) return { runId: null }
  if (parts.length === 2) return { runId: parts[1] ?? null }
  return null
}

/** Static path helpers for the new shell. */
export function matchHome(path: string): boolean {
  return path === '/' || path === ''
}
export function matchAgentsList(path: string): boolean {
  return path === '/agents' || path === '/agents/'
}
export function matchSettings(path: string): boolean {
  return path === '/settings'
}
export function matchLibraryProviders(path: string): boolean {
  return (
    path === '/library' || path === '/library/' || path === '/library/providers'
  )
}
export function matchLibraryRepos(path: string): boolean {
  return path === '/library/repos'
}
export function matchLibraryFiles(path: string): boolean {
  return path === '/library/files'
}
export function matchLibraryMcp(path: string): boolean {
  return path === '/library/mcp'
}

/** Match the OAuth callback route. Pure-static path; query carries the
 *  upstream callback params which are forwarded by postMessage. */
export function matchOAuthCallback(path: string): boolean {
  return path === '/oauth/callback'
}

/** Match the internal design-language showcase (proposal surface). */
export function matchDesign(path: string): boolean {
  return path === '/_design'
}

/** Match `/library/{providers,repos,mcp}/<uuid>` and return id + section. */
export function matchLibraryDetail(
  path: string,
): { section: 'providers' | 'repos' | 'mcp'; id: string } | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length !== 3 || parts[0] !== 'library') return null
  const [, section, id] = parts as [string, string, string]
  if (section !== 'providers' && section !== 'repos' && section !== 'mcp') {
    return null
  }
  if (!UUID_RE.test(id)) return null
  return { section, id }
}
