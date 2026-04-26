/**
 * Read-only tool inspector.
 */

import type { AgentResponse, ToolResponse } from '@agent-bridge/shared'

export function ToolInspector({
  tool,
  agent,
}: {
  tool: ToolResponse
  agent: AgentResponse | null
}) {
  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Tool</span>
        </div>
        <div className="read-row">
          <span className="read-label">Name</span>
          <span className="read-value">{tool.name}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Kind</span>
          <span className="read-value mono">{tool.kind}</span>
        </div>
        {tool.description ? (
          <div className="read-row">
            <span className="read-label">Description</span>
            <span className="read-value">{tool.description}</span>
          </div>
        ) : null}
        {agent ? (
          <div className="read-row">
            <span className="read-label">Agent</span>
            <span className="read-value">
              {agent.name} <code>{agent.slug}</code>
            </span>
          </div>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Config</span>
        </div>
        <pre className="code-block">
          {JSON.stringify(tool.configJson, null, 2)}
        </pre>
      </section>

      <p className="muted" style={{ fontSize: 12 }}>
        Editing lands in Phase 1F.
      </p>
    </div>
  )
}
