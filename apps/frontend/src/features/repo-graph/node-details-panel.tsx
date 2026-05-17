/**
 * NodeDetailsPanel — right-side slide-in inside the GraphModal that
 * surfaces a clicked node's metadata + immediate neighborhood.
 *
 * Render contract:
 *   - Open whenever `selected` is non-null. Hides itself (renders
 *     null) otherwise; the caller controls visibility via state.
 *   - Always re-fetches neighbors when the selected node changes.
 *     The previous payload stays mounted as `stale` so the section
 *     headers don't flash to "0 callers" mid-fetch.
 *   - Neighbor rows are clickable. They call `onSelect(neighborId)`,
 *     letting the parent swap the selected node + scroll the graph
 *     to bring the new node into view.
 *
 * The panel intentionally does not own the close logic for Esc —
 * the parent modal owns one global Esc handler so we don't fight
 * over it.
 */

import { useEffect, useState } from 'react'
import type {
  RepoFileSliceResponse,
  RepoGraphNeighbor,
  RepoGraphNeighborsResponse,
  RepoGraphNode,
  RepoGraphNodeKind,
} from '@agent-bridge/shared'
import {
  ApiError,
  getRepoFileSlice,
  getRepoGraphNeighbors,
} from '../../lib/rpc'

const KIND_LABEL: Record<RepoGraphNodeKind, string> = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
  file: 'File',
  folder: 'Folder',
  process: 'Process',
  community: 'Community',
}

type NeighborGroup = {
  key: 'callers' | 'callees' | 'parents' | 'children'
  label: string
  filter: (n: RepoGraphNeighbor) => boolean
  total: (r: RepoGraphNeighborsResponse) => number | null
}

const NEIGHBOR_GROUPS: readonly NeighborGroup[] = [
  {
    key: 'callers',
    label: 'Callers',
    filter: (n) => n.relation === 'caller',
    total: (r) => r.totals.callers,
  },
  {
    key: 'callees',
    label: 'Calls',
    filter: (n) => n.relation === 'callee',
    total: (r) => r.totals.callees,
  },
  {
    key: 'parents',
    label: 'Contained in',
    filter: (n) => n.relation === 'parent',
    total: (r) => r.totals.parents,
  },
  {
    key: 'children',
    label: 'Contains',
    filter: (n) => n.relation === 'child',
    total: (r) => r.totals.children,
  },
]

interface NodeDetailsPanelProps {
  repoId: string
  selected: RepoGraphNode | null
  onClose: () => void
  /** Called when the user clicks a neighbor row. The parent should
   *  flip its selected-node state — the panel just emits the id. */
  onSelect: (nodeId: string) => void
}

type Fetch =
  | { kind: 'loading' }
  | { kind: 'ready'; data: RepoGraphNeighborsResponse }
  | { kind: 'error'; message: string }

type FileFetch =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: RepoFileSliceResponse }
  | { kind: 'error'; message: string }

export function NodeDetailsPanel({
  repoId,
  selected,
  onClose,
  onSelect,
}: NodeDetailsPanelProps) {
  const [fetchState, setFetchState] = useState<Fetch>({ kind: 'loading' })
  // Keep the last successful payload mounted while a new one is in
  // flight so neighbor sections don't blank out on every navigation.
  const [stale, setStale] = useState<RepoGraphNeighborsResponse | null>(null)
  const [fileFetch, setFileFetch] = useState<FileFetch>({ kind: 'idle' })
  // Track the id we've kicked a fetch for. Adjust-state-during-render
  // pattern instead of a useEffect-with-setState so the spinner flip
  // batches with the same render that detected the change.
  const [seenForId, setSeenForId] = useState<string | null>(null)
  const targetId = selected?.id ?? null
  if (targetId !== seenForId) {
    setSeenForId(targetId)
    setFetchState({ kind: 'loading' })
    // File slice flips to 'loading' iff the selected node has a
    // source location; otherwise 'idle' (process / community focal
    // nodes have nothing to preview).
    setFileFetch(selected?.filePath ? { kind: 'loading' } : { kind: 'idle' })
  }

  // File-slice preview. Fires when the selected node has a
  // filePath; idle otherwise (e.g. process / community focal nodes
  // don't map to a source location). Backend pads with 3 lines of
  // context on each side.
  useEffect(() => {
    if (!selected) return
    const filePath = selected.filePath
    // No filePath → no fetch. The earlier adjust-state-during-render
    // guard already reset the state to 'idle' when `seenForId` flipped,
    // so we don't need to re-set it here (would trigger
    // set-state-in-effect lint).
    if (!filePath) return
    let cancelled = false
    getRepoFileSlice(
      repoId,
      filePath,
      selected.startLine ?? null,
      selected.endLine ?? selected.startLine ?? null,
    )
      .then((data) => {
        if (cancelled) return
        setFileFetch({ kind: 'ready', data })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load file'
        setFileFetch({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [repoId, selected])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    getRepoGraphNeighbors(repoId, selected.id)
      .then((data) => {
        if (cancelled) return
        setStale(data)
        setFetchState({ kind: 'ready', data })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load neighbors'
        setFetchState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [repoId, selected])

  if (!selected) return null

  const data =
    fetchState.kind === 'ready'
      ? fetchState.data
      : fetchState.kind === 'loading' && stale && stale.nodeId === selected.id
        ? stale
        : null
  const errorMessage =
    fetchState.kind === 'error' ? fetchState.message : null

  const filePath = selected.filePath ?? null
  const lineRange = formatLineRange(selected.startLine, selected.endLine)
  const filePathLine = filePath
    ? lineRange
      ? `${filePath}:${lineRange}`
      : filePath
    : null

  return (
    <aside className="graph-details-panel" aria-label="Node details">
      <header className="graph-details-header">
        <div className="graph-details-eyebrow">
          {KIND_LABEL[selected.kind] ?? 'Node'}
        </div>
        <div className="graph-details-name" title={selected.name}>
          {selected.name}
        </div>
        <button
          type="button"
          className="graph-details-close"
          onClick={onClose}
          aria-label="Close details"
        >
          ×
        </button>
      </header>

      {filePathLine ? (
        <div className="graph-details-row">
          <span className="graph-details-row-label">Location</span>
          <button
            type="button"
            className="graph-details-row-value graph-details-copy"
            title="Copy path:line"
            onClick={() => {
              void navigator.clipboard.writeText(filePathLine).catch(() => {})
            }}
          >
            <span className="ab-mono">{filePathLine}</span>
            <span className="graph-details-copy-hint">copy</span>
          </button>
        </div>
      ) : null}

      {selected.degree != null ? (
        <div className="graph-details-row">
          <span className="graph-details-row-label">Edges</span>
          <span className="graph-details-row-value ab-mono">
            {selected.degree}
          </span>
        </div>
      ) : null}

      <FilePreview
        fetchState={fileFetch}
        highlightStart={selected.startLine ?? null}
        highlightEnd={selected.endLine ?? selected.startLine ?? null}
      />

      <div className="graph-details-divider" />

      {errorMessage ? (
        <div className="graph-details-error">{errorMessage}</div>
      ) : null}

      {NEIGHBOR_GROUPS.map((g) => {
        const items = data ? data.neighbors.filter(g.filter) : []
        const total = data ? g.total(data) : null
        if (items.length === 0 && (total == null || total === 0)) return null
        return (
          <section
            key={g.key}
            className="graph-details-section"
            aria-label={g.label}
          >
            <div className="graph-details-section-head">
              <span className="graph-details-section-label">{g.label}</span>
              <span className="graph-details-section-count">
                {total != null && total > items.length
                  ? `${items.length} of ${total}`
                  : items.length}
              </span>
            </div>
            <ul className="graph-details-list">
              {items.map((n) => (
                <li key={`${g.key}-${n.id}`}>
                  <button
                    type="button"
                    className="graph-details-link"
                    onClick={() => onSelect(n.id)}
                    title={n.id}
                  >
                    <span className={`graph-details-dot kind-${n.kind}`} />
                    <span className="graph-details-link-name">{n.name}</span>
                    <span className="graph-details-link-meta">
                      {KIND_LABEL[n.kind]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {fetchState.kind === 'loading' && !stale ? (
        <div className="graph-details-loading">Loading neighbors…</div>
      ) : null}
      {fetchState.kind === 'ready' &&
      fetchState.data.neighbors.length === 0 ? (
        <div className="graph-details-empty">
          No connected nodes in the current graph.
        </div>
      ) : null}
    </aside>
  )
}

function formatLineRange(
  start: number | null | undefined,
  end: number | null | undefined,
): string | null {
  if (start == null) return null
  if (end == null || end === start) return String(start)
  return `${start}-${end}`
}

interface FilePreviewProps {
  fetchState: FileFetch
  /** The symbol's actual start/end line, used to mark the matching
   *  rows inside the slice (the slice itself includes context lines
   *  on either side so the highlighted span shows in context). */
  highlightStart: number | null
  highlightEnd: number | null
}

function FilePreview({
  fetchState,
  highlightStart,
  highlightEnd,
}: FilePreviewProps) {
  if (fetchState.kind === 'idle') return null
  if (fetchState.kind === 'loading') {
    return <div className="graph-details-loading">Loading source…</div>
  }
  if (fetchState.kind === 'error') {
    return (
      <div className="graph-details-error">{fetchState.message}</div>
    )
  }
  const slice = fetchState.data
  return (
    <section
      className="graph-details-section"
      aria-label="Source preview"
    >
      <div className="graph-details-section-head">
        <span className="graph-details-section-label">Source</span>
        <span
          className="graph-details-section-count ab-mono"
          title={`${slice.totalLines} lines total`}
        >
          {slice.startLine}–{slice.endLine}
          {slice.language ? ` · ${slice.language}` : ''}
        </span>
      </div>
      <pre className="graph-file-preview" aria-label="File slice">
        <code>
          {slice.lines.map((line, i) => {
            const lineNum = slice.startLine + i
            const inRange =
              highlightStart != null &&
              lineNum >= highlightStart &&
              (highlightEnd ?? highlightStart) >= lineNum
            return (
              <div
                key={lineNum}
                className={
                  'graph-file-line' +
                  (inRange ? ' graph-file-line-highlight' : '')
                }
              >
                <span className="graph-file-lineno" aria-hidden="true">
                  {lineNum}
                </span>
                <span className="graph-file-content">{line || ' '}</span>
              </div>
            )
          })}
        </code>
      </pre>
    </section>
  )
}
