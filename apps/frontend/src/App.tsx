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
 *   - `selection` (inspector target) is local state — it survives a blur
 *     on purpose, so the user can tweak a node's inspector without it
 *     resetting on URL change.
 *   - One `useSSE` subscription lives here and is shared with the TopBar's
 *     "live" dot and the RightRail's Activity tab.
 */

import { useCallback, useEffect, useState } from 'react'
import { WorkspaceProvider } from './lib/workspace-provider'
import { useWorkspace } from './lib/workspace-context'
import { matchAgentDetail, navigate, usePathname } from './lib/router'
import { useSSE } from './lib/use-sse'
import { TopBar } from './components/layout/top-bar'
import { RightRail } from './components/layout/right-rail'
import {
  WorkspaceCanvas,
  type WorkspaceSelection,
} from './components/canvas/workspace-canvas'

type RailTab = 'inspector' | 'activity'

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
          Agents orchestrate skills, tools, and repositories. Drop one onto
          the canvas to start wiring it up.
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
          <span aria-hidden="true">＋</span>
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
  const [railOpen, setRailOpen] = useState(true)
  const [railTab, setRailTab] = useState<RailTab>('inspector')
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

  // ESC exits focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (focusedAgentId) {
        navigate('/')
      } else if (selection) {
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedAgentId, selection])

  // Activity stream id = focused agent (phases 2+ may broaden this).
  const streamId = focusedAgent?.id ?? null
  const { connected, events } = useSSE(streamId, { cap: 200 })

  const handleToggleRail = useCallback(() => setRailOpen((v) => !v), [])
  const handleSetTab = useCallback((t: RailTab) => setRailTab(t), [])
  const handleExitFocus = useCallback(() => {
    setSelection(null)
    navigate('/')
  }, [])

  const handleFocusAgent = useCallback((id: string | null) => {
    if (id) navigate(`/agents/${id}`)
    else navigate('/')
  }, [])

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

  return (
    <div className="shell">
      <div className="shell-main">
        <TopBar
          focusedAgent={focusedAgent}
          railOpen={railOpen}
          activeTab={railTab}
          liveConnected={connected}
          onToggleRail={handleToggleRail}
          onSetTab={handleSetTab}
          onExitFocus={handleExitFocus}
        />

        <div className="main-area">
          <div className="main-area-canvas">
            <WorkspaceCanvas
              workspace={workspace}
              focusedAgentId={focusedAgentId}
              selection={selection}
              onSelect={setSelection}
              onFocusAgent={handleFocusAgent}
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
          </div>
        </div>

        <RightRail
          collapsed={!railOpen}
          tab={railTab}
          onTabChange={setRailTab}
          workspace={workspace}
          selection={selection}
          onSelect={setSelection}
          activityStreamId={streamId}
          activityEvents={events}
          activityConnected={connected}
        />
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
