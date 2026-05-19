/**
 * GraphModal — full-screen overlay that fetches a slice of the repo's
 * gitnexus knowledge graph and renders it with React Flow + dagre.
 *
 * Three modes (operator picks via the tab strip):
 *   - `symbols`   (default) — top-degree Functions / Classes / Methods
 *                             linked by CALLS. The actual semantic graph.
 *   - `structure`           — Folder + File directory tree (CONTAINS).
 *   - `imports`             — File-level IMPORTS dependency graph.
 *
 * Layout is computed once per fetched payload with dagre (left-to-right
 * rankdir for hierarchical modes, top-to-bottom for symbols where the
 * graph is denser and TB makes the call chains read like flow charts).
 *
 * Custom node rendering lives in `./graph-flow-node`; the layout helper
 * here is responsible only for coordinate math + React Flow wiring.
 *
 * Failure modes:
 *   - 404 → "repo not found" (rare; only if the repo was deleted between
 *     opening the inspector and clicking the button).
 *   - 409 → "not indexed yet" empty state. The wiki/index status is
 *     orthogonal so we don't second-guess the gating: backend says "no
 *     graph", we say "run an index first".
 *   - 503 / network → generic error with the upstream gitnexus message.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  repoGraphModes,
  type RepoGraph,
  type RepoGraphMode,
  type RepoGraphNode,
  type RepoGraphNodeKind,
  type RepoResponse,
} from '@agent-bridge/shared'
import { ApiError, getRepoGraph } from '../../lib/rpc'
import { GraphCanvasSigma } from './graph-canvas-sigma'
import { GraphNodeSearch } from './graph-node-search'
import { NodeDetailsPanel } from './node-details-panel'
import { GraphSelectionPicker } from './graph-selection-picker'

import './graph-modal.css'

const MODE_LABEL: Record<RepoGraphMode, string> = {
  network: 'Network',
  processes: 'Processes',
  communities: 'Communities',
}

const MODE_HINT: Record<RepoGraphMode, string> = {
  network:
    'The whole knowledge graph — every kind of node + every edge type, force-directed. Use the kind chips to narrow.',
  processes:
    'Execution flows gitnexus inferred. Pick one to see its ordered call chain.',
  communities:
    'Heuristic semantic clusters. Pick one to see its members + internal calls.',
}

export interface GraphModalProps {
  repo: RepoResponse
  onClose: () => void
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ready'; graph: RepoGraph }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

const PICKER_MODES = new Set<RepoGraphMode>(['processes', 'communities'])

export function GraphModal({ repo, onClose }: GraphModalProps) {
  const [mode, setMode] = useState<RepoGraphMode>('network')
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  // Selected node drives the right-side details panel. We track the
  // id (not the node object) so the selection survives a payload
  // refresh — if a mode change keeps the node around, the panel
  // stays open against the same id.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Per-mode "picker selection" — the Process / Community id whose
  // subgraph we're showing. Lives on the modal because the picker
  // can be unmounted (when the user switches tabs) but we want to
  // preserve their choice on return.
  const [processId, setProcessId] = useState<string | null>(null)
  const [communityId, setCommunityId] = useState<string | null>(null)
  // Kind-filter chips (Functions / Methods / Classes / Files /
  // Folders). Empty set means "show every kind". Composed with the
  // search box inside the sigma canvas.
  const [kindFilter, setKindFilter] = useState<ReadonlySet<RepoGraphNodeKind>>(
    new Set(),
  )
  const pickerKind: 'processes' | 'communities' | null = PICKER_MODES.has(mode)
    ? (mode as 'processes' | 'communities')
    : null
  const pickerSelection =
    mode === 'processes'
      ? processId
      : mode === 'communities'
        ? communityId
        : null
  const setPickerSelection = (id: string) => {
    if (mode === 'processes') setProcessId(id)
    else if (mode === 'communities') setCommunityId(id)
  }

  useEffect(() => {
    let cancelled = false
    // Picker modes don't fetch a graph until the user picks an item.
    // We surface a distinct "pick something" empty state below.
    if (pickerKind && !pickerSelection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({
        kind: 'empty',
        message:
          pickerKind === 'processes'
            ? 'Pick a flow on the left to see its ordered call chain.'
            : 'Pick a community on the left to see its members + internal calls.',
      })
      return undefined
    }
    setState({ kind: 'loading' })
    getRepoGraph(repo.id, mode, pickerSelection ?? undefined)
      .then((graph) => {
        if (cancelled) return
        if (graph.nodes.length === 0) {
          setState({
            kind: 'empty',
            message: emptyMessageFor(mode),
          })
          return
        }
        setState({ kind: 'ready', graph })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.code === 'conflict') {
          setState({
            kind: 'empty',
            message:
              'No graph yet — run "Re-index repo" (or wait for the initial ' +
              'index to finish) and reopen this view.',
          })
          return
        }
        const message =
          err instanceof Error ? err.message : 'Failed to load graph'
        setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [repo.id, mode, pickerKind, pickerSelection])

  // Esc-to-close, mounted unconditionally so the listener is bound for
  // every state of the modal (including the loading spinner). When
  // the details panel is open, Esc closes JUST the panel first; a
  // second Esc closes the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selectedNodeId) {
        setSelectedNodeId(null)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, selectedNodeId])

  const selectedNode = useMemo<RepoGraphNode | null>(() => {
    if (!selectedNodeId) return null
    if (state.kind !== 'ready') return null
    return state.graph.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [selectedNodeId, state])

  // In-view edge count for the selected node. The node's `.degree`
  // field is its FULL degree in the gitnexus index; this graph
  // payload is capped at ~600 nodes server-side and edges whose
  // endpoints didn't survive the cap are dropped. So a standalone-
  // looking node with degree=5 isn't a bug — its 5 neighbours just
  // got trimmed. Surfacing both numbers in the side panel makes
  // that legible.
  const selectedInViewEdges = useMemo<number | null>(() => {
    if (!selectedNodeId) return null
    if (state.kind !== 'ready') return null
    let count = 0
    for (const e of state.graph.edges) {
      if (e.source === selectedNodeId || e.target === selectedNodeId) count++
    }
    return count
  }, [selectedNodeId, state])

  return (
    <div
      className="graph-modal-backdrop"
      role="dialog"
      aria-label={`Graph for ${repo.remoteUrl}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="graph-modal-card">
        <header className="graph-modal-header">
          <div className="graph-modal-heading">
            <span className="graph-modal-eyebrow">Knowledge graph</span>
            <span className="graph-modal-subtitle mono">
              {repo.remoteUrl} · {repo.branch}
            </span>
          </div>
          <button
            type="button"
            className="graph-modal-close"
            onClick={onClose}
            aria-label="Close graph"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="graph-modal-toolbar">
          <div className="graph-modal-tabs" role="tablist">
            {repoGraphModes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={m === mode}
                className={`graph-modal-tab ${m === mode ? 'is-active' : ''}`}
                onClick={() => {
                  if (m !== mode) setMode(m)
                }}
              >
                <span className={`graph-modal-tab-dot dot-${m}`} aria-hidden />
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <GraphNodeSearch
            graph={state.kind === 'ready' ? state.graph : null}
            onSelect={(id) => setSelectedNodeId(id)}
          />
          {mode === 'network' && (
            <KindFilterChips
              value={kindFilter}
              onChange={setKindFilter}
              graph={state.kind === 'ready' ? state.graph : null}
            />
          )}
          <div className="graph-modal-hint">{MODE_HINT[mode]}</div>
        </div>
        {state.kind === 'ready' ? <StatsBar graph={state.graph} /> : null}
        <div
          className={
            'graph-modal-body' +
            (selectedNode ? ' is-details-open' : '') +
            (pickerKind ? ' is-picker-open' : '')
          }
        >
          {pickerKind ? (
            <GraphSelectionPicker
              repoId={repo.id}
              kind={pickerKind}
              selectedId={pickerSelection}
              onSelect={setPickerSelection}
            />
          ) : null}
          {state.kind === 'loading' ? <LoadingState mode={mode} /> : null}
          {state.kind === 'empty' ? <EmptyState message={state.message} /> : null}
          {state.kind === 'error' ? (
            <ErrorState message={state.message} />
          ) : null}
          {state.kind === 'ready' ? (
            <>
              <GraphCanvasSigma
                graph={state.graph}
                selectedNodeId={selectedNodeId}
                kindFilter={kindFilter}
                onNodeClick={(id) => setSelectedNodeId(id)}
              />
              {/* Floating legend — only useful in modes where the
                  top-toolbar kind chips aren't visible (processes /
                  communities). In `network` the chips already show
                  one dot per kind, so a second legend would be noise. */}
              {mode !== 'network' && (
                <GraphLegend graph={state.graph} />
              )}
            </>
          ) : null}
          <NodeDetailsPanel
            repoId={repo.id}
            selected={selectedNode}
            inViewEdgeCount={selectedInViewEdges}
            onClose={() => setSelectedNodeId(null)}
            onSelect={(id) => setSelectedNodeId(id)}
          />
        </div>
      </div>
    </div>
  )
}


function emptyMessageFor(mode: RepoGraphMode): string {
  switch (mode) {
    case 'processes':
      return 'This process has no resolved member symbols. Try picking another one.'
    case 'communities':
      return 'This community has no resolved member symbols. Try picking another one.'
    case 'network':
    default:
      return "No nodes in this index yet — the repo was indexed but gitnexus didn't surface anything to plot. Try re-indexing."
  }
}

// ─── stats / legend / chrome ─────────────────────────────────────────────

const STAT_KEYS_BY_MODE: Record<RepoGraphMode, RepoGraphNodeKind[]> = {
  network: ['function', 'method', 'class', 'file'],
  processes: ['function', 'method', 'class'],
  communities: ['function', 'method', 'class'],
}

function StatsBar({ graph }: { graph: RepoGraph }) {
  const stats = STAT_KEYS_BY_MODE[graph.mode]
    .map((kind) => ({
      kind,
      shown: graph.nodes.filter((n) => n.kind === kind).length,
      total: totalForKind(graph, kind),
    }))
    .filter((s) => s.shown > 0 || (s.total ?? 0) > 0)

  if (stats.length === 0) return null

  return (
    <div className="graph-modal-stats" aria-label="Graph statistics">
      {stats.map((s) => (
        <span key={s.kind} className={`graph-stat graph-stat-${s.kind}`}>
          <span className={`graph-stat-icon graph-node-icon-${s.kind}`}>
            <DotIcon />
          </span>
          <span className="graph-stat-label">{LABEL_PLURAL[s.kind]}</span>
          <span className="graph-stat-value">
            {s.total != null && s.total > s.shown
              ? `${s.shown}/${s.total}`
              : s.shown}
          </span>
        </span>
      ))}
      <span className="graph-stat graph-stat-edges">
        <span className="graph-stat-label">edges</span>
        <span className="graph-stat-value">{graph.edges.length}</span>
      </span>
    </div>
  )
}

function totalForKind(
  graph: RepoGraph,
  kind: RepoGraphNodeKind,
): number | null {
  switch (kind) {
    case 'function':
      return graph.totals.functions ?? null
    case 'method':
      return graph.totals.methods ?? null
    case 'class':
      return graph.totals.classes ?? null
    case 'folder':
      return graph.totals.folders ?? null
    case 'file':
      return graph.totals.files ?? null
    default:
      return null
  }
}

const LABEL_PLURAL: Record<RepoGraphNodeKind, string> = {
  function: 'functions',
  method: 'methods',
  class: 'classes',
  folder: 'folders',
  file: 'files',
  process: 'processes',
  community: 'communities',
}

function LoadingState({ mode }: { mode: RepoGraphMode }) {
  return (
    <div className="graph-modal-state">
      <div className="graph-loader">
        <span />
        <span />
        <span />
      </div>
      <div className="graph-modal-state-message">
        Querying gitnexus for {MODE_LABEL[mode].toLowerCase()}…
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="graph-modal-state">
      <div className="graph-modal-state-glyph">∅</div>
      <div className="graph-modal-state-title">Nothing to render yet</div>
      <div className="graph-modal-state-message">{message}</div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="graph-modal-state">
      <div className="graph-modal-state-glyph err">!</div>
      <div className="graph-modal-state-title err">Couldn't load the graph</div>
      <div className="graph-modal-state-message">{message}</div>
    </div>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function DotIcon() {
  return (
    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="3" fill="currentColor" />
    </svg>
  )
}

const KIND_CHIPS: ReadonlyArray<{
  kind: RepoGraphNodeKind
  label: string
}> = [
  { kind: 'function', label: 'Functions' },
  { kind: 'method', label: 'Methods' },
  { kind: 'class', label: 'Classes' },
  { kind: 'file', label: 'Files' },
  { kind: 'folder', label: 'Folders' },
]

/**
 * Floating legend rendered bottom-left of the canvas. Shown only in
 * modes where the toolbar's kind-filter chips aren't visible (the
 * chips themselves double as a legend in `network` mode). Lists the
 * node kinds actually present in the current graph payload — so a
 * process flow that's only Functions doesn't show a "Classes" entry.
 */
function GraphLegend({ graph }: { graph: RepoGraph }) {
  const presentKinds = useMemo(() => {
    const seen = new Set<RepoGraphNodeKind>()
    for (const n of graph.nodes) seen.add(n.kind)
    // Stable order: most common kinds first, focal-node kinds last.
    const order: RepoGraphNodeKind[] = [
      'function',
      'method',
      'class',
      'file',
      'folder',
      'process',
      'community',
    ]
    return order.filter((k) => seen.has(k))
  }, [graph])

  if (presentKinds.length === 0) return null

  return (
    <div className="graph-modal-legend" role="note" aria-label="Color key">
      {presentKinds.map((k) => (
        <span key={k} className="graph-legend-item">
          <span
            className={`graph-legend-swatch graph-node-icon-${k}`}
            aria-hidden
          />
          {LABEL_PLURAL[k]}
        </span>
      ))}
      <span className="graph-legend-item" title="Edges fade by default; hover a node to light up its connections">
        <span className="graph-legend-edge" aria-hidden />
        edges
      </span>
    </div>
  )
}

/**
 * Multi-toggle chip row for the node-kind filter. Each chip has a
 * colored dot (kind hue), a label, and a live count. Clicking toggles
 * that kind in `value` (a Set<RepoGraphNodeKind>). The "All" chip on
 * the left is a master reset.
 *
 * Doubles as a legend in `network` mode (chips ARE the kind key), so
 * the floating legend hides itself when this is on screen.
 */
function KindFilterChips({
  value,
  onChange,
  graph,
}: {
  value: ReadonlySet<RepoGraphNodeKind>
  onChange: (next: ReadonlySet<RepoGraphNodeKind>) => void
  /** Current graph payload — drives live counts ("Functions · 124"). */
  graph: RepoGraph | null
}) {
  const counts = useMemo(() => {
    const map: Partial<Record<RepoGraphNodeKind, number>> = {}
    if (!graph) return map
    for (const n of graph.nodes) {
      map[n.kind] = (map[n.kind] ?? 0) + 1
    }
    return map
  }, [graph])

  const toggle = (kind: RepoGraphNodeKind) => {
    const next = new Set(value)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    onChange(next)
  }
  const anyActive = value.size > 0
  return (
    <div className="graph-kind-chips" role="group" aria-label="Filter by node kind">
      <button
        type="button"
        className={`graph-kind-chip ${!anyActive ? 'is-active' : ''}`}
        onClick={() => onChange(new Set())}
        title="Show every node kind"
      >
        All
      </button>
      {KIND_CHIPS.map((c) => {
        const active = value.has(c.kind)
        const count = counts[c.kind]
        const empty = count === 0 || count == null
        return (
          <button
            key={c.kind}
            type="button"
            className={`graph-kind-chip kind-${c.kind} ${active ? 'is-active' : ''}`}
            onClick={() => toggle(c.kind)}
            style={empty ? { opacity: 0.55 } : undefined}
          >
            <span
              className={`graph-kind-chip-dot graph-node-icon-${c.kind}`}
              aria-hidden
            />
            <span>{c.label}</span>
            {count != null && (
              <span className="graph-kind-chip-count" aria-label={`${count} ${c.label.toLowerCase()}`}>
                {formatCount(count)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return Math.round(n / 1000) + 'k'
}
