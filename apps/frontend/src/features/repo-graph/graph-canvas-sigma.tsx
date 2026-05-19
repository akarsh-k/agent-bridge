/**
 * Sigma.js-backed canvas for the repo graph. Renders the whole network
 * as a force-directed WebGL graph — the same approach gitnexus serve
 * uses — with per-kind colors, degree-scaled node sizes, and
 * directional arrow tips on the edges.
 *
 * External state:
 *   - `graph`             — RepoGraph payload from the backend.
 *   - `selectedNodeId`    — drives the highlighted-ring on the selected
 *                           node and pairs with the details panel. The
 *                           autocomplete in the toolbar feeds into the
 *                           same state — picking a row IS selecting a
 *                           node.
 *   - `kindFilter`        — Set<RepoGraphNodeKind> hiding non-matching
 *                           kinds via sigma's `hidden` attribute (no
 *                           re-layout). Empty set = show all.
 *   - `onNodeClick(id)`   — clicking a node delegates to the parent so
 *                           it can swap the details panel.
 *
 * Lifecycle:
 *   - The sigma instance is rebuilt whenever the `graph` payload
 *     identity changes (so a tab swap or kind-filter change forces a
 *     re-layout). Selection updates mutate node attributes in-place
 *     via `g.setNodeAttribute(...)` + `sigma.refresh()`, which avoids
 *     tearing down the WebGL context.
 *   - Layout runs synchronously via `forceAtlas2.assign(...)`. With
 *     NETWORK_CAPS at 3000 nodes / 8000 edges (lifted from 600/1500
 *     to keep hub nodes' neighbours in the payload) and barnes-hut
 *     enabled, the pass settles in ~1-3s on commodity laptops. The
 *     iteration budget decays with order (see runForceLayout). If we
 *     push past 5000 nodes, a workerised layout becomes the next step.
 */

import { useEffect, useRef } from 'react'
import Sigma from 'sigma'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { EdgeCurvedArrowProgram } from '@sigma/edge-curve'
import type {
  RepoGraph,
  RepoGraphEdge,
  RepoGraphNode,
  RepoGraphNodeKind,
} from '@agent-bridge/shared'

// ─── Color palette ────────────────────────────────────────────────────────
//
// Mirrors the CSS tokens in `./graph-tokens.css` (kept in sync by hand;
// Sigma renders into a WebGL canvas and can't read CSS custom props, so
// the source of truth is duplicated. Comment-locked: if you change one,
// change the other.).
//
// Node colors and edge colors are deliberately separated — they used to
// collide (function + folder + edge.calls were all #a78bfa) which made
// the graph an unreadable purple blob. Each node KIND now has its own
// perceptually-distinct hue, and edges share a single muted slate so
// they read as connective tissue. Source-node tint is reapplied on
// hover-of-incident-node by the edgeReducer, which is when the user
// actually wants to read an edge.

const NODE_COLOR: Record<RepoGraphNodeKind, string> = {
  function: '#3b82f6',  // blue   — core "behaviour" node
  method: '#14b8a6',    // teal   — function-bound-to-class
  class: '#f59e0b',     // amber  — types / containers
  file: '#94a3b8',      // slate  — neutral container
  folder: '#64748b',    // slate-darker — purely structural
  process: '#ef4444',   // red    — ordered execution flow
  community: '#ec4899', // pink   — semantic cluster
}

/**
 * Edge color — a single muted slate, applied to every edge in every
 * state. The user reads edges as "connections between nodes"; nodes
 * carry the per-kind hue, edges deliberately don't.
 *
 * This is the gitnexus pattern (confirmed against their bundle —
 * `edgeReducer:null`, no dynamic recolor at all). Emphasis on hover
 * and selection is communicated via stroke WIDTH and OPACITY, never
 * a color change. An earlier draft re-tinted edges with the source-
 * node color on hover; that recreated the exact "node and edge are
 * the same color" problem we set out to fix.
 *
 *   EDGE_REST     — default; what you see across the whole graph
 *   EDGE_ACCENT   — incident-to-hovered, or inside a selection focus
 *   (dim edge color is read from the theme — see readThemeColors)
 */
const EDGE_REST = '#3a3a4a'
const EDGE_ACCENT = '#7a7a92'

/**
 * Per-kind edge SIZES. Width still varies by kind so an operator can
 * tell CALLS from IMPORTS at a glance even without hovering — calls
 * and step (active-flow relations) read slightly bolder than the
 * structural contains/member/imports.
 */
const EDGE_SIZE: Record<RepoGraphEdge['kind'], number> = {
  calls: 1.0,
  step: 1.1,
  imports: 0.7,
  contains: 0.55,
  member: 0.55,
}

interface GraphCanvasSigmaProps {
  graph: RepoGraph
  selectedNodeId: string | null
  /** Optional set of node kinds to show. Empty / undefined means
   *  every kind is visible. Used by the kind-filter chip row to
   *  hide e.g. files-only or symbols-only views. */
  kindFilter?: ReadonlySet<RepoGraphNodeKind>
  onNodeClick: (nodeId: string) => void
}

export function GraphCanvasSigma({
  graph,
  selectedNodeId,
  kindFilter,
  onNodeClick,
}: GraphCanvasSigmaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const graphRef = useRef<Graph | null>(null)
  // Keep the most-recent click handler reachable from the sigma
  // listener without rebinding the (expensive) listener every parent
  // render. The same trick the SSE hooks elsewhere in the app use.
  const clickRef = useRef(onNodeClick)
  useEffect(() => {
    clickRef.current = onNodeClick
  }, [onNodeClick])
  // Neighbor set for the currently-selected node — derived from the
  // graphology graph so it reflects post-build state. Read by the
  // sigma reducer below to dim the non-neighbour world.
  const neighborsRef = useRef<Set<string> | null>(null)
  // Set of node IDs whose kind passes the active kind-chip filter.
  // Null when no chip is on (== full graph focused). Read by the
  // node reducer to dim non-matching nodes when a kind filter is
  // active but no selection is.
  const kindFocusRef = useRef<Set<string> | null>(null)
  // Currently-hovered node id, set by sigma's enterNode/leaveNode events.
  // Drives the "incident edges brighten" effect via the edge reducer.
  const hoveredRef = useRef<string | null>(null)
  // Theme-aware sigma colors. Sigma's `labelColor` is set at init
  // time; we read the live `--text` token from the document root
  // and update via `setSetting(...)` whenever the theme flips
  // (data-theme attr changes OR prefers-color-scheme switches under
  // a `theme: system` setting). Without this, labels stay light
  // grey on a light page and disappear.
  const themeColorsRef = useRef(readThemeColors())

  // Build + mount whenever the graph payload changes. The dep array is
  // intentionally just `graph` (not selectedNodeId / filter) — those
  // are applied via attribute mutation below.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const g = buildGraphology(graph)
    runForceLayout(g)
    const sig = new Sigma(g, container, {
      // Stroke-less labels keyed off the live `--text` token so they
      // read on both themes. Refreshed via setSetting in the
      // theme-watcher effect below.
      labelColor: { color: themeColorsRef.current.label },
      labelSize: 11,
      labelWeight: '500',
      labelFont:
        '"Outfit", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      // Only render labels for the higher-degree nodes so dense
      // clusters don't fight for screen real estate.
      labelRenderedSizeThreshold: 6,
      // Curved + arrowed edges so calls/imports/etc. read as directed
      // AND don't overlap when nodes sit close together — matches the
      // visual style of gitnexus's own viewer.
      defaultEdgeType: 'curved-arrow',
      edgeProgramClasses: {
        'curved-arrow': EdgeCurvedArrowProgram,
      },
      renderEdgeLabels: false,
      // Subtle hover ring instead of sigma's default heavy halo.
      enableEdgeEvents: false,
      // Sigma's stock hover renderer draws a hardcoded `#FFF` pill
      // behind the label. On dark theme that's white-on-white. We
      // ship a theme-aware version that reads the live `--surface`
      // token at draw time so it flips with the rest of the app.
      defaultDrawNodeHover: makeDrawNodeHover(() => themeColorsRef.current),
      // Per-frame reducers — three modes of visual emphasis:
      //   1) Click selection (neighborsRef set): selected + neighbours
      //      stay bright; everything else dims. Overrides filter mode.
      //   2) Active filter (matchesRef set): matched nodes pop with
      //      a halo + size bump; the 1-hop "context" nodes remain
      //      visible but smaller and unlabelled so the user can
      //      eyeball where in the graph the match landed.
      //   3) No emphasis: pass through.
      // Pattern lifted from gitnexus's own bundle so the UX matches.
      nodeReducer: (nodeId, attrs) => {
        if (attrs['hidden']) return attrs
        const focus = neighborsRef.current
        const kindFocus = kindFocusRef.current
        const baseSize = (attrs['baseSize'] as number | undefined) ?? 4

        // Selection focus wins over kind filter. If the user picked a
        // node, the focus subset is bright and everything else dims
        // — regardless of the kind filter's state. Reasoning: the
        // user explicitly asked for this node's neighbourhood; show
        // the connections.
        if (focus) {
          if (focus.has(nodeId)) return attrs
          return {
            ...attrs,
            color: themeColorsRef.current.dimmedNode,
            size: baseSize * 0.55,
            label: '',
            zIndex: 0,
          }
        }

        // Kind filter (no selection). Non-matching kinds dim out so
        // the matching ones pop. Whole graph stays on screen — the
        // dimmed nodes are still part of the visual structure.
        if (kindFocus) {
          if (kindFocus.has(nodeId)) return attrs
          return {
            ...attrs,
            color: themeColorsRef.current.dimmedNode,
            size: baseSize * 0.55,
            label: '',
            zIndex: 0,
          }
        }

        return attrs
      },
      edgeReducer: (edgeId, attrs) => {
        if (attrs['hidden']) return attrs
        const src = g.source(edgeId)
        const tgt = g.target(edgeId)
        const focus = neighborsRef.current
        const kindFocus = kindFocusRef.current
        const hovered = hoveredRef.current
        const baseSize = (attrs['size'] as number | undefined) ?? 1

        // Edges NEVER take on a node color. Emphasis is via width +
        // brightness only.
        //
        // Priority (highest first):
        //   1. Selection focus: incident-to-focus → bright slate;
        //      everything else dims hard.
        //   2. Hover (no selection): incident-to-hovered → bright
        //      slate; everything else dims hard.
        //   3. Kind filter (no selection, no hover): edges between
        //      two matching nodes stay normal; edges touching a
        //      non-matching node dim.
        //   4. Default: muted slate, base width.

        if (focus) {
          const inSubset = focus.has(src) && focus.has(tgt)
          if (inSubset) {
            return { ...attrs, color: EDGE_ACCENT, size: baseSize * 1.5, zIndex: 1 }
          }
          // Anything outside the focused subset dims to near-invisible.
          return { ...attrs, color: themeColorsRef.current.dimmedEdge, size: baseSize * 0.6 }
        }

        if (hovered) {
          if (src === hovered || tgt === hovered) {
            return { ...attrs, color: EDGE_ACCENT, size: baseSize * 1.8, zIndex: 2 }
          }
          return { ...attrs, color: themeColorsRef.current.dimmedEdge, size: baseSize * 0.6 }
        }

        if (kindFocus) {
          const bothIn = kindFocus.has(src) && kindFocus.has(tgt)
          if (bothIn) return attrs
          return { ...attrs, color: themeColorsRef.current.dimmedEdge, size: baseSize * 0.6 }
        }

        return attrs
      },
    })
    sig.on('clickNode', ({ node }) => clickRef.current(node))
    // Hover-of-node lights up the incident edges in source-color via
    // the edgeReducer. The reducer reads `hoveredRef`, so a single
    // ref-mutation + refresh is all we need; no React state involved.
    sig.on('enterNode', ({ node }) => {
      hoveredRef.current = node
      sig.refresh()
    })
    sig.on('leaveNode', () => {
      hoveredRef.current = null
      sig.refresh()
    })
    sigmaRef.current = sig
    graphRef.current = g
    return () => {
      sig.kill()
      sigmaRef.current = null
      graphRef.current = null
    }
  }, [graph])

  // No theme-watcher: the graph modal owns its own surface stack
  // (see ./graph-tokens.css). The canvas always renders against a
  // near-black background regardless of the app's light/dark setting
  // — same as gitnexus's own viewer.

  // Selection + kind-filter effect. Gitnexus's pattern: the whole
  // graph stays VISIBLE at all times; selection and filtering only
  // shift emphasis. Focused nodes are full brightness + base size,
  // everything else gets aggressive dimming via the per-frame
  // reducers (sub-base size, near-background color, no label).
  //
  // No `hidden` toggling — an earlier version hard-hid non-focus
  // nodes and the user (correctly) flagged that the rest of the
  // graph should remain on screen as context. Hiding loses the
  // shape; dimming keeps it.
  //
  // What this effect actually writes:
  //   - `neighborsRef` for selection focus (selected + 1-hop)
  //   - `kindFocusRef` for kind-filter focus
  //   - `highlighted` + `size` on the selected node (halo + bump)
  //
  // The reducers below read those refs every frame to apply the
  // dimming. No `hidden` attribute is set anywhere; we rely on
  // size + color to communicate emphasis.
  useEffect(() => {
    const g = graphRef.current
    const sig = sigmaRef.current
    if (!g || !sig) return

    // Selection focus = selected + 1-hop neighbours.
    let focus: Set<string> | null = null
    if (selectedNodeId && g.hasNode(selectedNodeId)) {
      focus = new Set<string>([selectedNodeId])
      g.forEachNeighbor(selectedNodeId, (n) => focus!.add(n))
    }
    neighborsRef.current = focus

    // Kind focus — set of node IDs whose kind matches the active
    // chip set. Null when no chip is on (== "all kinds focused").
    const kinds = kindFilter && kindFilter.size > 0 ? kindFilter : null
    if (kinds) {
      const ids = new Set<string>()
      g.forEachNode((id, attrs) => {
        if (kinds.has(attrs['kind'] as RepoGraphNodeKind)) ids.add(id)
      })
      kindFocusRef.current = ids
    } else {
      kindFocusRef.current = null
    }

    // Selected node gets the halo + size bump. Everything else snaps
    // back to its base size so the focus is unambiguous. The dimming
    // of non-focus nodes is handled by the nodeReducer below.
    g.forEachNode((id, attrs) => {
      // Clear any leftover `hidden` from earlier versions of this
      // code so a stale flag doesn't keep a node off-screen.
      if (g.getNodeAttribute(id, 'hidden')) {
        g.setNodeAttribute(id, 'hidden', false)
      }
      const isSelected = id === selectedNodeId
      const baseSize = (attrs['baseSize'] as number | undefined) ?? 4
      g.setNodeAttribute(id, 'highlighted', isSelected)
      g.setNodeAttribute(id, 'size', isSelected ? baseSize * 1.6 : baseSize)
    })
    g.forEachEdge((edgeId) => {
      if (g.getEdgeAttribute(edgeId, 'hidden')) {
        g.setEdgeAttribute(edgeId, 'hidden', false)
      }
    })
    sig.refresh()
  }, [selectedNodeId, kindFilter])

  return (
    <div
      ref={containerRef}
      className="graph-sigma-frame"
      data-graph-mode={graph.mode}
    />
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────

function buildGraphology(graph: RepoGraph): Graph {
  // Self-loops are legit — recursive functions show up as CALLS to
  // themselves. Sigma renders them as a small loop at the node.
  const g = new Graph({ type: 'directed', multi: false, allowSelfLoops: true })
  // Pre-seed every node at a random spot so forceAtlas2 has something
  // to push apart from — without initial coordinates the layout
  // returns NaN positions.
  for (const node of graph.nodes) {
    if (g.hasNode(node.id)) continue
    g.addNode(node.id, nodeAttributes(node))
  }
  for (const edge of graph.edges) {
    if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue
    // Multi-edges across kinds collapse to the first kind we see —
    // gitnexus doesn't double-up edges in practice and the renderer
    // shows one stroke either way.
    if (g.hasEdge(edge.source, edge.target)) continue
    g.addEdgeWithKey(
      `${edge.source}→${edge.target}`,
      edge.source,
      edge.target,
      edgeAttributes(edge),
    )
  }
  return g
}

function nodeAttributes(node: RepoGraphNode): Record<string, unknown> {
  // Node size scales with degree on a square-root curve so the
  // hubs are obviously larger without dwarfing the long tail.
  const deg = node.degree ?? 0
  const baseSize = 3 + Math.sqrt(deg) * 1.4
  return {
    label: shortLabel(node),
    color: NODE_COLOR[node.kind],
    size: baseSize,
    baseSize,
    // Initial positions on a 1×1 grid — forceAtlas2 expands and
    // distributes from here. Without these every node would sit at
    // (0,0) and the layout would diverge.
    x: Math.random(),
    y: Math.random(),
    // Keep the original payload around so the filter reducer can
    // match against file paths and the click handler can recover
    // the kind for downstream consumers.
    kind: node.kind,
    nodeId: node.id,
    filePath: node.filePath ?? '',
  }
}

function edgeAttributes(edge: RepoGraphEdge): Record<string, unknown> {
  // Edges always render in a single muted slate so the graph reads
  // as structure + connective tissue, never competing with node hues
  // for the user's attention. Emphasis on hover / selection comes
  // from width + brightness shifts (see edgeReducer above), not from
  // recoloring with the source-node hue.
  return {
    color: EDGE_REST,
    size: EDGE_SIZE[edge.kind] ?? 0.6,
    kind: edge.kind,
    // No labels by default — the canvas already shows direction via
    // arrow tips. Step edges from the processes mode would benefit
    // from labels, follow-up.
  }
}

function runForceLayout(g: Graph): void {
  // forceAtlas2.assign mutates the node x/y attributes. `barnesHutOptimize`
  // is the approximation that makes layout linear-ish in node count, so
  // we lean on it for anything above ~200 nodes.
  //
  // Iteration budget: decays linearly with graph order but floors at
  // 150 — fewer than that leaves big graphs stuck in their random init
  // and produces a hairball. The previous formula floored at 80 which
  // was too few once we lifted NETWORK_CAPS from 600 to 3000.
  //
  //    order ≤ 200    → 400 iterations (snappy + tight on small graphs)
  //    order = 1000   → 350
  //    order = 2000   → 300
  //    order = 3000   → 250
  //    order ≥ 5000   → 150 (the floor — accept a looser layout)
  //
  // Wall-clock on M-series with barnes-hut: ~0.2s @ 600 / ~1s @ 1500 /
  // ~3s @ 3000. Synchronous because the network round-trip dwarfs the
  // layout cost in practice; a worker is the right next step if we
  // ever push past 5000.
  const iterations = Math.min(400, Math.max(150, Math.round(400 - g.order / 20)))
  forceAtlas2.assign(g, {
    iterations,
    settings: {
      gravity: 1.2,
      scalingRatio: 12,
      slowDown: 1,
      strongGravityMode: true,
      barnesHutOptimize: g.order > 200,
      barnesHutTheta: 0.5,
    },
  })
}

function shortLabel(node: RepoGraphNode): string {
  // Files: surface the basename only. Symbols: keep the bare name
  // (the file path lives in the details panel so we don't double up).
  if (node.kind === 'file') {
    const slash = node.name.lastIndexOf('/')
    return slash >= 0 ? node.name.slice(slash + 1) : node.name
  }
  return node.name
}

interface ThemeColors {
  /** Label text color. Pulled from `--text` so it reads on either
   *  theme. Falls back to a dark-mode safe default when the tokens
   *  haven't been computed yet (SSR / pre-mount). */
  label: string
  /** Color a node gets when it's been dimmed because another node
   *  is selected. */
  dimmedNode: string
  /** Dimmed edge color — same idea, even subtler. */
  dimmedEdge: string
  /** Background pill for the hover label (replaces sigma's
   *  hardcoded #FFF). Must contrast with `label`. */
  hoverBg: string
  /** Soft border line drawn around the hover pill for separation
   *  from the canvas. */
  hoverBorder: string
}

/**
 * Theme-aware replacement for sigma's `drawDiscNodeHover`. The
 * stock implementation paints the label-background pill with a
 * hardcoded `#FFF`, which renders white-on-white when the rest of
 * the app is in dark theme. We swap the pill color for the live
 * `--surface` token and use the same `--text` token for the label,
 * matching the rest of the chrome.
 *
 * The renderer is a closure over a getter so it picks up theme
 * flips without having to be re-bound on every theme change — the
 * sigma instance keeps the same function reference for its
 * lifetime.
 */
function makeDrawNodeHover(
  getColors: () => ThemeColors,
): (
  context: CanvasRenderingContext2D,
  data: { x: number; y: number; size: number; label?: string | null },
  settings: { labelSize: number; labelFont: string; labelWeight: string },
) => void {
  return (context, data, settings) => {
    const colors = getColors()
    const size = settings.labelSize
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`
    if (typeof data.label !== 'string' || data.label.length === 0) {
      // No label → just a soft halo behind the node disc so the
      // hover state is still visible.
      context.beginPath()
      context.fillStyle = colors.hoverBg
      context.arc(data.x, data.y, data.size + 4, 0, Math.PI * 2)
      context.closePath()
      context.fill()
      return
    }
    const PADDING = 4
    const textWidth = context.measureText(data.label).width
    const boxWidth = Math.round(textWidth + 10)
    const boxHeight = Math.round(size + 2 * PADDING + 2)
    const radius = Math.max(data.size, size / 2) + PADDING
    // Rounded pill that hugs the node disc on the left and extends
    // to the right to host the label text. Geometry copied from
    // sigma's stock renderer; only the fills change.
    const angleRadian = Math.asin(boxHeight / 2 / radius)
    const xDeltaCoord = Math.sqrt(
      Math.abs(radius * radius - (boxHeight / 2) * (boxHeight / 2)),
    )
    context.beginPath()
    context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2)
    context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2)
    context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2)
    context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2)
    context.arc(data.x, data.y, radius, angleRadian, -angleRadian)
    context.closePath()
    context.fillStyle = colors.hoverBg
    context.fill()
    context.strokeStyle = colors.hoverBorder
    context.lineWidth = 1
    context.stroke()
    // Label text on top of the pill.
    context.fillStyle = colors.label
    context.textBaseline = 'middle'
    context.fillText(data.label, data.x + radius + 4, data.y + size / 6)
  }
}

function readThemeColors(): ThemeColors {
  // The graph viewer owns its own near-black surface stack (see
  // ./graph-tokens.css). Labels and dim states are fixed — independent
  // of the app's data-theme attr. Going theme-reactive made dimmed
  // nodes vanish against the dark canvas when the app was in light
  // mode; this approach keeps the viewer legible in every theme.
  return {
    label: '#e4e4ed',
    // Calibrated for the gx-void / gx-deep backdrop (#06060a / #0a0a10).
    // These sit just above the surface luminance so the structure
    // is faintly visible without competing with the focus subset.
    dimmedNode: '#2b2b3a',
    dimmedEdge: '#1c1c26',
    // Hover label pill uses the toolbar surface so it reads as
    // "raised panel" against the canvas.
    hoverBg: '#16161f',
    hoverBorder: '#2a2a3a',
  }
}

