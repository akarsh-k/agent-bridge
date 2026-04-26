/**
 * Read-only LLM provider inspector.
 */

import type { LlmProviderResponse } from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

export function LlmProviderInspector({
  provider,
  workspace,
}: {
  provider: LlmProviderResponse
  workspace: WorkspaceContextValue
}) {
  const users = workspace.agents.filter((a) => a.llmProviderId === provider.id)

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>LLM provider</span>
        </div>
        <div className="read-row">
          <span className="read-label">Label</span>
          <span className="read-value">{provider.label}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Kind</span>
          <span className="read-value mono">{provider.kind}</span>
        </div>
        {provider.baseUrl ? (
          <div className="read-row">
            <span className="read-label">Base URL</span>
            <span className="read-value mono">{provider.baseUrl}</span>
          </div>
        ) : null}
        {provider.defaultModel ? (
          <div className="read-row">
            <span className="read-label">Default model</span>
            <span className="read-value mono">{provider.defaultModel}</span>
          </div>
        ) : null}
        <div className="read-row">
          <span className="read-label">API key</span>
          <span className="read-value">
            {provider.apiKey.set ? 'configured' : '—'}
          </span>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Used by {users.length} agent(s)</span>
        </div>
        {users.length === 0 ? (
          <div className="rail-empty">
            <div className="rail-empty-title">No agents use this provider</div>
            <div className="rail-empty-hint">
              Pick this provider from an agent's Inspector to link it.
            </div>
          </div>
        ) : (
          <ul className="read-list">
            {users.map((u) => (
              <li key={u.id}>
                <div className="read-list-primary">{u.name}</div>
                <div className="read-list-secondary">
                  <code>{u.slug}</code>
                  {u.model ? (
                    <span className="badge mono">{u.model}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted" style={{ fontSize: 12 }}>
        Manage providers from Phase 1F.
      </p>
    </div>
  )
}
