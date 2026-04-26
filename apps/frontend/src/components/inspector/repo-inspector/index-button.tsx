/**
 * IndexButton — kicks off `POST /api/repos/:id/index` (manual re-index /
 * retry-after-error). Mirrors `CloneButton`'s contract:
 *
 *   - Optimistic: parent flips its local `repo.status` to `'indexing'`.
 *   - Server echo: 202 confirms the DB transition; on HTTP error the
 *     parent reverts.
 *   - Terminal state: `RepoLog` will call `workspace.refreshRepo()` when
 *     `repo.index.ok`/`repo.index.fail` arrives.
 *
 * This button is *only* usable after a successful clone — the backend
 * enforces that (returns 409 for pending/cloning/indexing), so we disable
 * it visually too, otherwise the user clicks and gets a confusing error.
 *
 * Note: the very first index for a repo runs automatically via the
 * worker-side auto-chain. This button covers the re-index / retry paths.
 */

import { useState } from 'react'
import type { RepoResponse } from '@agent-bridge/shared'
import { ApiError, indexRepo } from '../../../lib/rpc'

export interface IndexButtonProps {
  repo: RepoResponse
  onOptimistic: () => void
  onRevert: () => void
  onStarted?: (info: { jobId: string; streamId: string }) => void
}

export function IndexButton({
  repo,
  onOptimistic,
  onRevert,
  onStarted,
}: IndexButtonProps) {
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isIndexing = repo.status === 'indexing'
  // The backend only accepts cloned|ready|error. Gate the UI to match.
  const canIndex =
    repo.status === 'cloned' ||
    repo.status === 'ready' ||
    repo.status === 'error'
  const disabled = posting || isIndexing || !canIndex

  const handleClick = async () => {
    if (disabled) return
    setError(null)
    setPosting(true)
    onOptimistic()
    try {
      const res = await indexRepo(repo.id)
      onStarted?.(res)
    } catch (err) {
      onRevert()
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Index failed to start')
      }
    } finally {
      setPosting(false)
    }
  }

  const label =
    repo.status === 'ready'
      ? 'Re-index'
      : repo.status === 'error'
        ? 'Retry index'
        : 'Index'

  return (
    <div className="inspector-repo-action">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleClick}
        disabled={disabled}
        title={
          canIndex ? undefined : 'Clone this repository first to index it.'
        }
      >
        {isIndexing ? 'Indexing…' : label}
      </button>
      {error ? (
        <div className="status-strip error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}
