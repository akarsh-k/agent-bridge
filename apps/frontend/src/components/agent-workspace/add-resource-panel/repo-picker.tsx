import { useCallback, useMemo, useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { ErrorText } from './form-atoms'
import { shortRemote } from './utils'

const EMPTY_ATTACHED_REPOS: NonNullable<
  ReturnType<typeof useWorkspace>['agentResources'][string]
>['attachedRepos'] = []

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
  const attachedRepos =
    workspace.agentResources[agentId]?.attachedRepos ?? EMPTY_ATTACHED_REPOS
  const attached = useMemo(() => {
    const ids = new Set<string>()
    for (const a of attachedRepos) {
      ids.add(a.repo.id)
    }
    return ids
  }, [attachedRepos])
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
    <div className="add-resource-form add-resource-repo-form">
      <div className="add-resource-list-head">
        <div>
          <div className="add-resource-list-title">Repository context</div>
          <div className="add-resource-list-hint">
            Attach source code this agent should use as context.
          </div>
        </div>
      </div>

      <section className="add-resource-choice-section">
        <div className="add-resource-choice-label">Attached to this agent</div>
        {attachedRepos.length === 0 ? (
          <div className="add-resource-empty">
            No repositories attached yet.
          </div>
        ) : (
          <div className="add-resource-option-grid">
            {attachedRepos.map((attachedRepo) => (
              <div
                key={attachedRepo.repo.id}
                className="add-resource-repo-row is-attached"
              >
                <RepoIcon remoteUrl={attachedRepo.repo.remoteUrl} />
                <span className="add-resource-repo-copy">
                  <span className="add-resource-option-title">
                    {shortRemote(attachedRepo.repo.remoteUrl)}
                  </span>
                  <span className="add-resource-option-sub">
                    {attachedRepo.repo.branch}
                    {attachedRepo.role ? ` · ${attachedRepo.role}` : ''}
                  </span>
                </span>
                <span className="add-resource-option-badge">Attached</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {available.length === 0 ? (
        <section className="add-resource-choice-section">
          <div className="add-resource-choice-label">Available repos</div>
          <div className="add-resource-empty">
            {workspace.repos.length === 0
              ? 'No repos exist in this workspace yet.'
              : 'Every repo in this workspace is already attached.'}
          </div>
        </section>
      ) : (
        <section className="add-resource-choice-section">
          <div className="add-resource-choice-label">Available repos</div>
          <div className="add-resource-option-grid">
            {available.map((r) => (
              <button
                key={r.id}
                type="button"
                className="add-resource-option add-resource-repo-row"
                onClick={() => void attach(r.id)}
                disabled={busyId !== null}
              >
                <RepoIcon remoteUrl={r.remoteUrl} />
                <span className="add-resource-repo-copy">
                  <span className="add-resource-option-title">
                    {shortRemote(r.remoteUrl)}
                  </span>
                  <span className="add-resource-option-sub">
                    {r.branch}
                    {busyId === r.id ? ' · attaching...' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="add-resource-choice-section">
        <div className="add-resource-choice-label">Create repo</div>
        <button
          type="button"
          className="add-resource-create-card"
          onClick={onCreateNew}
        >
          <span className="icon-plus" aria-hidden="true" />
          <span className="add-resource-create-copy">
            <strong>Add a new repository</strong>
            <span>Create a repo record and attach it to this agent.</span>
          </span>
        </button>
      </section>

      <ErrorText message={err} />
    </div>
  )
}

function RepoIcon({ remoteUrl }: { readonly remoteUrl: string }) {
  const isGithub = remoteUrl.toLowerCase().includes('github.com')

  if (!isGithub) {
    return (
      <span className="add-resource-repo-icon" aria-hidden="true">
        R
      </span>
    )
  }

  return (
    <span className="add-resource-repo-icon github" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          fill="currentColor"
          d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.77.4.08.55-.18.55-.4 0-.2-.01-.86-.01-1.56-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.43 7.43 0 0 1 8 3.96c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.75.54 1.52 0 1.09-.01 1.97-.01 2.24 0 .22.15.48.55.4A8.13 8.13 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"
        />
      </svg>
    </span>
  )
}
