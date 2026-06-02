/**
 * "Attach repo" side-sheet — pick from the user's library.
 */

import { useMemo, useState } from 'react'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Link } from '../../lib/link'

function AttachRepoForm({
  agentId,
  onClose,
}: {
  agentId: string
  onClose: () => void
}) {
  const { repos, agentResources, attachRepo } = useWorkspace()
  const alreadyAttached = useMemo(
    () =>
      new Set(
        (agentResources[agentId]?.attachedRepos ?? []).map((a) => a.repo.id),
      ),
    [agentResources, agentId],
  )
  const eligible = useMemo(
    () => repos.filter((r) => !alreadyAttached.has(r.id)),
    [repos, alreadyAttached],
  )
  const opts: DropdownOption[] = useMemo(
    () =>
      eligible.map((r) => ({
        value: r.id,
        label: shortRepoName(r.remoteUrl),
        sub: r.branch + ' · ' + r.status,
      })),
    [eligible],
  )

  const [repoId, setRepoId] = useState<string | null>(null)
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!repoId) return
    setBusy(true)
    setErr(null)
    try {
      await attachRepo(agentId, {
        repoId,
        role: role.trim() || null,
        description: description.trim() || null,
      })
      toast.success('Repo attached')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to attach',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Attach repository"
      subtitle="Pick a repo from your library to give this agent read access to."
      primaryLabel="Attach"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!repoId}
    >
      {repos.length === 0 ? (
        <div className="ab-field">
          <div className="ab-field-help">
            You haven't added any repositories yet.{' '}
            <Link to="/library/repos" className="ab-text-link">
              Add one in Library
            </Link>
          </div>
        </div>
      ) : eligible.length === 0 ? (
        <div className="ab-field">
          <div className="ab-field-help">
            All your repos are already attached to this agent.
          </div>
        </div>
      ) : (
        <>
          <div className="ab-field">
            <span className="ab-field-label">Repository</span>
            <Dropdown
              value={repoId}
              onChange={setRepoId}
              options={opts}
              placeholder="Pick a repo"
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="ar-role">
              Role (optional)
            </label>
            <input
              id="ar-role"
              className="ab-input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. backend, docs, infra"
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="ar-desc">
              Description (optional)
            </label>
            <textarea
              id="ar-desc"
              className="ab-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this repo gives the agent visibility into."
            />
          </div>
          {err && (
            <div
              className="ab-field-help"
              style={{ color: 'var(--danger)' }}
              role="alert"
            >
              {err}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

export function AttachRepoSheet({
  open,
  agentId,
  onClose,
}: {
  open: boolean
  agentId: string
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Attach repository">
        <></>
      </Sheet>
    )
  }
  return <AttachRepoForm key={openCount} agentId={agentId} onClose={onClose} />
}
