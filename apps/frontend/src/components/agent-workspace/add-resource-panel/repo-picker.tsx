import { useCallback, useMemo, useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { ErrorText } from './form-atoms'
import { shortRemote } from './utils'

export function RepoPicker({
  agentId,
  onCreateNew,
  onDone,
}: {
  readonly agentId: string
  readonly onCreateNew: () => void
  readonly onDone: () => void
}) {
  const workspace = useWorkspace()
  const attached = useMemo(() => {
    const ids = new Set<string>()
    for (const a of workspace.agentResources[agentId]?.attachedRepos ?? []) {
      ids.add(a.repo.id)
    }
    return ids
  }, [agentId, workspace.agentResources])
  const available = useMemo(
    () => workspace.repos.filter((r) => !attached.has(r.id)),
    [attached, workspace.repos],
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const attach = useCallback(
    async (repoId: string) => {
      setErr(null)
      setBusyId(repoId)
      try {
        await workspace.attachRepo(agentId, { repoId })
        onDone()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to attach repo',
        )
      } finally {
        setBusyId(null)
      }
    },
    [agentId, onDone, workspace],
  )

  return (
    <div className="add-resource-form">
      <div className="add-resource-list-head">
        <div>
          <div className="add-resource-list-title">Attach existing repo</div>
          <div className="add-resource-list-hint">
            Pick from repos already known to this workspace.
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreateNew}>
          New repo
        </button>
      </div>

      {available.length === 0 ? (
        <div className="add-resource-empty">
          {workspace.repos.length === 0
            ? 'No repos yet. Create one to attach it.'
            : 'Every repo is already attached to this agent.'}
        </div>
      ) : (
        <div className="add-resource-option-grid">
          {available.map((r) => (
            <button
              key={r.id}
              type="button"
              className="add-resource-option"
              onClick={() => void attach(r.id)}
              disabled={busyId !== null}
            >
              <span className="add-resource-option-title">
                {shortRemote(r.remoteUrl)}
              </span>
              <span className="add-resource-option-sub">
                {r.branch}
                {busyId === r.id ? ' · attaching...' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <ErrorText message={err} />
    </div>
  )
}
