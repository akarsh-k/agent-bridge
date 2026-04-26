/**
 * WorkspaceCanvas — the single React Flow surface that renders every
 * agent along with grouped "satellite" cards for each kind of resource
 * attached to that agent (skills, tools, repos, MCPs, LLM).
 *
 * Node ids are prefixed by kind:
 *   - `agent:<uuid>`
 *   - `group:<kind>:<agentId>`  where kind ∈ {skill, tool, repo, mcp, llm}
 *
 * One edge per group → agent (not one per resource). Pill clicks inside a
 * group select the individual resource; clicks on the group chrome select
 * the group itself.
 *
 * Focus mode:
 *   - If `focusedAgentId` is set, every node/edge that doesn't touch the
 *     focused agent is rendered dimmed.
 *
 * Position state:
 *   - Held in a `useState` keyed by node id. New group nodes are seeded
 *     relative to their parent agent (see `seedGroupPositions`) so a
 *     newly-created skill/tool appears right next to its agent instead
 *     of at the origin. Unknown-topology nodes fall through to Dagre.
 *   - Drag drops flush to localStorage.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeMarkerType,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import {
  autoLayout,
  loadPositions,
  savePositions,
  seedGroupPositions,
  type PositionMap,
} from '../../../lib/layout'
import { AgentNode } from '../nodes/agent-node'
import { GroupNode, type GroupItem, type GroupKind } from '../nodes/group-node'

export type WorkspaceSelection =
  | null
  | { kind: 'agent'; id: string }
  | { kind: 'group'; groupKind: GroupKind; agentId: string }
  | { kind: 'repo'; id: string }
  | { kind: 'mcp'; id: string }
  | { kind: 'llm'; id: string }
  | { kind: 'skill'; id: string; agentId: string }
  | { kind: 'tool'; id: string; agentId: string }

export interface WorkspaceCanvasProps {
  workspace: WorkspaceContextValue
  focusedAgentId: string | null
  selection: WorkspaceSelection
  onSelect: (next: WorkspaceSelection) => void
  onFocusAgent: (id: string | null) => void
}

// Stable nodeTypes reference — React Flow warns loudly otherwise.
// NOTE: "group" is a reserved type name in React Flow that applies a grey
// swimlane background (via `.react-flow__node-group`). Use "kindGroup"
// instead so our custom group chrome is the only thing rendered.
const NODE_TYPES = {
  agent: AgentNode,
  kindGroup: GroupNode,
}

const GROUP_KINDS: readonly GroupKind[] = [
  'skill',
  'tool',
  'repo',
  'mcp',
  'llm',
]

// ─── id helpers ───────────────────────────────────────────────────────────

const agentNodeId = (id: string) => `agent:${id}`
const groupNodeId = (kind: GroupKind, agentId: string) =>
  `group:${kind}:${agentId}`

interface ParsedNodeId {
  kind: 'agent' | 'group'
  agentId: string
  groupKind?: GroupKind
}

function parseNodeId(id: string): ParsedNodeId | null {
  if (id.startsWith('agent:')) {
    return { kind: 'agent', agentId: id.slice('agent:'.length) }
  }
  if (id.startsWith('group:')) {
    const rest = id.slice('group:'.length)
    const sep = rest.indexOf(':')
    if (sep <= 0) return null
    const groupKind = rest.slice(0, sep) as GroupKind
    if (!GROUP_KINDS.includes(groupKind)) return null
    return { kind: 'group', agentId: rest.slice(sep + 1), groupKind }
  }
  return null
}

// ─── Graph builder ────────────────────────────────────────────────────────

interface BuiltGraph {
  nodes: Node[]
  edges: Edge[]
}

const ARROW_MARKER: EdgeMarkerType = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
}

function shortRemote(remoteUrl: string): string {
  try {
    const u = new URL(remoteUrl)
    const path = u.pathname.replace(/^\/+|\.git$/g, '')
    return `${u.hostname}/${path}`
  } catch {
    return remoteUrl
  }
}

function buildGraph(
  workspace: WorkspaceContextValue,
  focusedAgentId: string | null,
  positions: PositionMap,
): BuiltGraph {
  const { agents, repos, mcpConnections, llmProviders, agentResources } =
    workspace

  const nodes: Node[] = []
  const edges: Edge[] = []

  // Quick lookups so pill sublabels ("also attached to 2 others") stay O(1).
  const repoById = new Map(repos.map((r) => [r.id, r]))
  const mcpById = new Map(mcpConnections.map((m) => [m.id, m]))
  const llmById = new Map(llmProviders.map((l) => [l.id, l]))

  // Share counts for shared-resource pills.
  const repoShareCount = new Map<string, number>()
  const mcpShareCount = new Map<string, number>()
  const llmShareCount = new Map<string, number>()
  for (const agent of agents) {
    const res = agentResources[agent.id]
    if (res) {
      for (const att of res.attachedRepos) {
        repoShareCount.set(
          att.repo.id,
          (repoShareCount.get(att.repo.id) ?? 0) + 1,
        )
      }
      const touched = new Set<string>()
      for (const entry of res.mcpAllowlist) {
        if (entry.enabled) touched.add(entry.mcpConnectionId)
      }
      for (const mcpId of touched) {
        mcpShareCount.set(mcpId, (mcpShareCount.get(mcpId) ?? 0) + 1)
      }
    }
    if (agent.llmProviderId) {
      llmShareCount.set(
        agent.llmProviderId,
        (llmShareCount.get(agent.llmProviderId) ?? 0) + 1,
      )
    }
  }

  const shareSublabel = (count: number): string | undefined => {
    if (count <= 1) return undefined
    return count === 2 ? 'shared · 1 other' : `shared · ${count - 1} others`
  }

  // Focus-set = ids visible non-dimmed when focused. Empty focus → show all.
  const focusSet = new Set<string>()
  if (focusedAgentId) {
    focusSet.add(agentNodeId(focusedAgentId))
    for (const kind of GROUP_KINDS) {
      focusSet.add(groupNodeId(kind, focusedAgentId))
    }
  }
  const isDimmed = (nodeId: string): boolean =>
    focusedAgentId !== null && !focusSet.has(nodeId)

  for (const agent of agents) {
    const aNid = agentNodeId(agent.id)
    nodes.push({
      id: aNid,
      type: 'agent',
      position: positions[aNid] ?? { x: 0, y: 0 },
      data: { agent, dimmed: isDimmed(aNid) },
    })

    const res = agentResources[agent.id]

    // ── Skills group ────────────────────────────────────────────────
    const skillItems: GroupItem[] = (res?.skills ?? []).map((s) => ({
      id: s.id,
      label: s.name,
    }))
    if (skillItems.length > 0) {
      pushGroup(nodes, edges, {
        agentId: agent.id,
        agentNid: aNid,
        kind: 'skill',
        items: skillItems,
        positions,
        isDimmed,
      })
    }

    // ── Tools group ─────────────────────────────────────────────────
    const toolItems: GroupItem[] = (res?.tools ?? []).map((t) => ({
      id: t.id,
      label: t.name,
      sublabel: t.kind,
    }))
    if (toolItems.length > 0) {
      pushGroup(nodes, edges, {
        agentId: agent.id,
        agentNid: aNid,
        kind: 'tool',
        items: toolItems,
        positions,
        isDimmed,
      })
    }

    // ── Repos group ─────────────────────────────────────────────────
    const repoItems: GroupItem[] = (res?.attachedRepos ?? [])
      .map((att): GroupItem | null => {
        const r = repoById.get(att.repo.id) ?? att.repo
        return {
          id: r.id,
          label: shortRemote(r.remoteUrl),
          sublabel: att.role?.trim()
            ? att.role
            : (shareSublabel(repoShareCount.get(r.id) ?? 0) ?? r.branch),
        }
      })
      .filter((x): x is GroupItem => x !== null)
    if (repoItems.length > 0) {
      pushGroup(nodes, edges, {
        agentId: agent.id,
        agentNid: aNid,
        kind: 'repo',
        items: repoItems,
        positions,
        isDimmed,
      })
    }

    // ── MCPs group ──────────────────────────────────────────────────
    const enabledByMcp = new Map<string, number>()
    for (const entry of res?.mcpAllowlist ?? []) {
      if (!entry.enabled) continue
      enabledByMcp.set(
        entry.mcpConnectionId,
        (enabledByMcp.get(entry.mcpConnectionId) ?? 0) + 1,
      )
    }
    const mcpItems: GroupItem[] = [...enabledByMcp.entries()]
      .map(([mcpId, toolCount]): GroupItem | null => {
        const conn = mcpById.get(mcpId)
        if (!conn) return null
        const toolsLabel =
          toolCount === 1 ? '1 tool' : `${toolCount} tools`
        const share = shareSublabel(mcpShareCount.get(mcpId) ?? 0)
        return {
          id: conn.id,
          label: conn.name,
          sublabel: share ? `${toolsLabel} · ${share}` : toolsLabel,
        }
      })
      .filter((x): x is GroupItem => x !== null)
    if (mcpItems.length > 0) {
      pushGroup(nodes, edges, {
        agentId: agent.id,
        agentNid: aNid,
        kind: 'mcp',
        items: mcpItems,
        positions,
        isDimmed,
      })
    }

    // ── LLM group (0 or 1) ──────────────────────────────────────────
    if (agent.llmProviderId) {
      const prov = llmById.get(agent.llmProviderId)
      if (prov) {
        const llmItems: GroupItem[] = [
          {
            id: prov.id,
            label: prov.label,
            sublabel:
              shareSublabel(llmShareCount.get(prov.id) ?? 0) ?? prov.kind,
          },
        ]
        pushGroup(nodes, edges, {
          agentId: agent.id,
          agentNid: aNid,
          kind: 'llm',
          items: llmItems,
          positions,
          isDimmed,
        })
      }
    }
  }

  return { nodes, edges }
}

function pushGroup(
  nodes: Node[],
  edges: Edge[],
  params: {
    agentId: string
    agentNid: string
    kind: GroupKind
    items: readonly GroupItem[]
    positions: PositionMap
    isDimmed: (id: string) => boolean
  },
): void {
  const { agentId, agentNid, kind, items, positions, isDimmed } = params
  const nid = groupNodeId(kind, agentId)
  nodes.push({
    id: nid,
    type: 'kindGroup',
    position: positions[nid] ?? { x: 0, y: 0 },
    data: {
      groupKind: kind,
      agentId,
      items,
      dimmed: isDimmed(nid),
    },
  })
  edges.push({
    id: `e:${agentNid}->${nid}`,
    source: agentNid,
    target: nid,
    markerEnd: ARROW_MARKER,
    className: isDimmed(agentNid) || isDimmed(nid) ? 'dimmed' : undefined,
  })
}

// ─── Component ────────────────────────────────────────────────────────────

export function WorkspaceCanvas({
  workspace,
  focusedAgentId,
  selection,
  onSelect,
  onFocusAgent,
}: WorkspaceCanvasProps) {
  // Persistent position map — hydrated from localStorage, updated on drag,
  // merged with seed offsets + dagre output whenever new nodes appear. Held
  // in state (not a ref) so React 19's rules-of-hooks lint stays happy.
  const [positions, setPositions] = useState<PositionMap>(() => loadPositions())

  const built = useMemo(
    () => buildGraph(workspace, focusedAgentId, positions),
    [workspace, focusedAgentId, positions],
  )

  // React Flow owns node/edge arrays internally so it can handle drags etc.
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)

  // Sync React Flow's internal state whenever the built graph changes.
  const [lastBuilt, setLastBuilt] = useState<BuiltGraph | null>(null)
  if (lastBuilt !== built) {
    setLastBuilt(built)
    setNodes(built.nodes)
    setEdges(built.edges)
  }

  // Fill in any missing positions. Two-stage:
  //   1. Seed group nodes near their parent agent (fast, local, predictable).
  //   2. Fall back to dagre for anything still missing (typically only on
  //      first-ever render when no agents have saved positions yet).
  const missing = built.nodes.some((n) => !positions[n.id])
  if (missing) {
    const seeded = seedGroupPositions(built.nodes, positions)
    const stillMissing = built.nodes.some((n) => !seeded[n.id])
    const next = stillMissing
      ? autoLayout(built.nodes, built.edges, seeded)
      : seeded
    if (next !== positions) {
      setPositions(next)
      savePositions(next)
    }
  }

  // Apply selection ring to nodes. Merge into RF's draft (the one held in
  // `nodes`), not into `built.nodes`, so dragged positions aren't clobbered.
  const selectedNodeId = useMemo(() => {
    if (!selection) return null
    switch (selection.kind) {
      case 'agent':
        return agentNodeId(selection.id)
      case 'group':
        return groupNodeId(selection.groupKind, selection.agentId)
      // Individual resource selections don't map to a canvas node (the pill
      // lives inside a group card), so we highlight that group instead.
      case 'skill':
        return groupNodeId('skill', selection.agentId)
      case 'tool':
        return groupNodeId('tool', selection.agentId)
      case 'repo': {
        const owner = findAgentWithRepo(workspace, selection.id)
        return owner ? groupNodeId('repo', owner) : null
      }
      case 'mcp': {
        const owner = findAgentWithMcp(workspace, selection.id)
        return owner ? groupNodeId('mcp', owner) : null
      }
      case 'llm': {
        const owner = findAgentWithLlm(workspace, selection.id)
        return owner ? groupNodeId('llm', owner) : null
      }
    }
  }, [selection, workspace])

  const decoratedNodes = useMemo(
    () =>
      nodes.map((n) =>
        n.selected === (n.id === selectedNodeId)
          ? n
          : { ...n, selected: n.id === selectedNodeId },
      ),
    [nodes, selectedNodeId],
  )

  // Drag drops → persist positions.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)
      const drops: Record<string, { x: number; y: number }> = {}
      for (const c of changes) {
        if (c.type === 'position' && c.dragging === false && c.position) {
          drops[c.id] = c.position
        }
      }
      if (Object.keys(drops).length === 0) return
      setPositions((prev) => {
        const next = { ...prev, ...drops }
        savePositions(next)
        return next
      })
    },
    [onNodesChange],
  )

  // Manual connection-making is disabled for now — edges are derived
  // strictly from backend state. Drag-connects are a Phase 2 feature.
  const onConnect = useCallback(() => {}, [])

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const parsed = parseNodeId(node.id)
      if (!parsed) return

      if (parsed.kind === 'agent') {
        onSelect({ kind: 'agent', id: parsed.agentId })
        onFocusAgent(parsed.agentId)
        return
      }

      // parsed.kind === 'group' — route to a pill if the click landed on one.
      const target = event.target as HTMLElement | null
      const pill = target?.closest<HTMLElement>('[data-pill-id]')
      if (pill) {
        const pillId = pill.getAttribute('data-pill-id') ?? ''
        if (!pillId) return
        switch (parsed.groupKind) {
          case 'skill':
            onSelect({ kind: 'skill', id: pillId, agentId: parsed.agentId })
            return
          case 'tool':
            onSelect({ kind: 'tool', id: pillId, agentId: parsed.agentId })
            return
          case 'repo':
            onSelect({ kind: 'repo', id: pillId })
            return
          case 'mcp':
            onSelect({ kind: 'mcp', id: pillId })
            return
          case 'llm':
            onSelect({ kind: 'llm', id: pillId })
            return
        }
      }

      // Plain group click → select the group itself.
      if (parsed.groupKind) {
        onSelect({
          kind: 'group',
          groupKind: parsed.groupKind,
          agentId: parsed.agentId,
        })
      }
    },
    [onSelect, onFocusAgent],
  )

  const handlePaneClick = useCallback(() => {
    onSelect(null)
  }, [onSelect])

  return (
    <ReactFlow
      nodes={decoratedNodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        style={{ background: 'var(--bg-2)' }}
        nodeColor={(n) => nodeAccent(n.id)}
        nodeStrokeWidth={2}
      />
    </ReactFlow>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findAgentWithRepo(
  workspace: WorkspaceContextValue,
  repoId: string,
): string | null {
  for (const [agentId, res] of Object.entries(workspace.agentResources)) {
    if (res.attachedRepos.some((a) => a.repo.id === repoId)) return agentId
  }
  return null
}

function findAgentWithMcp(
  workspace: WorkspaceContextValue,
  mcpId: string,
): string | null {
  for (const [agentId, res] of Object.entries(workspace.agentResources)) {
    if (
      res.mcpAllowlist.some(
        (e) => e.enabled && e.mcpConnectionId === mcpId,
      )
    ) {
      return agentId
    }
  }
  return null
}

function findAgentWithLlm(
  workspace: WorkspaceContextValue,
  llmId: string,
): string | null {
  for (const agent of workspace.agents) {
    if (agent.llmProviderId === llmId) return agent.id
  }
  return null
}

function nodeAccent(id: string): string {
  if (id.startsWith('agent:')) return '#8b5cf6'
  if (id.startsWith('group:skill:')) return '#34d399'
  if (id.startsWith('group:tool:')) return '#38bdf8'
  if (id.startsWith('group:repo:')) return '#f97316'
  if (id.startsWith('group:mcp:')) return '#fb7185'
  if (id.startsWith('group:llm:')) return '#fbbf24'
  return '#64748b'
}
