/**
 * GraphSelectionPicker — left-side sidebar shown inside the GraphModal
 * when the user is on the Processes or Communities tab. Lists every
 * available cluster, lets them pick one. Selection flows back to the
 * modal which re-fetches the subgraph.
 *
 * The picker is mode-aware via the `kind` prop so we only fetch the
 * list endpoint for the active tab. Refetches when the modal mounts
 * a different repo.
 */

import { useEffect, useState } from 'react'
import type {
  RepoCommunitySummary,
  RepoProcessSummary,
} from '@agent-bridge/shared'
import {
  ApiError,
  listRepoCommunities,
  listRepoProcesses,
} from '../../lib/rpc'

export type PickerKind = 'processes' | 'communities'

type PickerItem =
  | { kind: 'process'; data: RepoProcessSummary }
  | { kind: 'community'; data: RepoCommunitySummary }

interface PickerProps {
  repoId: string
  kind: PickerKind
  selectedId: string | null
  onSelect: (id: string) => void
}

type Fetch =
  | { kind: 'loading' }
  | { kind: 'ready'; items: PickerItem[]; total: number | null }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }

export function GraphSelectionPicker({
  repoId,
  kind,
  selectedId,
  onSelect,
}: PickerProps) {
  const [state, setState] = useState<Fetch>({ kind: 'loading' })

  // Adjust-state-during-render on the (repoId, kind) pair so the
  // spinner flips back to "loading" the moment the user switches
  // tabs, without a useEffect cascade.
  const [seededFor, setSeededFor] = useState<string>('')
  const seedKey = `${repoId}:${kind}`
  if (seededFor !== seedKey) {
    setSeededFor(seedKey)
    setState({ kind: 'loading' })
  }

  useEffect(() => {
    let cancelled = false
    const fetcher =
      kind === 'processes'
        ? listRepoProcesses(repoId).then((r) => ({
            items: r.processes.map<PickerItem>((p) => ({
              kind: 'process' as const,
              data: p,
            })),
            total: r.total,
          }))
        : listRepoCommunities(repoId).then((r) => ({
            items: r.communities.map<PickerItem>((c) => ({
              kind: 'community' as const,
              data: c,
            })),
            total: r.total,
          }))
    fetcher
      .then(({ items, total }) => {
        if (cancelled) return
        if (items.length === 0) {
          setState({ kind: 'empty' })
        } else {
          setState({ kind: 'ready', items, total })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load'
        setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [repoId, kind])

  return (
    <aside className="graph-picker" aria-label={`${kind} picker`}>
      <header className="graph-picker-header">
        <span className="graph-picker-eyebrow">
          {kind === 'processes' ? 'Execution flows' : 'Semantic clusters'}
        </span>
        <span className="graph-picker-count">
          {state.kind === 'ready'
            ? state.total != null && state.total > state.items.length
              ? `${state.items.length} of ${state.total}`
              : state.items.length
            : ''}
        </span>
      </header>

      {state.kind === 'loading' ? (
        <div className="graph-picker-loading">Loading…</div>
      ) : null}
      {state.kind === 'error' ? (
        <div className="graph-picker-error">{state.message}</div>
      ) : null}
      {state.kind === 'empty' ? (
        <div className="graph-picker-empty">
          {kind === 'processes'
            ? 'No execution flows in this index.'
            : 'No communities in this index.'}
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <ul className="graph-picker-list">
          {state.items.map((it) => (
            <li key={it.data.id}>
              <button
                type="button"
                className={
                  'graph-picker-item' +
                  (it.data.id === selectedId ? ' is-selected' : '')
                }
                onClick={() => onSelect(it.data.id)}
                title={it.data.id}
              >
                {it.kind === 'process' ? (
                  <ProcessRow data={it.data} />
                ) : (
                  <CommunityRow data={it.data} />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  )
}

function ProcessRow({ data }: { data: RepoProcessSummary }) {
  return (
    <>
      <div className="graph-picker-item-title">{data.label}</div>
      <div className="graph-picker-item-meta">
        {data.stepCount != null ? (
          <span className="ab-mono">{data.stepCount} steps</span>
        ) : null}
        {data.processType ? (
          <span
            className={
              'graph-picker-chip chip-' +
              (data.processType === 'cross_community' ? 'cross' : 'intra')
            }
          >
            {data.processType === 'cross_community' ? 'cross' : 'intra'}
          </span>
        ) : null}
      </div>
    </>
  )
}

function CommunityRow({ data }: { data: RepoCommunitySummary }) {
  return (
    <>
      <div className="graph-picker-item-title">{data.label}</div>
      <div className="graph-picker-item-meta">
        {data.symbolCount != null ? (
          <span className="ab-mono">{data.symbolCount} symbols</span>
        ) : null}
        {data.cohesion != null ? (
          <span
            className="ab-mono graph-picker-chip chip-cohesion"
            title="Cohesion 0..1 — higher means tighter cluster"
          >
            {data.cohesion.toFixed(2)}
          </span>
        ) : null}
      </div>
    </>
  )
}
