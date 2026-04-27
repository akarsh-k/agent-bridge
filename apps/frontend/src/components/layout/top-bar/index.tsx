/**
 * Top bar — brand on the left, workspace actions on the right.
 *
 * Structure:
 *   - Brand "Agent Bridge" (returns to `/` / clears focus).
 *   - Focus indicator — shows the focused agent name (or "Workspace") with
 *     an Escape hint when a focus is active.
 *   - `+ New agent` primary action — POSTs straight away (no modal) and
 *     navigates so the new node is both focused and selected.
 *   - Inspector, Chat, and Activity work-panel toggles. The Activity button
 *     has a green pulse when the SSE stream is open.
 */

import { useCallback, useState } from 'react'
import type { AgentResponse } from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { navigate } from '../../../lib/router'

import './index.css'

type RailTab = 'inspector' | 'chat' | 'activity'

function draftDefaults(existing: ReadonlySet<string>) {
  const base = `agent-${Date.now().toString(36).slice(-6)}`
  let slug = base
  let i = 1
  while (existing.has(slug)) slug = `${base}-${i++}`
  return { name: 'Untitled agent', slug }
}

export function TopBar({
  focusedAgent,
  railOpen,
  activeTab,
  liveConnected,
  onToggleRail,
  onSetTab,
  onExitFocus,
}: {
  focusedAgent: AgentResponse | null
  railOpen: boolean
  activeTab: RailTab
  liveConnected: boolean
  onToggleRail: () => void
  onSetTab: (tab: RailTab) => void
  onExitFocus: () => void
}) {
  const { agents, createAgent } = useWorkspace()
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    setCreateError(null)
    setCreating(true)
    try {
      const slugs = new Set(agents.map((a) => a.slug))
      const agent = await createAgent(draftDefaults(slugs))
      navigate(`/agents/${agent.id}`)
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to create agent',
      )
    } finally {
      setCreating(false)
    }
  }, [agents, createAgent])

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="topbar-brand"
          onClick={onExitFocus}
          title="Workspace home"
        >
          <span className="topbar-brand-mark" aria-hidden="true">
            AB
          </span>
          <span className="topbar-brand-text">Agent Bridge</span>
        </button>

        <span className="topbar-crumb-sep" aria-hidden="true">
          /
        </span>

        {focusedAgent ? (
          <div className="topbar-focus">
            <span className="topbar-focus-label">Focusing</span>
            <span className="topbar-title" title={focusedAgent.name}>
              {focusedAgent.name}
            </span>
            <code>{focusedAgent.slug}</code>
            <button
              type="button"
              className="topbar-focus-exit"
              onClick={onExitFocus}
              title="Exit focus (Esc)"
            >
              <span>esc</span>
            </button>
          </div>
        ) : (
          <span className="dim">Workspace</span>
        )}
      </div>

      <div className="topbar-right">
        {createError ? (
          <span className="banner banner-error" role="alert">
            {createError}
          </span>
        ) : null}

        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          <span className="icon-plus" aria-hidden="true" />
          <span>{creating ? 'Creating…' : 'New agent'}</span>
        </button>

        {focusedAgent ? (
          <>
            <span className="topbar-divider" aria-hidden="true" />

            <button
              type="button"
              className="topbar-btn"
              aria-pressed={railOpen && activeTab === 'inspector'}
              onClick={() => {
                if (railOpen && activeTab === 'inspector') onToggleRail()
                else {
                  onSetTab('inspector')
                  if (!railOpen) onToggleRail()
                }
              }}
            >
              <span aria-hidden="true">⚙︎</span>
              <span>Inspector</span>
            </button>

            <button
              type="button"
              className="topbar-btn"
              aria-pressed={railOpen && activeTab === 'chat'}
              onClick={() => {
                if (railOpen && activeTab === 'chat') onToggleRail()
                else {
                  onSetTab('chat')
                  if (!railOpen) onToggleRail()
                }
              }}
            >
              <span aria-hidden="true">#</span>
              <span>Chat</span>
            </button>

            <button
              type="button"
              className="topbar-btn"
              aria-pressed={railOpen && activeTab === 'activity'}
              onClick={() => {
                if (railOpen && activeTab === 'activity') onToggleRail()
                else {
                  onSetTab('activity')
                  if (!railOpen) onToggleRail()
                }
              }}
              title={liveConnected ? 'Activity stream connected' : 'Activity'}
            >
              <span
                className={`topbar-btn-dot${liveConnected ? ' live' : ''}`}
                aria-hidden="true"
              />
              <span>Activity</span>
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
}
