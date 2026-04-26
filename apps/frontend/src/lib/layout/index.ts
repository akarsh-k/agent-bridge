/**
 * Canvas layout helpers — dagre-based auto-layout + localStorage persistence.
 *
 * Why:
 *   - The global canvas has up to ~6 node kinds and dozens of edges. Dropping
 *     everything at (0,0) is unreadable; hand-placing every node every render
 *     is wasteful. Dagre gives a clean left-to-right flow layout in O(n²)
 *     with zero configuration.
 *   - Users drag nodes to their preferred spots. Those drags must survive a
 *     reload, so we persist positions keyed by the node id.
 *
 * The policy:
 *   - On first render of a never-seen node, we auto-layout the whole graph
 *     and commit every un-placed node's position.
 *   - Subsequent renders respect saved positions verbatim. Nodes that were
 *     laid out previously but aren't in `existing` yet (because this is the
 *     first time the user sees them) are placed via dagre and saved.
 *   - Deleted nodes stay in the position map — cheap, and lets the user
 *     re-add without shuffling. We don't prune aggressively.
 *
 * Storage:
 *   - `localStorage` under a versioned key (`ab:positions:v1`). If the
 *     stored JSON doesn't parse or shape-match, we silently fall back to
 *     an empty map — better than throwing on every mount.
 */

import dagre from '@dagrejs/dagre'
import type { Edge, Node, XYPosition } from '@xyflow/react'

export type PositionMap = Record<string, XYPosition>

const STORAGE_KEY = 'ab:positions:v1'

/**
 * Per-kind bounding box used by dagre and by the grid spacing. These match
 * the CSS `.node-*` card sizes — if you resize those, update here too.
 */
export const NODE_SIZES = {
  agent: { width: 240, height: 136 },
  // Group cards hold stacked mini-cards inside; they're wider and taller
  // than they used to be as pills. Height is an estimate for Dagre —
  // actual DOM height scales with item count.
  group: { width: 300, height: 220 },
  unknown: { width: 200, height: 80 },
} as const

type NodeKind = keyof typeof NODE_SIZES

/**
 * Infer the kind from the node id prefix. The WorkspaceCanvas uses prefixed
 * ids (`agent:<uuid>`, `group:<kind>:<uuid>`) so this stays O(1) without
 * having to plumb a `type` discriminator into the layout call.
 */
function kindOf(nodeId: string): NodeKind {
  const colon = nodeId.indexOf(':')
  if (colon <= 0) return 'unknown'
  const prefix = nodeId.slice(0, colon)
  if (prefix in NODE_SIZES) return prefix as NodeKind
  return 'unknown'
}

/**
 * Radial offsets applied when seeding a group node's initial position
 * relative to its parent agent. Each kind gets a stable "slot" around the
 * agent so the canvas stays readable even with many agents present.
 *
 * Numbers are tuned so five groups fit around one agent (240 wide) without
 * overlap, assuming the group card is ~300 wide and can grow tall as more
 * items are stacked inside it.
 */
const GROUP_OFFSETS: Record<string, { dx: number; dy: number }> = {
  skill: { dx: 380, dy: -150 },
  tool: { dx: 380, dy: 140 },
  repo: { dx: 0, dy: 300 },
  mcp: { dx: -380, dy: 140 },
  llm: { dx: -380, dy: -150 },
}

/**
 * Seed any missing group-node positions relative to their parent agent.
 * This is what stops newly-created skills/tools/etc. from landing at
 * (0, 0) or in Dagre-coordinate space that's nowhere near the user's
 * current viewport.
 *
 * Group node id shape: `group:<kind>:<agentId>`.
 * Only seeds when the parent agent already has a saved position; otherwise
 * the caller's Dagre pass will handle it.
 */
export function seedGroupPositions(
  nodes: readonly Node[],
  existing: PositionMap,
): PositionMap {
  let out: PositionMap | null = null
  for (const n of nodes) {
    if (existing[n.id]) continue
    if (!n.id.startsWith('group:')) continue
    const rest = n.id.slice('group:'.length)
    const sep = rest.indexOf(':')
    if (sep <= 0) continue
    const groupKind = rest.slice(0, sep)
    const agentId = rest.slice(sep + 1)
    const agentPos = existing[`agent:${agentId}`]
    if (!agentPos) continue
    const offset = GROUP_OFFSETS[groupKind]
    if (!offset) continue
    if (!out) out = { ...existing }
    out[n.id] = { x: agentPos.x + offset.dx, y: agentPos.y + offset.dy }
  }
  return out ?? existing
}

// ─── Persistence ──────────────────────────────────────────────────────────

function isXYPosition(v: unknown): v is XYPosition {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { x?: unknown }).x === 'number' &&
    typeof (v as { y?: unknown }).y === 'number'
  )
}

export function loadPositions(): PositionMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: PositionMap = {}
    for (const [id, pos] of Object.entries(parsed as Record<string, unknown>)) {
      if (isXYPosition(pos)) out[id] = { x: pos.x, y: pos.y }
    }
    return out
  } catch {
    return {}
  }
}

export function savePositions(map: PositionMap): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // QuotaExceeded or SecurityError (incognito) — positions are a nice-
    // to-have, never crash the canvas because of them.
  }
}

// ─── Auto-layout ──────────────────────────────────────────────────────────

/**
 * Compute positions for any nodes that don't already have one in `existing`.
 * Returns a merged position map (caller is expected to save it).
 *
 * Nodes that are already placed stay put — dagre is only consulted for the
 * newcomers, but it needs the full graph to place them coherently. That's
 * why we feed every node/edge in and then overlay `existing` afterward.
 */
export function autoLayout(
  nodes: readonly Node[],
  edges: readonly Edge[],
  existing: PositionMap,
): PositionMap {
  const g = new dagre.graphlib.Graph<Record<string, unknown>>()
  g.setGraph({
    rankdir: 'LR',
    nodesep: 36,
    ranksep: 96,
    marginx: 32,
    marginy: 32,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) {
    const size = NODE_SIZES[kindOf(n.id)]
    g.setNode(n.id, { width: size.width, height: size.height })
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target)
  }

  try {
    dagre.layout(g)
  } catch {
    // Dagre occasionally throws on degenerate graphs (single node, etc).
    // Fall back to a simple grid so the canvas never breaks.
    return fallbackGrid(nodes, existing)
  }

  const out: PositionMap = {}
  for (const n of nodes) {
    const saved = existing[n.id]
    if (saved) {
      out[n.id] = saved
      continue
    }
    const laid = g.node(n.id) as { x: number; y: number } | undefined
    if (!laid) {
      out[n.id] = { x: 0, y: 0 }
      continue
    }
    // Dagre returns the centre; React Flow uses the top-left corner.
    const size = NODE_SIZES[kindOf(n.id)]
    out[n.id] = {
      x: laid.x - size.width / 2,
      y: laid.y - size.height / 2,
    }
  }
  return out
}

function fallbackGrid(
  nodes: readonly Node[],
  existing: PositionMap,
): PositionMap {
  const out: PositionMap = { ...existing }
  let i = 0
  for (const n of nodes) {
    if (out[n.id]) continue
    const col = i % 4
    const row = Math.floor(i / 4)
    out[n.id] = { x: col * 280, y: row * 180 }
    i += 1
  }
  return out
}
