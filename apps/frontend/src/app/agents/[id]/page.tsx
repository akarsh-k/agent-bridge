/**
 * Agent detail — sticky header + pill-tab strip + tab panels.
 * Configure / Resources / Chat / Bridge are switched inline
 * (no route change) so the user stays in flow. The per-agent Logs
 * tab was removed in favour of the global /logs page; agent-specific
 * runs are still reachable from there via the agent-multi-select
 * filter (or by deep-linking from any run row).
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { navigate } from '../../../lib/router'
import { Button } from '../../../ui/button'
import { Pill } from '../../../ui/pill'
import { Tabs, type TabSpec } from '../../../ui/tabs'
import { ChatIcon } from '../../../ui/icons'
import { agentGlyphKind } from '../../../lib/agent-helpers'
import { useTimeAgo } from '../../../lib/use-time-ago'
import { toast } from '../../../ui/toast-store'
import { confirmDialog } from '../../../ui/dialog-store'
import { useAgentReadiness } from '../../../features/agent-builder/use-agent-readiness'
import { AgentReadinessCard } from '../../../features/agent-builder/agent-readiness-card'
import { AgentReadyCelebration } from '../../../features/agent-builder/agent-ready-celebration'
import { hasCelebratedAgentReady } from '../../../features/agent-builder/agent-ready-celebration-flag'
import { requestNavigation } from '../../../lib/nav-guard'
import {
  BridgeTabSkeleton,
  ChatTabSkeleton,
  ConfigureTabSkeleton,
  ResourcesTabSkeleton,
  ScorecardTabSkeleton,
} from './tab-skeletons'
// Code-split the heavier tabs: configure pulls in the build / memory
// forms, resources pulls in the attached-resources panel + tools tab,
// chat pulls in the run state machine + SSE plumbing.
const ConfigureTab = lazy(() =>
  import('../../../features/agent-configure/configure-tab').then((m) => ({
    default: m.ConfigureTab,
  })),
)
const ResourcesTab = lazy(() =>
  import('../../../features/agent-resources/resources-tab').then((m) => ({
    default: m.ResourcesTab,
  })),
)
const ChatTab = lazy(() =>
  import('../../../features/agent-test/chat-tab').then((m) => ({
    default: m.ChatTab,
  })),
)
const BridgeToolsTab = lazy(() =>
  import('../../../features/agent-bridge-tools/bridge-tools-tab').then((m) => ({
    default: m.BridgeToolsTab,
  })),
)
const ScorecardTab = lazy(() =>
  import('../../../features/agent-scorecard/scorecard-tab').then((m) => ({
    default: m.ScorecardTab,
  })),
)
type TabId = 'configure' | 'resources' | 'chat' | 'scorecard' | 'bridge'

const TABS: ReadonlyArray<TabSpec<TabId>> = [
  { value: 'configure', label: 'Configure' },
  { value: 'resources', label: 'Resources' },
  { value: 'chat', label: 'Chat' },
  { value: 'scorecard', label: 'Scorecard' },
  { value: 'bridge', label: 'Bridge' },
]

// Legacy URL aliases — `/agents/<id>/build` etc. still work but map
// to the new tab they got folded into. `logs` rewrites to the global
// /logs page (handled in the AgentDetailPage effect below) so old
// bookmarks keep working.
const TAB_ALIASES: Record<string, TabId> = {
  build: 'configure',
  memory: 'configure',
  tools: 'resources',
  test: 'chat',
}
function normalizeTab(raw: string | undefined): TabId {
  if (!raw) return 'configure'
  if ((TABS as ReadonlyArray<{ value: string }>).some((t) => t.value === raw)) {
    return raw as TabId
  }
  return TAB_ALIASES[raw] ?? 'configure'
}

export function AgentDetailPage({
  id,
  initialTab,
  initialThreadId,
}: {
  id: string
  /** Raw URL segment — may be a legacy alias like 'build' / 'memory'
   * which `normalizeTab` folds into the corresponding active tab. */
  initialTab?: string
  /** Optional chat thread captured from `/agents/:id/chat/:threadId`.
   *  Only set when `initialTab === 'chat'`. The chat tab uses this as
   *  the URL-driven source of truth for the active thread; thread
   *  switches inside the tab push a new URL via `navigate`. */
  initialThreadId?: string
}) {
  const initial = normalizeTab(initialTab)
  const { agents, removeAgent, status } = useWorkspace()
  const agent = agents.find((a) => a.id === id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [, setBusy] = useState(false)
  const [celebrationOpen, setCelebrationOpen] = useState(false)

  // Reset the active tab whenever we navigate to a different agent
  // OR the URL's tab segment changes — "adjust state based on
  // props" pattern. Tab clicks also write to the URL via
  // `setTabAndUrl` below so each tab is bookmarkable / linkable.
  const [tab, setTab] = useState<TabId>(initial)
  const [tabAgent, setTabAgent] = useState(id)
  const [seededTab, setSeededTab] = useState<string | undefined>(initialTab)
  if (tabAgent !== id) {
    setTabAgent(id)
    setTab(initial)
    setSeededTab(initialTab)
  } else if (initialTab !== seededTab) {
    setSeededTab(initialTab)
    setTab(initial)
  }
  const setTabAndUrl = (next: TabId) => {
    // Same-tab "navigations" (e.g. the readiness card's
    // "Open Configure" button clicked while already on Configure)
    // shouldn't fire the nav guard — nothing is actually changing.
    // Callers that need a scroll-to-section still get it because
    // the scrollIntoViewWhenReady helper runs alongside this call,
    // not inside it.
    if (next === tab) return
    // Tab switches change React state AND the URL; both have to flip
    // together or the UI gets out of sync. Route through the nav
    // guard once so a dirty form can intercept the whole thing; the
    // inner navigate uses skipGuard since the outer request already
    // consulted.
    requestNavigation(() => {
      setTab(next)
      setSeededTab(next)
      const path =
        next === 'configure' ? `/agents/${id}` : `/agents/${id}/${next}`
      if (window.location.pathname !== path) {
        navigate(path, { replace: true, skipGuard: true })
      }
    })
  }

  // If the user landed on a legacy URL (`/agents/<id>/build`), rewrite
  // to the canonical one for the new tab so the URL bar matches.
  // `/agents/<id>/logs` no longer has a per-agent tab — redirect old
  // bookmarks to the global /logs page where the same data lives.
  useEffect(() => {
    if (initialTab === 'logs') {
      navigate('/logs', { replace: true })
      return
    }
    if (initialTab && TAB_ALIASES[initialTab]) {
      const target = TAB_ALIASES[initialTab]
      const path =
        target === 'configure' ? `/agents/${id}` : `/agents/${id}/${target}`
      if (window.location.pathname !== path) {
        navigate(path, { replace: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])

  // Single-key tab shortcuts. Only fire when focus is outside form
  // fields so typing into prompt / chat composers doesn't jump tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      const map: Record<string, TabId | 'logs'> = {
        c: 'configure',
        r: 'resources',
        t: 'chat', // mnemonic: Talk to the agent (c is taken by Configure)
        b: 'bridge',
        // 'l' jumps to the global Logs page since the per-agent
        // tab was removed.
        l: 'logs',
      }
      const next = map[e.key.toLowerCase()]
      if (!next) return
      e.preventDefault()
      if (next === 'logs') {
        navigate('/logs')
        return
      }
      setTabAndUrl(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // `updatedAt` derived above the early returns so the `useTimeAgo`
  // hook below sees a stable call site every render — Rules of Hooks
  // require the hook order to be invariant, so we can't conditionally
  // run it inside the not-found / loading branches.
  const updatedAt = agent ? new Date(agent.updatedAt) : null
  const updatedLabel = useTimeAgo(updatedAt)
  // Same reasoning: readiness needs to call useWorkspace / useMemo
  // unconditionally. When the agent isn't loaded yet, the hook
  // returns a zero state and the card / pill simply render nothing.
  const readiness = useAgentReadiness(id)

  // One-time per-agent "your agent is ready" celebration. Fires
  // when the full readiness checklist passes — system prompt + chat
  // provider for any agent, plus embedding provider + attached repo
  // for inspector / coding-helper agents. The flag is per-agent so
  // each new agent gets its own milestone.
  //
  // Implemented via the "adjust state during render" pattern so the
  // state change batches with the render that flipped readiness.
  const ready = readiness.ready
  const [readinessSeededFor, setReadinessSeededFor] = useState(id)
  const [readinessSeen, setReadinessSeen] = useState(false)
  if (readinessSeededFor !== id) {
    // Navigated to a different agent — recheck readiness for that
    // agent on its next render.
    setReadinessSeededFor(id)
    setReadinessSeen(false)
  } else if (ready && !readinessSeen) {
    setReadinessSeen(true)
    if (!hasCelebratedAgentReady(id)) {
      setCelebrationOpen(true)
    }
  }

  if (!agent) {
    // Distinguish "still loading" from "doesn't exist". Without this
    // guard, navigating to a freshly-created agent lands on "not
    // found" before the workspace refetch has populated the new row.
    if (status === 'loading') {
      return <LoadingRow label="Loading agent…" />
    }
    return (
      <div className="ab-page">
        <div className="ab-card ab-card-pad">
          <div className="ab-section-title">Agent not found</div>
          <div className="ab-section-sub ab-not-found-sub">
            The agent {id.slice(0, 8)}… doesn't exist or has been deleted.
          </div>
          <div className="ab-not-found-action">
            <Button variant="secondary" onClick={() => navigate('/agents')}>
              Back to agents
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ab-page">
      <div className="ab-detail-header">
        <div
          className={`ab-detail-glyph ab-glyph ab-glyph-${agentGlyphKind(agent.id)}`}
        >
          {(agent.name ?? 'A').charAt(0).toUpperCase()}
        </div>
        <div className="ab-detail-title-col">
          <h1 className="ab-page-title ab-page-title-flush">{agent.name}</h1>
          <div className="ab-detail-meta">
            <span className="ab-mono">{agent.slug}</span>
            <span>Updated {updatedLabel}</span>
            {!readiness.ready && (
              <Pill kind="warn">
                {readiness.remaining} step
                {readiness.remaining === 1 ? '' : 's'} left
              </Pill>
            )}
          </div>
        </div>
        <div className="ab-page-actions ab-page-actions-rel">
          <Button
            variant="primary"
            leading={<ChatIcon />}
            onClick={() => setTabAndUrl('chat')}
          >
            Chat
          </Button>
          <Button
            variant="secondary"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <EllipsisIcon />
          </Button>
          {menuOpen && (
            <>
              <div
                className="ab-menu-backdrop"
                onClick={() => setMenuOpen(false)}
              />
              <div className="ab-menu" role="menu">
                <MenuItem
                  label="Delete agent…"
                  danger
                  onClick={async () => {
                    setMenuOpen(false)
                    if (
                      !(await confirmDialog({
                        title: `Delete agent "${agent.name}"?`,
                        body: 'All chat history, skills, tool definitions, and bridge tools tied to this agent are removed. This cannot be undone.',
                        confirmLabel: 'Delete agent',
                        confirmText: agent.slug,
                        confirmDelaySec: 2,
                        destructive: true,
                      }))
                    ) {
                      return
                    }
                    setBusy(true)
                    try {
                      await removeAgent(agent.id)
                      toast.success('Agent deleted')
                      navigate('/agents')
                    } catch (e) {
                      toast.error(
                        e instanceof ApiError
                          ? e.message
                          : e instanceof Error
                            ? e.message
                            : 'Delete failed',
                      )
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <AgentReadinessCard
        agentId={agent.id}
        onNavigateToTab={(t) => setTabAndUrl(t)}
      />

      <AgentReadyCelebration
        open={celebrationOpen}
        agentId={agent.id}
        agentName={agent.name}
        onClose={() => setCelebrationOpen(false)}
        onOpenChat={() => setTabAndUrl('chat')}
        onOpenBridge={() => navigate('/bridge')}
      />

      <Tabs value={tab} onChange={setTabAndUrl} tabs={TABS} />

      {tab === 'configure' && (
        <Suspense fallback={<ConfigureTabSkeleton />}>
          <ConfigureTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'resources' && (
        <Suspense fallback={<ResourcesTabSkeleton />}>
          <ResourcesTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'chat' && (
        <Suspense fallback={<ChatTabSkeleton />}>
          <ChatTab agentId={agent.id} initialThreadId={initialThreadId} />
        </Suspense>
      )}
      {tab === 'scorecard' && (
        <Suspense fallback={<ScorecardTabSkeleton />}>
          <ScorecardTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'bridge' && (
        <Suspense fallback={<BridgeTabSkeleton />}>
          <BridgeToolsTab agentId={agent.id} />
        </Suspense>
      )}
    </div>
  )
}

/**
 * Page-level loading state: a pulsing dot + dim label shown while the
 * agent itself is still being fetched. Wrapped in `.ab-page` so it
 * inherits the page gutters. (The lazy tab panels render the richer
 * skeletons from `tab-skeletons.tsx` as their Suspense fallback.)
 */
function LoadingRow({ label }: { label: string }) {
  return (
    <div className="ab-page">
      <div className="ab-loading-row">
        <span className="ab-pulse-dot" />
        {label}
      </div>
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`ab-menu-item${danger ? ' ab-menu-item-danger' : ''}`}
    >
      {label}
    </button>
  )
}

/** Inline ellipsis icon for the More-actions trigger. Single-color
 *  via `currentColor` so the button's text color drives it. */
function EllipsisIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="13" cy="8" r="1.5" fill="currentColor" />
    </svg>
  )
}
