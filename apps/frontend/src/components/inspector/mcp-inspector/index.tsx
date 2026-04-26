/**
 * Read-only MCP connection inspector. Shows transport + allowlisted tools
 * grouped by agent.
 */

import type { McpConnectionResponse } from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

export function McpInspector({
  connection,
  workspace,
}: {
  connection: McpConnectionResponse
  workspace: WorkspaceContextValue
}) {
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

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>MCP connection</span>
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
              allowlist.
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

      <p className="muted" style={{ fontSize: 12 }}>
        Create / rotate MCP connections from Phase 1F.
      </p>
    </div>
  )
}
