/**
 * Canvas layout helpers — deterministic canvas layout + localStorage
 * persistence.
 *
 * Why:
 *   - The workspace has two UX states:
 *       1. overview: one card per agent, arranged in a predictable grid.
 *       2. focus: one agent plus its local resource groups in stable slots.
 *     Generic graph layout made new agents hard to find; deterministic slots
 *     make creation and recovery predictable.
 *   - Users drag nodes to their preferred spots. Those drags must survive a
 *     reload, so we persist positions keyed by the node id.
 *
 * The policy:
 *   - First sight of a node gets a deterministic slot.
 *   - User drags win after that and persist.
 *   - "Organize" reapplies deterministic slots for the current mode.
 *   - Deleted nodes stay in the position map — cheap, and lets the user
 *     re-add without shuffling. We don't prune aggressively.
 *
 * Storage:
 *   - `localStorage` under a versioned key (`ab:positions:v2`). If the
 *     stored JSON doesn't parse or shape-match, we silently fall back to
 *     an empty map — better than throwing on every mount.
 */

import type { Node, XYPosition } from '@xyflow/react'

export type PositionMap = Record<string, XYPosition>

const STORAGE_KEY = 'ab:positions:v2'

/**
 * Per-kind bounding box used by dagre and by the grid spacing. These match
 * the CSS `.node-*` card sizes — if you resize those, update here too.
 */
export const NODE_SIZES = {
  agent: { width: 300, height: 230 },
  // Group cards hold stacked mini-cards inside; they're wider and taller
  // than they used to be as pills. Height is an estimate for Dagre —
  // actual DOM height scales with item count.
  group: { width: 280, height: 200 },
  unknown: { width: 200, height: 80 },
} as const

const OVERVIEW_GRID = {
  startX: 72,
  startY: 88,
  colGap: 380,
  rowGap: 285,
  columns: 3,
} as const

const CREATE_AGENT_NODE_ID = 'create-agent'

function isOverviewGridNode(id: string): boolean {
  return id.startsWith('agent:') || id === CREATE_AGENT_NODE_ID
}

const FOCUS_ANCHOR: XYPosition = { x: 0, y: 0 }

const FOCUS_GROUP_OFFSETS: Record<string, XYPosition> = {
  llm: { x: -390, y: -180 },
  mcp: { x: -390, y: 120 },
  skill: { x: 360, y: -220 },
  tool: { x: 360, y: 40 },
  repo: { x: 360, y: 300 },
}

function overviewPosition(slot: number): XYPosition {
  const col = slot % OVERVIEW_GRID.columns
  const row = Math.floor(slot / OVERVIEW_GRID.columns)
  return {
    x: OVERVIEW_GRID.startX + col * OVERVIEW_GRID.colGap,
    y: OVERVIEW_GRID.startY + row * OVERVIEW_GRID.rowGap,
  }
}

function overviewSlotForPosition(pos: XYPosition): number | null {
  const col = (pos.x - OVERVIEW_GRID.startX) / OVERVIEW_GRID.colGap
  const row = (pos.y - OVERVIEW_GRID.startY) / OVERVIEW_GRID.rowGap
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null
  if (col < 0 || row < 0 || col >= OVERVIEW_GRID.columns) return null
  return row * OVERVIEW_GRID.columns + col
}

/**
 * Deterministic overview grid. Existing positions are respected unless
 * `force` is true (used by the "Organize" toolbar button).
 */
export function layoutAgentOverview(
  nodes: readonly Node[],
  existing: PositionMap,
  opts: { readonly force?: boolean } = {},
): PositionMap {
  const out: PositionMap = { ...existing }
  const agents = nodes.filter((n) => isOverviewGridNode(n.id))
  const occupiedSlots = new Set<number>()

  if (!opts.force) {
    for (const n of agents) {
      const pos = out[n.id]
      if (!pos) continue
      const slot = overviewSlotForPosition(pos)
      if (slot !== null) occupiedSlots.add(slot)
    }
  }

  let nextSlot = 0
  for (let i = 0; i < agents.length; i += 1) {
    const n = agents[i]
    if (!n) continue
    if (!opts.force && out[n.id]) continue

    const slot = opts.force ? i : nextFreeOverviewSlot(occupiedSlots, nextSlot)
    out[n.id] = overviewPosition(slot)
    occupiedSlots.add(slot)
    nextSlot = slot + 1
  }
  return out
}

function nextFreeOverviewSlot(
  occupied: ReadonlySet<number>,
  start: number,
): number {
  let slot = start
  while (occupied.has(slot)) slot += 1
  return slot
}

/**
 * Focused agent cluster. The agent keeps its persisted position unless
 * forced; resource groups occupy stable slots around it.
 */
export function layoutFocusedCluster(
  nodes: readonly Node[],
  existing: PositionMap,
  opts: { readonly force?: boolean } = {},
): PositionMap {
  const out: PositionMap = { ...existing }
  const agent = nodes.find((n) => n.id.startsWith('agent:'))
  if (!agent) return out

  const savedAnchor = out[agent.id]
  const anchor: XYPosition =
    !opts.force && savedAnchor ? savedAnchor : FOCUS_ANCHOR
  out[agent.id] = anchor

  for (const n of nodes) {
    if (!n.id.startsWith('group:')) continue
    if (!opts.force && out[n.id]) continue
    const groupKind = n.id.slice('group:'.length).split(':', 1)[0]
    if (!groupKind) continue
    const offset = FOCUS_GROUP_OFFSETS[groupKind]
    if (!offset) continue
    out[n.id] = { x: anchor.x + offset.x, y: anchor.y + offset.y }
  }
  return out
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

export function clearSavedPositions(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Same posture as savePositions: layout persistence is optional.
  }
}

// ─── Compatibility fallback ───────────────────────────────────────────────

export function fallbackGrid(
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

export function positionForNode(
  nodeId: string,
  positions: PositionMap,
): XYPosition | null {
  return positions[nodeId] ?? null
}
