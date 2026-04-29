/**
 * GraphButton — opens the GraphModal for a repo whose status is `'ready'`.
 *
 * Disabled when the repo has not been indexed yet — `meta.json` is the
 * gate the backend uses, but the worker stamps `status='ready'` in the
 * same call that produces it, so the UI uses status as a cheap proxy.
 *
 * The button stays mounted but inert pre-`ready` so the inspector layout
 * doesn't shift the moment indexing finishes.
 */

import { useState } from 'react'
import type { RepoResponse } from '@agent-bridge/shared'
import { GraphModal } from './graph-modal'

export interface GraphButtonProps {
  repo: RepoResponse
}

export function GraphButton({ repo }: GraphButtonProps) {
  const [open, setOpen] = useState(false)

  const disabled = repo.status !== 'ready'
  const title = disabled
    ? 'Index this repository before viewing its graph.'
    : 'Render the indexed knowledge graph.'

  return (
    <div className="inspector-repo-action">
      <button
        type="button"
        className="btn btn-ghost btn-sm repo-action-button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={title}
      >
        View graph
      </button>
      {open ? <GraphModal repo={repo} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
