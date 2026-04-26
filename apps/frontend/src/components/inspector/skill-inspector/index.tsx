/**
 * Read-only skill inspector. The markdown body is rendered as plain text
 * (no markdown renderer wired up yet) so users can verify the content
 * without surprises.
 */

import type { AgentResponse, SkillResponse } from '@agent-bridge/shared'

export function SkillInspector({
  skill,
  agent,
}: {
  skill: SkillResponse
  agent: AgentResponse | null
}) {
  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Skill</span>
        </div>
        <div className="read-row">
          <span className="read-label">Name</span>
          <span className="read-value">{skill.name}</span>
        </div>
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
          <span>Markdown body</span>
        </div>
        <pre className="code-block">{skill.markdownBody}</pre>
      </section>

      <p className="muted" style={{ fontSize: 12 }}>
        Editing lands in Phase 1F.
      </p>
    </div>
  )
}
