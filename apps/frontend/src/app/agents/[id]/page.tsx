/**
 * Agent detail — sticky header + pill-tab strip + tab panels.
 * Build / Chat / Memory / Tools / Bridge / Logs are switched inline
 * (no route change) so the user stays in flow.
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import { agentStreamId } from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError, exportAgentBundle } from '../../../lib/rpc'
import { navigate } from '../../../lib/router'
import { useSSE } from '../../../lib/use-sse'
import { Button } from '../../../ui/button'
import { Pill } from '../../../ui/pill'
import { Tabs, type TabSpec } from '../../../ui/tabs'
import { ChatIcon } from '../../../ui/icons'
import { agentGlyphKind } from '../../../lib/agent-helpers'
import { toast } from '../../../ui/toast-store'
import { confirmDialog } from '../../../ui/dialog-store'
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
  import('../../../features/agent-bridge-tools/bridge-tools-tab').then(
    (m) => ({ default: m.BridgeToolsTab }),
  ),
)
const LogsTab = lazy(() =>
  import('../../../features/agent-logs/logs-tab').then((m) => ({
    default: m.LogsTab,
  })),
)

type TabId = 'configure' | 'resources' | 'chat' | 'bridge' | 'logs'

const TABS: ReadonlyArray<TabSpec<TabId>> = [
  { value: 'configure', label: 'Configure' },
  { value: 'resources', label: 'Resources' },
  { value: 'chat', label: 'Chat' },
  { value: 'bridge', label: 'Bridge' },
  { value: 'logs', label: 'Logs' },
]

// Legacy URL aliases — `/agents/<id>/build` etc. still work but map
// to the new tab they got folded into.
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
}: {
  id: string
  /** Raw URL segment — may be a legacy alias like 'build' / 'memory'
   * which `normalizeTab` folds into the corresponding active tab. */
  initialTab?: string
}) {
  const initial = normalizeTab(initialTab)
  const { agents, removeAgent, status } = useWorkspace()
  const agent = agents.find((a) => a.id === id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [, setBusy] = useState(false)

  // Hoist the per-agent SSE subscription up to the agent detail page
  // so it stays alive across tab switches. Without this, switching to
  // the Logs tab would open a fresh subscription that misses every
  // event fired while the user was on Build / Chat / etc — the
  // pre-rewrite App.tsx held this subscription at the shell level
  // and passed events into the Activity panel as props; the rewrite
  // accidentally moved it down into LogsTab and lost the persistence.
  const agentEvents = useSSE(agentStreamId(id), { cap: 400 })
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
    setTab(next)
    setSeededTab(next)
    const path =
      next === 'configure' ? `/agents/${id}` : `/agents/${id}/${next}`
    if (window.location.pathname !== path) {
      navigate(path, { replace: true })
    }
  }

  // If the user landed on a legacy URL (`/agents/<id>/build`), rewrite
  // to the canonical one for the new tab so the URL bar matches.
  useEffect(() => {
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
      const map: Record<string, TabId> = {
        c: 'configure',
        r: 'resources',
        t: 'chat', // mnemonic: Talk to the agent (c is taken by Configure)
        b: 'bridge',
        l: 'logs',
      }
      const next = map[e.key.toLowerCase()]
      if (!next) return
      e.preventDefault()
      setTabAndUrl(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (!agent) {
    // Distinguish "still loading" from "doesn't exist". Without this
    // guard, navigating to a freshly-created agent lands on "not
    // found" before the workspace refetch has populated the new row.
    if (status === 'loading') {
      return (
        <div className="ab-page">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--text-dim)',
              padding: '20px 0',
              fontSize: 13,
            }}
          >
            <span className="ab-pulse-dot" />
            Loading agent…
          </div>
        </div>
      )
    }
    return (
      <div className="ab-page">
        <div className="ab-card ab-card-pad">
          <div className="ab-section-title">Agent not found</div>
          <div className="ab-section-sub" style={{ marginTop: 4 }}>
            The agent {id.slice(0, 8)}… doesn't exist or has been deleted.
          </div>
        </div>
      </div>
    )
  }

  const updatedAt = new Date(agent.updatedAt)
  const isDraft = !agent.systemPrompt || agent.systemPrompt.trim().length === 0

  return (
    <div className="ab-page">
      <div className="ab-detail-header">
        <div
          className={`ab-detail-glyph ab-glyph ab-glyph-${agentGlyphKind(agent.id)}`}
        >
          {(agent.name ?? 'A').charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ab-page-title" style={{ marginBottom: 0 }}>
            {agent.name}
          </h1>
          <div className="ab-detail-meta">
            <span className="ab-mono">{agent.slug}</span>
            <span>·</span>
            <span>Updated {timeAgo(updatedAt)}</span>
            <span>·</span>
            {isDraft ? (
              <Pill kind="warn" dot>
                Draft
              </Pill>
            ) : (
              <Pill kind="success" dot>
                Active
              </Pill>
            )}
          </div>
        </div>
        <div
          className="ab-page-actions"
          style={{ position: 'relative' }}
        >
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
          >
            ⋯
          </Button>
          {menuOpen && (
            <>
              <div
                onClick={() => setMenuOpen(false)}
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 40,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius)',
                  boxShadow: 'var(--shadow-2)',
                  padding: 4,
                  minWidth: 180,
                  zIndex: 41,
                }}
              >
                <MenuItem
                  label="Export bundle"
                  onClick={async () => {
                    setMenuOpen(false)
                    setBusy(true)
                    try {
                      const bundle = await exportAgentBundle(agent.id)
                      downloadJson(bundle, `${agent.slug}.json`)
                      toast.success('Bundle exported')
                    } catch (e) {
                      toast.error(
                        e instanceof ApiError
                          ? e.message
                          : e instanceof Error
                            ? e.message
                            : 'Export failed',
                      )
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
                <div
                  style={{
                    height: 1,
                    background: 'var(--border)',
                    margin: '4px 0',
                  }}
                />
                <MenuItem
                  label="Delete agent…"
                  danger
                  onClick={async () => {
                    setMenuOpen(false)
                    if (
                      !(await confirmDialog({
                        title: `Delete agent “${agent.name}”?`,
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

      {!agent.llmProviderId && (
        <div
          role="alert"
          className="ab-card ab-card-pad"
          style={{
            background: 'var(--warn-bg)',
            borderColor: 'rgba(251, 191, 36, 0.32)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 18,
            padding: '12px 16px',
          }}
        >
          <span
            className="ab-pulse-dot"
            style={{
              background: 'var(--warn)',
              animation: 'none',
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              No LLM provider assigned
            </div>
            <div
              className="ab-section-sub"
              style={{ marginTop: 2, fontSize: 12 }}
            >
              {agent.name} can't run yet. Pick a provider on the Configure
              tab, or add one in Library if you haven't.
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => setTabAndUrl('configure')}
          >
            Configure
          </Button>
        </div>
      )}

      <Tabs value={tab} onChange={setTabAndUrl} tabs={TABS} />

      {tab === 'configure' && (
        <Suspense fallback={<TabSpinner />}>
          <ConfigureTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'resources' && (
        <Suspense fallback={<TabSpinner />}>
          <ResourcesTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'chat' && (
        <Suspense fallback={<TabSpinner />}>
          <ChatTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'bridge' && (
        <Suspense fallback={<TabSpinner />}>
          <BridgeToolsTab agentId={agent.id} />
        </Suspense>
      )}
      {tab === 'logs' && (
        <Suspense fallback={<TabSpinner />}>
          <LogsTab
            agentId={agent.id}
            events={agentEvents.events}
            connected={agentEvents.connected}
          />
        </Suspense>
      )}
    </div>
  )
}

function TabSpinner() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: 'var(--text-dim)',
        padding: '20px 0',
        fontSize: 13,
      }}
    >
      <span className="ab-pulse-dot" />
      Loading…
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
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 7,
        background: 'transparent',
        border: 'none',
        color: danger ? 'var(--danger)' : 'var(--text)',
        fontSize: 13,
        cursor: 'pointer',
        font: 'inherit',
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = 'var(--surface-hover)')
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  )
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime()
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}
