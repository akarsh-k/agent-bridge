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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import type { AddResourceKind } from '../../agent-workspace/add-resource-panel'
import {
  clearSavedPositions,
  layoutAgentOverview,
  layoutFocusedCluster,
  loadPositions,
  savePositions,
  type PositionMap,
} from '../../../lib/layout'
import { AgentNode } from '../nodes/agent-node'
import { AgentCreateNode } from '../nodes/agent-create-node'
import { GroupNode, type GroupKind } from '../nodes/group-node'
import { CanvasToolbar } from '../canvas-toolbar'

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
  onOpenAddResource: (agentId: string, kind?: AddResourceKind) => void
  onRemoveAgent: (agentId: string) => Promise<void>
  onCreateAgent: () => Promise<void>
  creatingAgent?: boolean
}

type CanvasMode = 'overview' | 'focus'

// Stable nodeTypes reference — React Flow warns loudly otherwise.
// NOTE: "group" is a reserved type name in React Flow that applies a grey
// swimlane background (via `.react-flow__node-group`). Use "kindGroup"
// instead so our custom group chrome is the only thing rendered.
const NODE_TYPES = {
  agent: AgentNode,
  agentCreate: AgentCreateNode,
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
const createAgentNodeId = 'create-agent'
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

export interface AgentNodeSummary {
  readonly skills: number
  readonly tools: number
  readonly repos: number
  readonly mcps: number
}

function summarizeAgent(
  res: WorkspaceContextValue['agentResources'][string] | undefined,
): AgentNodeSummary {
  const enabledMcps = new Set<string>()
  for (const entry of res?.mcpAllowlist ?? []) {
    if (entry.enabled) enabledMcps.add(entry.mcpConnectionId)
  }
  return {
    skills: res?.skills.length ?? 0,
    tools: res?.tools.length ?? 0,
    repos: res?.attachedRepos.length ?? 0,
    mcps: enabledMcps.size,
  }
}

function buildGraph(
  workspace: WorkspaceContextValue,
  focusedAgentId: string | null,
  positions: PositionMap,
  onOpenAddResource: (agentId: string, kind?: AddResourceKind) => void,
  onRemoveAgent: (agentId: string) => Promise<void>,
  onCreateAgent: () => Promise<void>,
  creatingAgent: boolean | undefined,
): BuiltGraph {
  const { agents, agentResources } = workspace

  const nodes: Node[] = []
  const edges: Edge[] = []

  const mode: CanvasMode = focusedAgentId ? 'focus' : 'overview'
  const isDimmed = (nodeId: string): boolean => {
    void nodeId
    return false
  }

  const orderedAgents = [...agents].sort((a, b) => {
    const created = a.createdAt.localeCompare(b.createdAt)
    if (created !== 0) return created
    return a.name.localeCompare(b.name)
  })

  for (const agent of orderedAgents) {
    if (mode === 'focus' && agent.id !== focusedAgentId) continue

    const aNid = agentNodeId(agent.id)
    const res = agentResources[agent.id]
    nodes.push({
      id: aNid,
      type: 'agent',
      position: positions[aNid] ?? { x: 0, y: 0 },
      data: {
        agent,
        dimmed: isDimmed(aNid),
        mode,
        summary: summarizeAgent(res),
        onOpenAddResource,
        onRemoveAgent,
      },
    })
  }

  if (mode === 'overview') {
    nodes.push({
      id: createAgentNodeId,
      type: 'agentCreate',
      position: positions[createAgentNodeId] ?? { x: 0, y: 0 },
      data: {
        creating: creatingAgent,
        onCreateAgent,
      },
      draggable: false,
      selectable: false,
    })
  }

  return { nodes, edges }
}

// ─── Component ────────────────────────────────────────────────────────────

export function WorkspaceCanvas({
  workspace,
  focusedAgentId,
  selection,
  onSelect,
  onFocusAgent,
  onOpenAddResource,
  onRemoveAgent,
  onCreateAgent,
  creatingAgent,
}: WorkspaceCanvasProps) {
  // Persistent position map — hydrated from localStorage, updated on drag,
  // merged with seed offsets + dagre output whenever new nodes appear. Held
  // in state (not a ref) so React 19's rules-of-hooks lint stays happy.
  const [positions, setPositions] = useState<PositionMap>(() => loadPositions())
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const lastOverviewSignatureRef = useRef<string | null>(null)
  const mode: CanvasMode = focusedAgentId ? 'focus' : 'overview'

  const built = useMemo(
    () =>
      buildGraph(
        workspace,
        focusedAgentId,
        positions,
        onOpenAddResource,
        onRemoveAgent,
        onCreateAgent,
        creatingAgent,
      ),
    [
      workspace,
      focusedAgentId,
      positions,
      onOpenAddResource,
      onRemoveAgent,
      onCreateAgent,
      creatingAgent,
    ],
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

  // Fill in missing positions using the deterministic strategy for the
  // current UX state. Overview is a grid; focus is one local cluster.
  const missing = built.nodes.some((n) => !positions[n.id])
  if (missing) {
    const next =
      mode === 'focus'
        ? layoutFocusedCluster(built.nodes, positions)
        : layoutAgentOverview(built.nodes, positions)
    if (next !== positions) {
      setPositions(next)
      savePositions(next)
    }
  }

  useEffect(() => {
    if (mode !== 'overview') return
    const signature = built.nodes
      .map((n) => n.id)
      .filter((id) => id.startsWith('agent:'))
      .sort()
      .join('|')

    if (lastOverviewSignatureRef.current === null) {
      lastOverviewSignatureRef.current = signature
      return
    }
    if (lastOverviewSignatureRef.current === signature) return

    lastOverviewSignatureRef.current = signature
    setPositions((prev) => {
      const next = layoutAgentOverview(built.nodes, prev, { force: true })
      savePositions(next)
      return next
    })
  }, [built.nodes, mode])

  const organize = useCallback(() => {
    setPositions((prev) => {
      const next =
        mode === 'focus'
          ? layoutFocusedCluster(built.nodes, prev, { force: true })
          : layoutAgentOverview(built.nodes, prev, { force: true })
      savePositions(next)
      return next
    })
  }, [built.nodes, mode])

  const resetLayout = useCallback(() => {
    clearSavedPositions()
    const next =
      mode === 'focus'
        ? layoutFocusedCluster(built.nodes, {}, { force: true })
        : layoutAgentOverview(built.nodes, {}, { force: true })
    savePositions(next)
    setPositions(next)
  }, [built.nodes, mode])

  useEffect(() => {
    if (!flowRef.current || built.nodes.length === 0) return
    const handle = window.setTimeout(() => {
      flowRef.current?.fitView({
        padding: mode === 'focus' ? 0.2 : 0.22,
        maxZoom: mode === 'focus' ? 1.02 : 1.05,
        duration: 360,
      })
    }, 80)
    return () => window.clearTimeout(handle)
  }, [built.nodes.length, focusedAgentId, mode])

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
        return focusedAgentId ? agentNodeId(selection.agentId) : null
      case 'tool':
        return focusedAgentId ? agentNodeId(selection.agentId) : null
      case 'repo':
      case 'mcp':
      case 'llm':
        return focusedAgentId ? agentNodeId(focusedAgentId) : null
    }
  }, [focusedAgentId, selection])

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
      onInit={(instance) => {
        flowRef.current = instance
      }}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <Controls showInteractive={false} />
      <CanvasToolbar
        mode={mode}
        canExitFocus={focusedAgentId !== null}
        onOverview={() => onFocusAgent(null)}
        onOrganize={organize}
        onResetLayout={resetLayout}
      />
    </ReactFlow>
  )
}
