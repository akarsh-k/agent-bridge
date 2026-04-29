/**
 * Top bar — brand on the left, workspace actions on the right.
 *
 * Structure:
 *   - Brand "Agent Bridge" (returns to `/` / clears focus).
 *   - Focus indicator — shows the focused agent name (or "Workspace") with
 *     an Escape hint when a focus is active.
 *   - `+ New agent` primary action — POSTs straight away (no modal) and
 *     navigates so the new node is both focused and selected.
 *   - Details, Chat, and Activity work-panel toggles. The Activity button
 *     has a green pulse when the SSE stream is open.
 */

import { useCallback, useRef, useState } from 'react'
import {
  agentExportBundleSchema,
  type AgentResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError, importAgentBundle } from '../../../lib/rpc'
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
  isBridgeRoute = false,
  onToggleRail,
  onSetTab,
  onExitFocus,
}: {
  focusedAgent: AgentResponse | null
  railOpen: boolean
  activeTab: RailTab
  liveConnected: boolean
  /**
   * `true` when the user is on the IDE-bridge view. Suppresses the
   * focus indicator + per-agent rail toggles (none of which apply to
   * a global page) and pressed-state-styles the Connect IDE link.
   */
  isBridgeRoute?: boolean
  onToggleRail: () => void
  onSetTab: (tab: RailTab) => void
  onExitFocus: () => void
}) {
  const { agents, createAgent, refresh } = useWorkspace()
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleImportFile = useCallback(
    async (file: File) => {
      setCreateError(null)
      setImporting(true)
      try {
        const text = await file.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error('Selected file is not valid JSON')
        }
        const validated = agentExportBundleSchema.safeParse(parsed)
        if (!validated.success) {
          throw new Error(
            'File does not look like an agent export bundle: ' +
              (validated.error.issues[0]?.message ?? 'invalid shape'),
          )
        }

        // First try with the bundle's own slug. If the slug already
        // exists locally, retry with a deterministic disambiguator so
        // the operator doesn't need to write one by hand for the common
        // case (re-importing a clone into the same install).
        const slugs = new Set(agents.map((a) => a.slug))
        const wantedSlug = validated.data.agent.slug
        const slugOverride = slugs.has(wantedSlug)
          ? `${wantedSlug}-imported-${Date.now().toString(36).slice(-4)}`
          : undefined

        const result = await importAgentBundle({
          bundle: validated.data,
          ...(slugOverride ? { slugOverride } : {}),
        })

        if (result.warnings.length > 0) {
          // Surface warnings non-fatally — the import succeeded; the
          // caller just needs to know some allowlist entries were
          // skipped (typically: missing MCP connections on this install).
          setCreateError(
            `Imported with warnings:\n${result.warnings.join('\n')}`,
          )
        }

        // Bump the workspace refresh tick so the imported agent shows
        // up in the sidebar + canvas. Then navigate — the route renders
        // a loading state if the agent's resources haven't fetched yet.
        refresh()
        navigate(`/agents/${result.agentId}`)
      } catch (err) {
        setCreateError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to import agent',
        )
      } finally {
        setImporting(false)
      }
    },
    [agents, refresh],
  )

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

        {isBridgeRoute ? (
          <span className="dim">Connect IDE</span>
        ) : focusedAgent ? (
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
          className="topbar-btn"
          aria-pressed={isBridgeRoute}
          onClick={() => navigate('/bridge')}
          title="Connect this workspace to your IDE via MCP"
        >
          <span aria-hidden="true">⌘</span>
          <span>Connect IDE</span>
        </button>

        <button
          type="button"
          className="topbar-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing || isBridgeRoute}
          title="Import an agent JSON bundle (no secrets, no thread ids)"
        >
          <span aria-hidden="true">↑</span>
          <span>{importing ? 'Importing…' : 'Import'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Reset the input so the operator can re-upload the same file
            // after dismissing an error.
            e.target.value = ''
            if (file) void handleImportFile(file)
          }}
        />

        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleCreate()}
          disabled={creating || isBridgeRoute}
          title={
            isBridgeRoute
              ? 'Switch to the workspace canvas to create agents'
              : undefined
          }
        >
          <span className="icon-plus" aria-hidden="true" />
          <span>{creating ? 'Creating…' : 'New agent'}</span>
        </button>

        {!isBridgeRoute && focusedAgent ? (
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
              <span aria-hidden="true">ⓘ</span>
              <span>Details</span>
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
