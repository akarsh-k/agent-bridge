/**
 * Per-agent MCP tool picker — Phase 4D.
 *
 * Lists every `mcp_connections` row and, for each, lets the operator
 * discover its tools (via `POST /api/mcp-connections/:id/test`) and
 * check the ones this agent should have in its allowlist.
 *
 * Save semantics are set-replace: the operator hits Save and the
 * resulting `tools[]` becomes the agent's complete allowlist (backend
 * `PUT /api/agents/:agentId/mcp-tools`). Entries that were previously
 * allowlisted but are no longer advertised upstream render as
 * "missing" badges until the operator unchecks them — matches the
 * `missingTools` contract from `mountExternalMcps`.
 *
 * One connection at a time stays expanded; tool-discovery is cached in
 * local state so reopening a panel doesn't re-probe.
 */

import { useCallback, useMemo, useState } from 'react'
import type {
  AllowlistEntry,
  DiscoveredMcpTool,
  McpConnectionResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError, discoverMcpTools } from '../../../lib/rpc'
import { ErrorText } from './form-atoms'

export interface McpPickerProps {
  readonly agentId: string
  /**
   * Navigate into the create/edit form. Called from the "+ New MCP"
   * button at the bottom of the list.
   */
  readonly onCreateNew: () => void
  readonly onEdit: (connection: McpConnectionResponse) => void
  readonly onDone: () => void
}

type DiscoverPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; tools: readonly DiscoveredMcpTool[]; message: string }
  | { kind: 'failed'; message: string }

/** Inline description longer than this uses a collapsible block so rows stay compact. */
const MCP_TOOL_DESC_COLLAPSE_LEN = 220

export function McpPicker({
  agentId,
  onCreateNew,
  onEdit,
  onDone,
}: McpPickerProps) {
  const { mcpConnections, agentResources, setAgentMcpTools } = useWorkspace()
  const bundle = agentResources[agentId]

  // Canonical state: per-connection map of allowlisted raw tool names.
  const [selection, setSelection] = useState<Record<string, Set<string>>>(
    () => seedSelection(bundle?.mcpAllowlist ?? []),
  )
  const [phases, setPhases] = useState<Record<string, DiscoverPhase>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const discover = useCallback(
    async (connectionId: string, { refresh }: { refresh: boolean } = { refresh: false }) => {
      setPhases((prev) => ({
        ...prev,
        [connectionId]: { kind: 'loading' },
      }))
      try {
        const result = await discoverMcpTools(connectionId)
        if (result.ok) {
          setPhases((prev) => ({
            ...prev,
            [connectionId]: {
              kind: 'loaded',
              tools: result.tools,
              message: result.message,
            },
          }))
        } else {
          setPhases((prev) => ({
            ...prev,
            [connectionId]: {
              kind: 'failed',
              message: `${result.code} — ${result.message}`,
            },
          }))
        }
      } catch (e) {
        setPhases((prev) => ({
          ...prev,
          [connectionId]: {
            kind: 'failed',
            message:
              e instanceof ApiError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : 'Discovery failed',
          },
        }))
      }
      // Surface any unused var to keep eslint happy about the refresh flag.
      void refresh
    },
    [],
  )

  const toggleOpen = useCallback(
    (connectionId: string) => {
      setOpenId((current) => {
        const next = current === connectionId ? null : connectionId
        if (next && !phases[next]) {
          void discover(next)
        }
        return next
      })
    },
    [discover, phases],
  )

  const toggleTool = useCallback(
    (connectionId: string, toolName: string) => {
      setSelection((prev) => {
        const current = prev[connectionId] ?? new Set<string>()
        const next = new Set(current)
        if (next.has(toolName)) next.delete(toolName)
        else next.add(toolName)
        return { ...prev, [connectionId]: next }
      })
    },
    [],
  )

  const save = useCallback(async () => {
    setErr(null)
    setBusy(true)
    try {
      const tools: AllowlistEntry[] = []
      for (const [connId, names] of Object.entries(selection)) {
        for (const name of names) {
          tools.push({ mcpConnectionId: connId, toolName: name })
        }
      }
      await setAgentMcpTools(agentId, tools)
      setSavedAt(Date.now())
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to save allowlist',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, onDone, selection, setAgentMcpTools])

  const totalSelected = useMemo(
    () =>
      Object.values(selection).reduce((sum, set) => sum + set.size, 0),
    [selection],
  )

  return (
    <div className="add-resource-form mcp-picker">
      <div className="add-resource-list-head">
        <div>
          <div className="add-resource-list-title">MCP tools</div>
          <div className="add-resource-list-hint">
            Pick the tools this agent can invoke. Names are auto-prefixed
            with the connection slug at runtime
            (<code>notion__search</code>, <code>slack__search</code>).
          </div>
        </div>
      </div>

      {mcpConnections.length === 0 ? (
        <div className="add-resource-empty">
          No MCP connections yet. Create one to get started.
        </div>
      ) : (
        <div className="mcp-picker-list">
          {mcpConnections.map((conn) => {
            const selected = selection[conn.id] ?? new Set<string>()
            const phase = phases[conn.id] ?? { kind: 'idle' }
            const isOpen = openId === conn.id
            const availableNames =
              phase.kind === 'loaded'
                ? new Set(phase.tools.map((t) => t.name))
                : null
            const missing = availableNames
              ? [...selected].filter((n) => !availableNames.has(n))
              : []
            return (
              <section
                key={conn.id}
                className={`mcp-picker-conn${isOpen ? ' is-open' : ''}`}
              >
                <div className="mcp-picker-conn-head">
                  <button
                    type="button"
                    className="mcp-picker-conn-title"
                    onClick={() => toggleOpen(conn.id)}
                    aria-expanded={isOpen}
                  >
                    <span className="add-resource-provider-icon" aria-hidden="true">
                      M
                    </span>
                    <span className="mcp-picker-conn-copy">
                      <strong>{conn.name}</strong>
                      <span className="add-resource-option-sub">
                        {conn.transport} · {summarizeTarget(conn)}
                      </span>
                    </span>
                    <span className="mcp-picker-selected-count">
                      {selected.size > 0
                        ? `${selected.size} selected`
                        : 'none selected'}
                    </span>
                    <span className="resource-tray-chevron" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm mcp-picker-conn-edit"
                    onClick={() => onEdit(conn)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                </div>

                {isOpen ? (
                  <div className="mcp-picker-body">
                    <div className="mcp-picker-body-toolbar">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void discover(conn.id, { refresh: true })}
                        disabled={
                          phase.kind === 'loading' || busy
                        }
                      >
                        {phase.kind === 'loading'
                          ? 'Discovering…'
                          : 'Re-discover'}
                      </button>
                      {phase.kind === 'loaded' ? (
                        <span className="muted">{phase.message}</span>
                      ) : null}
                    </div>

                    {phase.kind === 'idle' || phase.kind === 'loading' ? (
                      <div className="mcp-picker-placeholder">
                        {phase.kind === 'loading'
                          ? 'Starting MCP and listing tools…'
                          : 'Click Re-discover to list tools.'}
                      </div>
                    ) : null}

                    {phase.kind === 'failed' ? (
                      <div
                        className="status-strip error"
                        role="alert"
                      >
                        {phase.message}
                      </div>
                    ) : null}

                    {phase.kind === 'loaded' ? (
                      <>
                        {missing.length > 0 ? (
                          <div
                            className="status-strip saving mcp-picker-missing"
                            role="status"
                          >
                            <strong>{missing.length} missing tool(s):</strong>{' '}
                            {missing.map((name) => (
                              <span key={name} className="badge mono">
                                {name}
                              </span>
                            ))}
                            . Uncheck to remove from the allowlist.
                          </div>
                        ) : null}
                        {phase.tools.length === 0 ? (
                          <div className="mcp-picker-placeholder">
                            This MCP advertised zero tools.
                          </div>
                        ) : (
                          <ul className="mcp-picker-tool-list">
                            {phase.tools.map((tool) => {
                              const checked = selected.has(tool.name)
                              const previewName = `${slugify(conn.name)}__${tool.name}`
                              return (
                                <li
                                  key={tool.name}
                                  className="mcp-picker-tool-row"
                                >
                                  <label className="mcp-picker-tool-label">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        toggleTool(conn.id, tool.name)
                                      }
                                      disabled={busy}
                                    />
                                    <span className="mcp-picker-tool-copy">
                                      <span className="mcp-picker-tool-name mono">
                                        {previewName}
                                      </span>
                                      {tool.description &&
                                      tool.description.length <=
                                        MCP_TOOL_DESC_COLLAPSE_LEN ? (
                                        <span className="mcp-picker-tool-desc">
                                          {tool.description}
                                        </span>
                                      ) : null}
                                    </span>
                                  </label>
                                  {tool.description &&
                                  tool.description.length >
                                    MCP_TOOL_DESC_COLLAPSE_LEN ? (
                                    <details className="mcp-picker-tool-desc-details">
                                      <summary className="mcp-picker-tool-desc-summary">
                                        Tool description
                                      </summary>
                                      <div className="mcp-picker-tool-desc mcp-picker-tool-desc-body">
                                        {tool.description}
                                      </div>
                                    </details>
                                  ) : null}
                                </li>
                              )
                            })}
                            {[...selected]
                              .filter((n) => !availableNames?.has(n))
                              .map((n) => (
                                <li
                                  key={`missing-${n}`}
                                  className="mcp-picker-tool-row mcp-picker-tool-row-missing"
                                >
                                  <label className="mcp-picker-tool-label">
                                    <input
                                      type="checkbox"
                                      checked
                                      onChange={() =>
                                        toggleTool(conn.id, n)
                                      }
                                      disabled={busy}
                                    />
                                    <span className="mcp-picker-tool-copy">
                                      <span className="mcp-picker-tool-name mono">
                                        {slugify(conn.name)}__{n}
                                      </span>
                                      <span className="mcp-picker-tool-desc">
                                        no longer advertised by this
                                        connection
                                      </span>
                                    </span>
                                  </label>
                                </li>
                              ))}
                          </ul>
                        )}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      )}

      <section className="add-resource-choice-section">
        <button
          type="button"
          className="add-resource-create-card"
          onClick={onCreateNew}
          disabled={busy}
        >
          <span className="icon-plus" aria-hidden="true" />
          <span className="add-resource-create-copy">
            <strong>Add a new MCP connection</strong>
            <span>
              Register a Notion / Slack / custom MCP and allowlist its
              tools from here.
            </span>
          </span>
        </button>
      </section>

      <ErrorText message={err} />

      <div className="add-resource-actions add-resource-actions--toolbar">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onDone}
          disabled={busy}
        >
          Close
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={busy || mcpConnections.length === 0}
        >
          {busy
            ? 'Saving…'
            : `Save (${totalSelected} tool${totalSelected === 1 ? '' : 's'})`}
        </button>
      </div>

      {savedAt !== null ? (
        <div className="status-strip saved" role="status">
          Allowlist updated.
        </div>
      ) : null}
    </div>
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────

function seedSelection(
  allowlist: readonly { mcpConnectionId: string; toolName: string }[],
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {}
  for (const entry of allowlist) {
    const set = out[entry.mcpConnectionId] ?? new Set<string>()
    set.add(entry.toolName)
    out[entry.mcpConnectionId] = set
  }
  return out
}

function summarizeTarget(conn: McpConnectionResponse): string {
  if (conn.transport === 'stdio') {
    const args = conn.argsJson.length > 0 ? ` ${conn.argsJson.join(' ')}` : ''
    return `${conn.commandOrUrl}${args}`
  }
  return conn.commandOrUrl
}

function slugify(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}
