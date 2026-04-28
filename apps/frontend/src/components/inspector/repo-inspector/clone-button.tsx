/**
 * CloneButton — kicks off `POST /api/repos/:id/clone` and leaves the rest of
 * the UI responsibility to the parent inspector:
 *
 *   - Optimistic update: the parent flips its local copy of `repo.status`
 *     to `'cloning'` immediately (so the button disables + the repo pill
 *     changes colour without waiting for the roundtrip).
 *   - Server echo: the HTTP 202 confirms the DB already flipped the same
 *     way; if it fails, the parent reverts.
 *   - Terminal state: `RepoLog` listens on the `repo:<id>` stream and
 *     calls `workspace.refreshRepo()` once a `.ok`/`.fail` event arrives,
 *     replacing the optimistic guess with the authoritative server row.
 *
 * This component is deliberately dumb: status comes in, click goes out. It
 * never sets local state of its own beyond ephemeral "posting" + error.
 */

import { useState } from 'react'
import type { RepoResponse } from '@agent-bridge/shared'
import { ApiError, cloneRepo } from '../../../lib/rpc'

export interface CloneButtonProps {
  repo: RepoResponse
  onOptimistic: () => void
  onRevert: () => void
  onStarted?: (info: { jobId: string; streamId: string }) => void
}

export function CloneButton({
  repo,
  onOptimistic,
  onRevert,
  onStarted,
}: CloneButtonProps) {
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCloning = repo.status === 'cloning'
  const disabled = posting || isCloning

  const handleClick = async () => {
    if (disabled) return
    setError(null)
    setPosting(true)
    onOptimistic()
    try {
      const res = await cloneRepo(repo.id)
      onStarted?.(res)
    } catch (err) {
      onRevert()
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Clone failed to start')
      }
    } finally {
      setPosting(false)
    }
  }

  const label =
    repo.status === 'cloned' || repo.status === 'ready'
      ? 'Re-clone'
      : repo.status === 'error'
        ? 'Retry clone'
        : 'Clone'

  return (
    <div className="inspector-repo-action">
      <button
        type="button"
        className="btn btn-primary btn-sm repo-action-button"
        onClick={handleClick}
        disabled={disabled}
      >
        {isCloning ? 'Cloning…' : label}
      </button>
      {error ? (
        <div className="status-strip error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}
