/**
 * Root component. Mounts the workspace data provider and renders the
 * global canvas shell: TopBar (brand + actions) · WorkspaceCanvas · RightRail.
 *
 * Routing model:
 *   - `/`                → global canvas, no focus.
 *   - `/agents/:uuid`    → global canvas focused on that agent (dim others +
 *                          SSE subscribed to the agent's stream id).
 *   - anything else      → redirect home (we have no other pages today).
 *
 * State model:
 *   - URL is the single source of truth for `focusedAgentId`. `navigate()`
 *     moves it; clicking canvas background or pressing Esc goes back to `/`.
 *   - `selection` (details target) is local state — it survives a blur
 *     on purpose, so the user can tweak a node's details without it
 *     resetting on URL change.
 *   - One `useSSE` subscription lives here and is shared with the TopBar's
 *     "live" dot and the right work panel's Activity tab.
 */

import { useCallback, useEffect, useState } from 'react'
import { WorkspaceProvider } from './lib/workspace-provider'
import { useWorkspace } from './lib/workspace-context'
import { matchAgentDetail, navigate, usePathname } from './lib/router'
import { useSSE } from './lib/use-sse'
import { TopBar } from './components/layout/top-bar'
import { RightRail } from './components/layout/right-rail'
import {
  AddResourcePanel,
  type AddResourceKind,
} from './components/agent-workspace/add-resource-panel'
import { ResourceTray } from './components/agent-workspace/resource-tray'
import {
  WorkspaceCanvas,
  type WorkspaceSelection,
} from './components/canvas/workspace-canvas'

type RailTab = 'inspector' | 'chat' | 'activity'
type AddPanelState = null | {
  readonly agentId: string
  readonly kind?: AddResourceKind
}

function LoadingOverlay() {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="spinner" aria-hidden="true" />
        <div className="overlay-title">Loading workspace…</div>
      </div>
    </div>
  )
}

function ErrorOverlay({ message }: { message: string }) {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-icon err" aria-hidden="true">
          !
        </div>
        <div className="overlay-title">Failed to load workspace</div>
        <div className="overlay-subtitle">{message}</div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    </div>
  )
}

function EmptyOverlay({
  onCreate,
  creating,
  error,
}: {
  onCreate: () => void
  creating: boolean
  error: string | null
}) {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-icon" aria-hidden="true">
          ⚡
        </div>
        <div className="overlay-title">Build your first agent</div>
        <div className="overlay-subtitle">
          Agents orchestrate skills, tools, and repositories. Drop one onto the
          canvas to start wiring it up.
        </div>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCreate}
          disabled={creating}
        >
          <span className="icon-plus" aria-hidden="true" />
          <span>{creating ? 'Creating…' : 'New agent'}</span>
        </button>
      </div>
    </div>
  )
}

function Workspace() {
  const pathname = usePathname()
  const workspace = useWorkspace()
  const { agents, createAgent, status, error } = workspace

  const [selection, setSelection] = useState<WorkspaceSelection>(null)
  const [railOpen, setRailOpen] = useState(false)
  const [railTab, setRailTab] = useState<RailTab>('inspector')
  const [addPanel, setAddPanel] = useState<AddPanelState>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Unknown paths → home (canvas still stays usable).
  useEffect(() => {
    if (pathname === '' || pathname === '/') return
    if (matchAgentDetail(pathname)) return
    navigate('/', { replace: true })
  }, [pathname])

  const focusMatch = matchAgentDetail(pathname)
  const focusedAgentId = focusMatch?.id ?? null
  const focusedAgent = focusedAgentId
    ? (agents.find((a) => a.id === focusedAgentId) ?? null)
    : null

  // If the URL focuses an agent that no longer exists (deletion, bad link),
  // drop back to the home canvas.
  useEffect(() => {
    if (!focusMatch) return
    if (status !== 'ready') return
    if (!agents.some((a) => a.id === focusMatch.id)) {
      navigate('/', { replace: true })
    }
  }, [focusMatch, status, agents])

  // ESC exits focus unless a modal is handling it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (addPanel) return
      if (focusedAgentId) {
        setSelection(null)
        setRailOpen(false)
        setRailTab('inspector')
        navigate('/')
      } else if (selection) {
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addPanel, focusedAgentId, selection])

  // A selection updates Details, but should not steal the rail from Chat/Activity.
  useEffect(() => {
    if (!selection) return
    let active = true
    ;(async () => {
      await Promise.resolve()
      if (!active) return
      if (!railOpen) {
        setRailTab('inspector')
        setRailOpen(true)
      }
    })()
    return () => {
      active = false
    }
  }, [railOpen, selection])

  // Activity stream id = focused agent (phases 2+ may broaden this).
  const streamId = focusedAgent?.id ?? null
  const { connected, events } = useSSE(streamId, { cap: 200 })
  const activeRailTab: RailTab =
    focusedAgent || railTab !== 'chat' ? railTab : 'inspector'
  const workPanelOpen = focusedAgent !== null && railOpen

  const handleToggleRail = useCallback(() => setRailOpen((v) => !v), [])
  const handleSetTab = useCallback((t: RailTab) => setRailTab(t), [])
  const handleExitFocus = useCallback(() => {
    setSelection(null)
    setRailOpen(false)
    setRailTab('inspector')
    navigate('/')
  }, [])

  const handleFocusAgent = useCallback((id: string | null) => {
    if (id) {
      navigate(`/agents/${id}`)
      return
    }
    setSelection(null)
    setRailOpen(false)
    setRailTab('inspector')
    navigate('/')
  }, [])

  const handleOpenAddResource = useCallback(
    (agentId: string, kind?: AddResourceKind) => {
      setAddPanel(kind ? { agentId, kind } : { agentId })
    },
    [],
  )

  const handleSelectResource = useCallback((next: WorkspaceSelection) => {
    setSelection(next)
    setRailTab('inspector')
    setRailOpen(true)
  }, [])

  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      await workspace.removeAgent(agentId)
      setSelection((current) =>
        current?.kind === 'agent' && current.id === agentId ? null : current,
      )
      if (focusedAgentId === agentId) {
        setRailOpen(false)
        setRailTab('inspector')
        navigate('/')
      }
    },
    [focusedAgentId, workspace],
  )

  const handleCreateAgent = useCallback(async () => {
    setCreateError(null)
    setCreating(true)
    try {
      const slugs = new Set(agents.map((a) => a.slug))
      const base = `agent-${Date.now().toString(36).slice(-6)}`
      let slug = base
      let i = 1
      while (slugs.has(slug)) slug = `${base}-${i++}`
      const agent = await createAgent({ name: 'Untitled agent', slug })
      setSelection({ kind: 'agent', id: agent.id })
      navigate(`/agents/${agent.id}`)
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : 'Failed to create agent',
      )
    } finally {
      setCreating(false)
    }
  }, [agents, createAgent])

  const addPanelAgent = addPanel
    ? (workspace.getAgent(addPanel.agentId) ?? focusedAgent)
    : null

  return (
    <div className="shell">
      <div className="shell-main">
        <TopBar
          focusedAgent={focusedAgent}
          railOpen={workPanelOpen}
          activeTab={activeRailTab}
          liveConnected={connected}
          onToggleRail={handleToggleRail}
          onSetTab={handleSetTab}
          onExitFocus={handleExitFocus}
        />

        <div className={`main-area${focusedAgent ? ' is-focused' : ''}`}>
          <div className="agent-workspace-primary">
            <div className="main-area-canvas">
              <WorkspaceCanvas
                workspace={workspace}
                focusedAgentId={focusedAgentId}
                selection={selection}
                onSelect={setSelection}
                onFocusAgent={handleFocusAgent}
                onRemoveAgent={handleRemoveAgent}
                onCreateAgent={handleCreateAgent}
                creatingAgent={creating}
              />

              {status === 'loading' ? <LoadingOverlay /> : null}
              {status === 'error' && error ? (
                <ErrorOverlay message={error.message} />
              ) : null}
              {status === 'ready' && agents.length === 0 ? (
                <EmptyOverlay
                  onCreate={() => void handleCreateAgent()}
                  creating={creating}
                  error={createError}
                />
              ) : null}

              {focusedAgent ? (
                <ResourceTray
                  agent={focusedAgent}
                  workspace={workspace}
                  selection={selection}
                  onSelect={handleSelectResource}
                  onAdd={(kind) => handleOpenAddResource(focusedAgent.id, kind)}
                />
              ) : null}
            </div>
          </div>
        </div>

        <RightRail
          collapsed={!workPanelOpen}
          tab={activeRailTab}
          onTabChange={setRailTab}
          workspace={workspace}
          selection={selection}
          onSelect={setSelection}
          focusedAgent={focusedAgent}
          activityStreamId={streamId}
          activityEvents={events}
          activityConnected={connected}
        />

        {addPanel && addPanelAgent ? (
          <AddResourcePanel
            agent={addPanelAgent}
            initialKind={addPanel.kind}
            onClose={() => setAddPanel(null)}
          />
        ) : null}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <WorkspaceProvider>
      <Workspace />
    </WorkspaceProvider>
  )
}
