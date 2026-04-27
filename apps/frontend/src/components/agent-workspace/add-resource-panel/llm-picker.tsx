import { useCallback, useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { ErrorText } from './form-atoms'

export function LlmPicker({
  agentId,
  onCreateNew,
  onDone,
}: {
  readonly agentId: string
  readonly onCreateNew: () => void
  readonly onDone: () => void
}) {
  const { llmProviders, agents, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const currentId = agent?.llmProviderId ?? null
  const currentProvider =
    llmProviders.find((provider) => provider.id === currentId) ?? null
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const assign = useCallback(
    async (providerId: string | null) => {
      setErr(null)
      setBusyId(providerId ?? 'clear')
      try {
        await patchAgent(agentId, { llmProviderId: providerId })
        onDone()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to assign LLM',
        )
      } finally {
        setBusyId(null)
      }
    },
    [agentId, onDone, patchAgent],
  )

  return (
    <div className="add-resource-form add-resource-llm-form">
      <div className="add-resource-list-head">
        <div>
          <div className="add-resource-list-title">LLM provider</div>
          <div className="add-resource-list-hint">
            Choose the model backend this agent will use for chat and runs.
          </div>
        </div>
      </div>

      <div className="add-resource-current-card">
        <span className="add-resource-current-icon llm" aria-hidden="true">
          L
        </span>
        <div className="add-resource-current-copy">
          <span className="add-resource-current-label">Current provider</span>
          <strong>{currentProvider?.label ?? 'No provider assigned'}</strong>
          <span className="add-resource-current-meta">
            {currentProvider
              ? `${currentProvider.kind}${currentProvider.defaultModel ? ` · ${currentProvider.defaultModel}` : ''}`
              : 'Chat will be unavailable until a provider is assigned.'}
          </span>
        </div>
      </div>

      {llmProviders.length === 0 ? (
        <div className="add-resource-empty">
          No available providers yet. Create a provider below to assign it.
        </div>
      ) : (
        <section className="add-resource-choice-section">
          <div className="add-resource-choice-label">Available providers</div>
          <div className="add-resource-option-grid">
            {llmProviders.map((p) => {
              const active = p.id === currentId
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`add-resource-option add-resource-option-row${
                    active ? ' active' : ''
                  }`}
                  onClick={() => void assign(p.id)}
                  disabled={busyId !== null}
                >
                  <span className="add-resource-provider-icon" aria-hidden="true">
                    L
                  </span>
                  <span className="add-resource-provider-copy">
                    <span className="add-resource-option-title">{p.label}</span>
                    <span className="add-resource-option-sub">
                      {p.kind}
                      {p.defaultModel ? ` · ${p.defaultModel}` : ''}
                      {busyId === p.id ? ' · saving...' : ''}
                    </span>
                  </span>
                  {active ? (
                    <span className="add-resource-option-badge">Current</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </section>
      )}

      <section className="add-resource-choice-section">
        <div className="add-resource-choice-label">Create provider</div>
        <button
          type="button"
          className="add-resource-create-card"
          onClick={onCreateNew}
        >
          <span className="icon-plus" aria-hidden="true" />
          <span className="add-resource-create-copy">
            <strong>Create a new LLM provider</strong>
            <span>Add credentials and assign it to this agent.</span>
          </span>
        </button>
      </section>

      {currentId ? (
        <button
          type="button"
          className="add-resource-clear"
          onClick={() => void assign(null)}
          disabled={busyId !== null}
        >
          Clear current LLM
        </button>
      ) : null}
      <ErrorText message={err} />
    </div>
  )
}
