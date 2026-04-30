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
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react'
import { Graph as DagreGraph, layout as dagreLayout } from '@dagrejs/dagre'
import {
  repoGraphModes,
  type RepoGraph,
  type RepoGraphEdge,
  type RepoGraphMode,
  type RepoGraphNode,
  type RepoGraphNodeKind,
  type RepoResponse,
} from '@agent-bridge/shared'
import { ApiError, getRepoGraph } from '../../lib/rpc'
import { GraphFlowNode, type GraphFlowNodeData } from './graph-flow-node'

import '@xyflow/react/dist/style.css'
import './graph-modal.css'

const NODE_WIDTH = 240
const NODE_HEIGHT = 56

const NODE_TYPES: NodeTypes = {
  abNode: GraphFlowNode,
}

const MODE_LABEL: Record<RepoGraphMode, string> = {
  symbols: 'Symbols',
  structure: 'Structure',
  imports: 'Imports',
}

const MODE_HINT: Record<RepoGraphMode, string> = {
  symbols: 'Top functions, methods, and classes connected by CALLS.',
  structure: 'Folder + file directory tree (CONTAINS edges).',
  imports: 'File-level IMPORTS dependency graph.',
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

export function GraphModal({ repo, onClose }: GraphModalProps) {
  const [mode, setMode] = useState<RepoGraphMode>('symbols')
  const [state, setState] = useState<FetchState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    // Toggling the mode tab needs the spinner back. The flip-to-loading
    // is the user's signal that we acknowledged their click; without it
    // a slow cypher round-trip looks like a stuck button. The lint rule
    // would prefer this cascade move into a render-time derivation, but
    // we genuinely want a one-shot reset that fires once per
    // (repo.id, mode) change — not per render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ kind: 'loading' })
    getRepoGraph(repo.id, mode)
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
  }, [repo.id, mode])

  // Esc-to-close, mounted unconditionally so the listener is bound for
  // every state of the modal (including the loading spinner).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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
          <div className="graph-modal-hint">{MODE_HINT[mode]}</div>
        </div>
        {state.kind === 'ready' ? <StatsBar graph={state.graph} /> : null}
        <div className="graph-modal-body">
          {state.kind === 'loading' ? <LoadingState mode={mode} /> : null}
          {state.kind === 'empty' ? <EmptyState message={state.message} /> : null}
          {state.kind === 'error' ? (
            <ErrorState message={state.message} />
          ) : null}
          {state.kind === 'ready' ? <GraphCanvas graph={state.graph} /> : null}
        </div>
      </div>
    </div>
  )
}

function GraphCanvas({ graph }: { graph: RepoGraph }) {
  const { nodes, edges, truncationLabel } = useMemo(
    () => layoutGraph(graph),
    [graph],
  )

  return (
    <div className="graph-flow-frame">
      {truncationLabel ? (
        <div className="graph-modal-truncation" role="status">
          <span className="graph-modal-truncation-icon" aria-hidden>
            ⊘
          </span>
          {truncationLabel}
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Background
          gap={28}
          size={1.2}
          color="rgba(167, 139, 250, 0.16)"
        />
        <Controls
          showInteractive={false}
          className="graph-modal-controls"
        />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(8, 7, 13, 0.55)"
          style={{
            background: 'rgba(15, 14, 23, 0.92)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
          nodeColor={(n) => miniMapColor(n.data as { kind?: string })}
          nodeStrokeWidth={2}
          nodeBorderRadius={6}
        />
        <Legend graph={graph} />
      </ReactFlow>
    </div>
  )
}

function layoutGraph(graph: RepoGraph): {
  nodes: Node[]
  edges: Edge[]
  truncationLabel: string | null
} {
  const g = new DagreGraph()
  // Symbols mode is denser and reads better top-to-bottom; the
  // hierarchical modes flow left-to-right because they're skinny tall
  // trees where horizontal sprawl is fine.
  const rankdir = graph.mode === 'symbols' ? 'TB' : 'LR'
  g.setGraph({
    rankdir,
    nodesep: 32,
    ranksep: 88,
    marginx: 32,
    marginy: 32,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagreLayout(g)

  const nodes: Node[] = graph.nodes.map((node) => {
    const positioned = g.node(node.id) as { x?: number; y?: number } | undefined
    const x = positioned?.x ?? 0
    const y = positioned?.y ?? 0
    const data: GraphFlowNodeData = {
      label: shortLabel(node),
      subtitle: subtitleFor(node),
      kind: node.kind,
      degree: node.degree ?? null,
      mode: graph.mode,
    }
    return {
      id: node.id,
      // Dagre returns center coords; React Flow expects top-left.
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
      data: data as unknown as Record<string, unknown>,
      type: 'abNode',
      draggable: false,
      selectable: false,
    }
  })

  const edges: Edge[] = graph.edges.map((edge, i) => ({
    id: `e-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: edge.kind === 'contains' ? 'smoothstep' : 'bezier',
    animated: edge.kind === 'calls',
    style: edgeStyleFor(edge),
    className: `graph-edge graph-edge-${edge.kind}`,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: edgeColor(edge.kind),
    },
  }))

  return {
    nodes,
    edges,
    truncationLabel: buildTruncationLabel(graph),
  }
}

function shortLabel(node: RepoGraphNode): string {
  // For files in `imports` mode, surface the bare basename; the
  // directory hint goes in the subtitle so the visual emphasis lands
  // on the readable bit.
  if (node.kind === 'file') {
    const slash = node.name.lastIndexOf('/')
    return slash >= 0 ? node.name.slice(slash + 1) : node.name
  }
  return node.name
}

function subtitleFor(node: RepoGraphNode): string | null {
  // Function/Method ids embed the file path (`Function:foo/bar.ts:name`);
  // surface that as a subtitle so the operator can disambiguate
  // identically-named symbols across files.
  if (node.kind === 'function' || node.kind === 'method') {
    return extractFileSegment(node.id)
  }
  if (node.kind === 'file') {
    // `name` is already the basename for files; the id carries the path.
    const path = extractAfterFirstColon(node.id)
    if (!path) return null
    const slash = path.lastIndexOf('/')
    if (slash <= 0) return null
    const dir = path.slice(0, slash)
    return dir.length > 36 ? `…${dir.slice(-34)}` : dir
  }
  return null
}

function extractAfterFirstColon(id: string): string | null {
  const colonIdx = id.indexOf(':')
  return colonIdx < 0 ? null : id.slice(colonIdx + 1)
}

function extractFileSegment(id: string): string | null {
  // Format: `Function:<filePath>:<symbolName>` — split off the
  // `:Function` prefix and the trailing `:<name>`. Best-effort;
  // malformed ids fall through to a null hint.
  const remainder = extractAfterFirstColon(id)
  if (!remainder) return null
  const lastColon = remainder.lastIndexOf(':')
  if (lastColon < 0) return null
  const filePath = remainder.slice(0, lastColon)
  if (filePath.length > 36) {
    return `…${filePath.slice(-34)}`
  }
  return filePath
}

function edgeColor(kind: RepoGraphEdge['kind']): string {
  switch (kind) {
    case 'calls':
      return '#a78bfa'
    case 'imports':
      return '#67e8f9'
    case 'contains':
    default:
      return 'rgba(167, 139, 250, 0.45)'
  }
}

function edgeStyleFor(edge: RepoGraphEdge): React.CSSProperties {
  const stroke = edgeColor(edge.kind)
  if (edge.kind === 'calls') {
    return { stroke, strokeWidth: 1.25, strokeDasharray: '6 4' }
  }
  if (edge.kind === 'imports') {
    return { stroke, strokeWidth: 1.25 }
  }
  return { stroke, strokeWidth: 1 }
}

function miniMapColor(data: { kind?: string }): string {
  switch (data.kind) {
    case 'function':
      return '#a78bfa'
    case 'method':
      return '#67e8f9'
    case 'class':
      return '#fbbf24'
    case 'folder':
      return '#a78bfa'
    case 'file':
    default:
      return '#52507a'
  }
}

function buildTruncationLabel(graph: RepoGraph): string | null {
  const totals = graph.totals
  const parts: string[] = []
  const labelFor: Partial<Record<RepoGraphNodeKind, [string, number | null | undefined]>> = {
    function: ['functions', totals.functions],
    method: ['methods', totals.methods],
    class: ['classes', totals.classes],
    folder: ['folders', totals.folders],
    file: ['files', totals.files],
  }
  for (const kind of Object.keys(labelFor) as RepoGraphNodeKind[]) {
    const entry = labelFor[kind]
    if (!entry) continue
    const [label, total] = entry
    if (total == null) continue
    const shown = graph.nodes.filter((n) => n.kind === kind).length
    if (shown === 0) continue
    if (total > shown) parts.push(`${shown} of ${total} ${label}`)
  }
  if (parts.length === 0) return null
  return `Showing ${parts.join(', ')}. Larger repos render a representative slice ranked by edge degree.`
}

function emptyMessageFor(mode: RepoGraphMode): string {
  switch (mode) {
    case 'symbols':
      return 'No CALLS edges in this index — try the Structure tab to see folders + files.'
    case 'imports':
      return 'No IMPORTS edges between files in this index. Pick another tab to see what was captured.'
    case 'structure':
    default:
      return "Index ran, but gitnexus didn't surface any folders or files for this repo. Try re-indexing with --force."
  }
}

// ─── stats / legend / chrome ─────────────────────────────────────────────

const STAT_KEYS_BY_MODE: Record<RepoGraphMode, RepoGraphNodeKind[]> = {
  symbols: ['function', 'method', 'class'],
  structure: ['folder', 'file'],
  imports: ['file'],
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
}

function Legend({ graph }: { graph: RepoGraph }) {
  // Position the legend over the canvas in the bottom-left. The Panel
  // primitive from React Flow would let us do this with first-class
  // support, but a vanilla absolutely-positioned div is plenty here.
  const items = STAT_KEYS_BY_MODE[graph.mode]
  return (
    <div className="graph-modal-legend">
      {items.map((kind) => (
        <span key={kind} className="graph-legend-item">
          <span className={`graph-legend-swatch graph-node-icon-${kind}`} />
          <span>{LABEL_PLURAL[kind]}</span>
        </span>
      ))}
      {graph.edges.length > 0 ? (
        <span className="graph-legend-item">
          <span
            className={`graph-legend-edge graph-legend-edge-${graph.edges[0]?.kind ?? 'contains'}`}
          />
          <span>{graph.edges[0]?.kind ?? 'edges'}</span>
        </span>
      ) : null}
    </div>
  )
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
