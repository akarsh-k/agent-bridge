/**
 * Sigma.js-backed canvas for the repo graph. Renders the whole network
 * as a force-directed WebGL graph — the same approach gitnexus serve
 * uses — with per-kind colors, degree-scaled node sizes, and
 * directional arrow tips on the edges.
 *
 * External state:
 *   - `graph`             — RepoGraph payload from the backend.
 *   - `selectedNodeId`    — drives the highlighted-ring on the selected
 *                           node and pairs with the details panel.
 *   - `filter`            — substring match on `node.name` (lowercased).
 *                           Non-matching nodes + their incident edges
 *                           are hidden via sigma's `hidden` attribute
 *                           (no re-layout — instant fade).
 *   - `onNodeClick(id)`   — clicking a node delegates to the parent so
 *                           it can swap the details panel.
 *
 * Lifecycle:
 *   - The sigma instance is rebuilt whenever the `graph` payload
 *     identity changes (so a tab swap or selection change forces a
 *     re-layout). Filter + selection updates mutate node attributes
 *     in-place via `g.setNodeAttribute(...)` + `sigma.refresh()`,
 *     which avoids tearing down the WebGL context.
 *   - Layout runs synchronously via `forceAtlas2.assign(...)`. For our
 *     caps (≤600 nodes, ≤1500 edges) it settles in <1s on commodity
 *     laptops. Lazy iterations + workerised layout are noted as a
 *     follow-up if we ever lift the caps.
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

// Per-kind node colors — same palette as the existing legend / pill
// dots so the canvas reads consistently with the rest of the UI.
const KIND_COLOR: Record<RepoGraphNodeKind, string> = {
  function: '#a78bfa',
  method: '#67e8f9',
  class: '#fbbf24',
  file: '#94a3b8',
  folder: '#a78bfa',
  process: '#fbbf24',
  community: '#f472b6',
}

// Per-edge-kind colors. Aim is for the operator to glance and tell
// CALLS (violet) from IMPORTS (teal) from CONTAINS (muted grey-violet)
// without checking the legend. All values are explicit and chosen to
// work on both light + dark themes — earlier we tried rgba alphas
// against the canvas background and they vanished on dark mode.
const EDGE_COLOR: Record<RepoGraphEdge['kind'], string> = {
  calls: '#a78bfa',
  imports: '#67e8f9',
  contains: '#6e6789',
  step: '#fbbf24',
  member: '#8a82a8',
}

interface GraphCanvasSigmaProps {
  graph: RepoGraph
  selectedNodeId: string | null
  filter: string
  /** Optional set of node kinds to show. Empty / undefined means
   *  every kind is visible. Used by the kind-filter chip row to
   *  hide e.g. files-only or symbols-only views. */
  kindFilter?: ReadonlySet<RepoGraphNodeKind>
  onNodeClick: (nodeId: string) => void
}

export function GraphCanvasSigma({
  graph,
  selectedNodeId,
  filter,
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
  // Match set for the active filter (search term + kind chips).
  // Distinguishes "this is what you searched for" (rendered at full
  // emphasis) from "neighbouring context" (rendered dimmer + smaller).
  // Null when no filter is active.
  const matchesRef = useRef<Set<string> | null>(null)
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
        'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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
        const baseSize = (attrs['baseSize'] as number | undefined) ?? 4
        const focus = neighborsRef.current
        const matches = matchesRef.current
        if (focus) {
          if (focus.has(nodeId)) return attrs
          return {
            ...attrs,
            color: themeColorsRef.current.dimmedNode,
            label: '',
          }
        }
        if (matches) {
          if (matches.has(nodeId)) {
            // Matched: keep kind color, bump size, halo so it pops
            // against the neighbour-context circles around it.
            return {
              ...attrs,
              size: baseSize * 1.6,
              highlighted: true,
              zIndex: 2,
            }
          }
          // Visible-but-not-matched ⇒ this is one of the 1-hop
          // neighbours we expanded. Shrink + drop the label so the
          // user's eye lands on the matches.
          return {
            ...attrs,
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
        const matches = matchesRef.current
        if (focus) {
          if (focus.has(src) && focus.has(tgt)) return attrs
          return { ...attrs, color: themeColorsRef.current.dimmedEdge }
        }
        if (matches) {
          const both = matches.has(src) && matches.has(tgt)
          const one = matches.has(src) || matches.has(tgt)
          if (both) {
            // Match-to-match: thicken so the chain through the
            // matched set reads as connected.
            const baseSize = (attrs['size'] as number | undefined) ?? 1
            return { ...attrs, size: baseSize * 1.5, zIndex: 1 }
          }
          if (one) return attrs
          // Both endpoints are neighbours (rare — happens when two
          // matches share a neighbour). Dim to keep focus on
          // match-to-match strokes.
          return { ...attrs, color: themeColorsRef.current.dimmedEdge }
        }
        return attrs
      },
    })
    sig.on('clickNode', ({ node }) => clickRef.current(node))
    sigmaRef.current = sig
    graphRef.current = g
    return () => {
      sig.kill()
      sigmaRef.current = null
      graphRef.current = null
    }
  }, [graph])

  // Filter — toggle `hidden` on nodes/edges. Sigma's WebGL renderer
  // honours the flag without re-layout. Matches against both the
  // node label (symbol name) and its file path. The matched set then
  // expands by 1 hop so the surrounding context (callers + callees,
  // imports, etc.) stays on-screen — without the expansion a match
  // shows up as a lonely circle disconnected from everything.
  useEffect(() => {
    const g = graphRef.current
    const sig = sigmaRef.current
    if (!g || !sig) return
    const term = filter.trim().toLowerCase()
    const filtering = term.length > 0
    const kinds = kindFilter && kindFilter.size > 0 ? kindFilter : null

    // Pass 1: which nodes "match" by name/path?
    const textMatched = new Set<string>()
    g.forEachNode((id, attrs) => {
      const name = String(attrs['label'] ?? '').toLowerCase()
      const filePath = String(attrs['filePath'] ?? '').toLowerCase()
      const matchesTerm =
        !filtering || name.includes(term) || filePath.includes(term)
      if (matchesTerm) textMatched.add(id)
    })

    // Pass 2: expand by 1 hop so context survives. Used both for
    // hiding (the non-visible set) AND for the nodeReducer (which
    // distinguishes a match from a neighbour-of-match).
    const visible = new Set(textMatched)
    if (filtering) {
      for (const id of textMatched) {
        g.forEachNeighbor(id, (n) => visible.add(n))
      }
    }

    // Tell the per-frame reducers what to emphasize. Only populated
    // when a text filter is active — kind chips alone fall through
    // to the no-emphasis path (kind chips hide via attrs.hidden
    // instead).
    matchesRef.current = filtering ? textMatched : null

    // Hidden flag is now driven by:
    //   1) kind chip filter (always hides non-matching kinds)
    //   2) text filter, when active, hides everything outside the
    //      matched-or-neighbour set
    g.forEachNode((id, attrs) => {
      const kindMatch =
        !kinds || kinds.has(attrs['kind'] as RepoGraphNodeKind)
      const textVisible = !filtering || visible.has(id)
      g.setNodeAttribute(id, 'hidden', !(kindMatch && textVisible))
    })
    g.forEachEdge((edgeId, _attrs, src, tgt) => {
      const visibleSrc = !g.getNodeAttribute(src, 'hidden')
      const visibleTgt = !g.getNodeAttribute(tgt, 'hidden')
      if (!visibleSrc || !visibleTgt) {
        g.setEdgeAttribute(edgeId, 'hidden', true)
        return
      }
      // When the text filter is active, only show edges that touch
      // at least one match so the neighbour-of-different-matches
      // clutter doesn't bloom.
      if (filtering) {
        const touchesMatch = textMatched.has(src) || textMatched.has(tgt)
        g.setEdgeAttribute(edgeId, 'hidden', !touchesMatch)
        return
      }
      g.setEdgeAttribute(edgeId, 'hidden', false)
    })
    sig.refresh()
  }, [filter, kindFilter])

  // Theme-watcher — re-read CSS tokens whenever the data-theme attr
  // on <html> flips or the OS-level prefers-color-scheme changes
  // under a `theme: system` setting. Cheap (one querySelector + a
  // few getPropertyValue calls), so we don't bother memoising.
  useEffect(() => {
    const apply = () => {
      const colors = readThemeColors()
      themeColorsRef.current = colors
      const sig = sigmaRef.current
      if (!sig) return
      sig.setSetting('labelColor', { color: colors.label })
      sig.refresh()
    }
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', apply)
    }
  }, [])

  // Selection — bumps the selected node's size + halo, and computes
  // the neighbour set the reducers use to dim the rest of the graph.
  useEffect(() => {
    const g = graphRef.current
    const sig = sigmaRef.current
    if (!g || !sig) return
    if (selectedNodeId && g.hasNode(selectedNodeId)) {
      const focus = new Set<string>([selectedNodeId])
      // Pull every direct neighbour (incoming + outgoing). Single-hop
      // is the gitnexus convention; the details panel already lists
      // the same neighbours so this stays consistent.
      g.forEachNeighbor(selectedNodeId, (n) => focus.add(n))
      neighborsRef.current = focus
    } else {
      neighborsRef.current = null
    }
    g.forEachNode((id, attrs) => {
      const isSelected = id === selectedNodeId
      const baseSize = (attrs['baseSize'] as number | undefined) ?? 4
      g.setNodeAttribute(id, 'highlighted', isSelected)
      g.setNodeAttribute(id, 'size', isSelected ? baseSize * 1.6 : baseSize)
    })
    sig.refresh()
  }, [selectedNodeId])

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
    color: KIND_COLOR[node.kind],
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
  // Calls + step are the "active flow" relations and read better
  // slightly bolder. Contains / member / imports are structural and
  // stay at the base weight — bumping them too creates visual noise.
  const size =
    edge.kind === 'calls' || edge.kind === 'step'
      ? 2.5
      : edge.kind === 'imports'
        ? 1.75
        : 1.25
  return {
    color: EDGE_COLOR[edge.kind],
    size,
    kind: edge.kind,
    // No labels by default — the canvas already shows direction via
    // arrow tips. Step edges from the processes mode would benefit
    // from labels, follow-up.
  }
}

function runForceLayout(g: Graph): void {
  // forceAtlas2.assign mutates the node x/y attributes. Settings
  // tuned for graphs under ~600 nodes; gravity keeps disconnected
  // components from flying off-screen. `barnesHutOptimize` is the
  // approximation that makes layout linear-ish in node count.
  const iterations = Math.max(80, Math.min(400, Math.round(800 / Math.max(1, g.order / 100))))
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
  // Detect the active theme so we can pick contrasty defaults
  // without relying on CSS-variable rgba math (which produced
  // near-invisible greys against the dark canvas).
  const isDark =
    typeof document === 'undefined'
      ? true
      : (document.documentElement.dataset['theme'] === 'dark' ||
          (document.documentElement.dataset['theme'] !== 'light' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches))
  if (typeof window === 'undefined') {
    return {
      label: '#e5e7eb',
      dimmedNode: '#4f4a66',
      dimmedEdge: '#3d3a55',
      hoverBg: '#16131f',
      hoverBorder: '#3a3650',
    }
  }
  const styles = getComputedStyle(document.documentElement)
  const read = (token: string, fallback: string) => {
    const v = styles.getPropertyValue(token).trim()
    return v.length > 0 ? v : fallback
  }
  return {
    label: read('--text', isDark ? '#edeaf8' : '#18181b'),
    // The selected-node focus mode dims everything that isn't a
    // neighbour. Going too dim (using `--border` etc) made the
    // dimmed nodes disappear into the canvas on dark theme — pick
    // theme-explicit mid-greys instead so the structure of the rest
    // of the graph stays readable.
    dimmedNode: isDark ? '#4f4a66' : '#cbcad6',
    dimmedEdge: isDark ? '#3d3a55' : '#dcdae3',
    // Hover label pill (overrides sigma's hardcoded #FFF). Solid
    // surface color so it reads as "panel" against the canvas.
    hoverBg: read('--surface', isDark ? '#16131f' : '#ffffff'),
    hoverBorder: read('--border', isDark ? '#3a3650' : '#e0dfe6'),
  }
}

