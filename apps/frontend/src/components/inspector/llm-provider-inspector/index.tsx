/**
 * Read-only LLM provider inspector.
 *
 * Plus a "Test connection" panel (Phase 3a) that runs a live smoke
 * check against the provider's endpoint using the saved row. Result is
 * ephemeral — it lives in the panel's local state only.
 */

import type { LlmProviderResponse } from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import { RefreshModelsButton } from './refresh-models'
import { TestConnection } from './test-connection'

import './index.css'

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
          <span>Connection</span>
        </div>
        <TestConnection providerId={provider.id} />
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Models</span>
          {provider.models ? (
            <span className="muted" style={{ fontSize: 11.5 }}>
              {provider.models.models.length} cached ·{' '}
              {formatRelative(provider.models.fetchedAt)}
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 11.5 }}>
              not refreshed yet
            </span>
          )}
        </div>
        <RefreshModelsButton providerId={provider.id} />
        {provider.models && provider.models.models.length > 0 ? (
          <ul className="model-cache-list">
            {provider.models.models.slice(0, 12).map((m) => (
              <li key={m} className="mono">
                {m}
              </li>
            ))}
            {provider.models.models.length > 12 ? (
              <li className="muted">
                +{provider.models.models.length - 12} more
              </li>
            ) : null}
          </ul>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Used by {users.length} agent(s)</span>
        </div>
        {users.length === 0 ? (
          <div className="rail-empty">
            <div className="rail-empty-title">No agents use this provider</div>
            <div className="rail-empty-hint">
              Pick this provider from an agent's Details panel to link it.
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

function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
