/**
 * MCP connection inspector. Read-only by default — shows the stored
 * config + which agents allowlist which tools. Switching to "Edit"
 * swaps in the shared `McpForm` (same component used by the quick-add
 * panel), so there's ONE form implementation for both create and edit.
 *
 * Changes to name / env / headers / allow_host_home cascade to the
 * workspace context automatically via `patchMcpConnection`, so the
 * sibling tray and the agent-side picker re-render without a refetch.
 */

import { useState } from 'react'
import type { McpConnectionResponse } from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import { McpForm } from '../../agent-workspace/add-resource-panel/mcp-form'

type Mode = 'read' | 'edit'

export function McpInspector({
  connection,
  workspace,
}: {
  connection: McpConnectionResponse
  workspace: WorkspaceContextValue
}) {
  const [mode, setMode] = useState<Mode>('read')

  const byAgent: Array<{
    agentName: string
    agentSlug: string
    tools: string[]
  }> = []
  for (const agent of workspace.agents) {
    const bundle = workspace.agentResources[agent.id]
    if (!bundle) continue
    const tools = bundle.mcpAllowlist
      .filter((e) => e.mcpConnectionId === connection.id && e.enabled)
      .map((e) => e.toolName)
    if (tools.length > 0) {
      byAgent.push({
        agentName: agent.name,
        agentSlug: agent.slug,
        tools,
      })
    }
  }

  if (mode === 'edit') {
    return (
      <div className="inspector">
        <McpForm
          existing={connection}
          onCancel={() => setMode('read')}
          onDone={() => setMode('read')}
        />
      </div>
    )
  }

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>MCP connection</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setMode('edit')}
          >
            Edit
          </button>
        </div>
        <div className="read-row">
          <span className="read-label">Name</span>
          <span className="read-value">{connection.name}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Transport</span>
          <span className="read-value mono">{connection.transport}</span>
        </div>
        <div className="read-row">
          <span className="read-label">
            {connection.transport === 'stdio' ? 'Command' : 'URL'}
          </span>
          <span className="read-value mono">{connection.commandOrUrl}</span>
        </div>
        {connection.argsJson.length > 0 ? (
          <div className="read-row">
            <span className="read-label">Args</span>
            <span className="read-value mono">
              {connection.argsJson.join(' ')}
            </span>
          </div>
        ) : null}
        <div className="read-row">
          <span className="read-label">Secrets</span>
          <span className="read-value">
            {connection.env.set ? 'env · ' : ''}
            {connection.headers.set ? 'headers' : ''}
            {!connection.env.set && !connection.headers.set ? '—' : ''}
          </span>
        </div>
        {connection.transport === 'stdio' && connection.allowHostHome ? (
          <div className="read-row">
            <span className="read-label">Host HOME</span>
            <span className="read-value">allowed (advanced)</span>
          </div>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Allowlisted by {byAgent.length} agent(s)</span>
        </div>
        {byAgent.length === 0 ? (
          <div className="rail-empty">
            <div className="rail-empty-title">No allowlist yet</div>
            <div className="rail-empty-hint">
              Agents gate which tools they can call via the per-agent
              allowlist. Open an agent and pick tools from its MCP panel.
            </div>
          </div>
        ) : (
          <ul className="read-list">
            {byAgent.map((a) => (
              <li key={a.agentSlug}>
                <div className="read-list-primary">{a.agentName}</div>
                <div className="read-list-secondary">
                  {a.tools.map((t) => (
                    <span key={t} className="badge mono">
                      {t}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
