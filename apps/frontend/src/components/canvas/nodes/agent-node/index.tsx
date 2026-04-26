/**
 * Agent node — the centre of each agent's subgraph on the global canvas.
 *
 * Renders as a raised violet-accented card with the agent's initials, name,
 * slug, and a row of state badges (memory, LLM). The `dimmed` flag lets the
 * workspace canvas fade agents outside of the active focus group.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AgentResponse } from '@agent-bridge/shared'
import { AgentQuickAdd } from '../../agent-quick-add'

import './index.css'

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentResponse
  dimmed?: boolean
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'A'
}

export function AgentNode({ data, selected }: NodeProps) {
  const { agent, dimmed } = data as AgentNodeData

  return (
    <div
      className={`node node-agent${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="node-agent-head">
        <div className="node-agent-icon">{initials(agent.name)}</div>
        <div className="node-agent-title">
          <div className="node-agent-name">{agent.name}</div>
          <div className="node-agent-slug">{agent.slug}</div>
        </div>
      </div>

      <div className="node-badges">
        <span className="badge badge-accent">
          <span className="badge-dot" aria-hidden="true" />
          agent
        </span>
        {agent.memoryEnabled ? (
          <span className="badge badge-success">memory</span>
        ) : (
          <span className="badge">no memory</span>
        )}
        {agent.llmProviderId ? (
          <span className="badge badge-accent">llm</span>
        ) : (
          <span className="badge badge-warn">llm: unset</span>
        )}
      </div>

      <Handle type="source" position={Position.Right} />

      <AgentQuickAdd agentId={agent.id} />
    </div>
  )
}
