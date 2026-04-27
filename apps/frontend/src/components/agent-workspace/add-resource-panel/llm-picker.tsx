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
    <div className="add-resource-form">
      <div className="add-resource-list-head">
        <div>
          <div className="add-resource-list-title">Assign provider</div>
          <div className="add-resource-list-hint">
            Choose an existing provider or create a new one.
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreateNew}>
          New provider
        </button>
      </div>

      {llmProviders.length === 0 ? (
        <div className="add-resource-empty">No LLM providers yet.</div>
      ) : (
        <div className="add-resource-option-grid">
          {llmProviders.map((p) => {
            const active = p.id === currentId
            return (
              <button
                key={p.id}
                type="button"
                className={`add-resource-option${active ? ' active' : ''}`}
                onClick={() => void assign(p.id)}
                disabled={busyId !== null}
              >
                <span className="add-resource-option-title">{p.label}</span>
                <span className="add-resource-option-sub">
                  {p.kind}
                  {p.defaultModel ? ` · ${p.defaultModel}` : ''}
                  {active ? ' · current' : ''}
                  {busyId === p.id ? ' · saving...' : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}

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
