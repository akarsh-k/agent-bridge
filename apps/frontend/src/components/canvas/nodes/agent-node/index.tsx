/**
 * Agent node — the centre of each agent's subgraph on the global canvas.
 *
 * Renders as a raised violet-accented card with the agent's initials, name,
 * slug, and a row of state badges (memory, LLM). The `dimmed` flag lets the
 * workspace canvas fade agents outside of the active focus group.
 */

import { useState, type MouseEvent } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AgentResponse } from '@agent-bridge/shared'
import type { AddResourceKind } from '../../../agent-workspace/add-resource-panel'
import { AgentQuickAdd } from '../../agent-quick-add'

import './index.css'

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentResponse
  mode?: 'overview' | 'focus'
  summary?: {
    readonly skills: number
    readonly tools: number
    readonly repos: number
    readonly mcps: number
  }
  onOpenAddResource?: (agentId: string, kind?: AddResourceKind) => void
  onRemoveAgent?: (agentId: string) => Promise<void>
  dimmed?: boolean
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'A'
}

export function AgentNode({ data, selected }: NodeProps) {
  const { agent, dimmed, mode, summary, onOpenAddResource, onRemoveAgent } =
    data as AgentNodeData
  const showConnectors = mode === 'focus'
  const isReady = agent.llmProviderId !== null
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!onRemoveAgent || deleting) return
    if (
      !window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)
    ) {
      return
    }
    setDeleting(true)
    try {
      await onRemoveAgent(agent.id)
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : 'Failed to delete agent',
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className={`node node-agent${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
    >
      {showConnectors ? (
        <Handle type="target" position={Position.Left} />
      ) : null}

      <div className="node-agent-head">
        <div className="node-agent-icon">{initials(agent.name)}</div>
        <div className="node-agent-title">
          <div className="node-agent-name">{agent.name}</div>
          <div className="node-agent-slug">{agent.slug}</div>
        </div>
        <span
          className={`node-agent-status${isReady ? ' is-ready' : ' needs-setup'}`}
        >
          {isReady ? 'Ready' : 'Needs setup'}
        </span>
      </div>

      <div className="node-agent-setup" aria-label="Agent setup status">
        <StatusItem
          label="LLM"
          value={agent.llmProviderId ? 'Connected' : 'Required'}
          tone={agent.llmProviderId ? 'ready' : 'warning'}
        />
        <StatusItem
          label="Memory"
          value={agent.memoryEnabled ? 'Enabled' : 'Off'}
          tone={agent.memoryEnabled ? 'ready' : 'neutral'}
        />
      </div>

      {mode === 'overview' && summary ? (
        <div className="node-agent-summary" aria-label="Attached resources">
          <span className="node-agent-resource-total">
            {formatResourceTotal(summary)}
          </span>
          <span className="node-agent-resource-detail">
            {formatResourceDetail(summary)}
          </span>
        </div>
      ) : null}

      {showConnectors ? (
        <Handle type="source" position={Position.Right} />
      ) : null}

      <div className="node-agent-actions nodrag">
        <div className="node-agent-actions-primary">
          {mode === 'focus' && onOpenAddResource ? (
            <AgentQuickAdd agentId={agent.id} onOpen={onOpenAddResource} />
          ) : (
            <span className="node-agent-action-hint">
              Click card to configure
            </span>
          )}
        </div>
        <div className="node-agent-actions-secondary">
          {onRemoveAgent ? (
            <button
              type="button"
              className="node-agent-action node-agent-action-danger"
              aria-label={`Delete ${agent.name}`}
              title={`Delete ${agent.name}`}
              onClick={(event) => void handleDelete(event)}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StatusItem({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'ready' | 'warning' | 'neutral'
}) {
  return (
    <div className="node-agent-setup-item">
      <span className={`node-agent-setup-dot ${tone}`} aria-hidden="true" />
      <span className="node-agent-setup-label">{label}</span>
      <span className="node-agent-setup-value">{value}</span>
    </div>
  )
}

function resourceTotal(summary: NonNullable<AgentNodeData['summary']>) {
  return summary.repos + summary.skills + summary.tools + summary.mcps
}

function formatResourceTotal(summary: NonNullable<AgentNodeData['summary']>) {
  const total = resourceTotal(summary)
  if (total === 0) return 'No resources attached'
  return `${total} resource${total === 1 ? '' : 's'} attached`
}

function formatResourceDetail(summary: NonNullable<AgentNodeData['summary']>) {
  if (resourceTotal(summary) === 0)
    return 'Attach repos, skills, tools, or MCPs'
  return formatResourceSummary(summary)
}

function formatResourceSummary(summary: NonNullable<AgentNodeData['summary']>) {
  const parts = [
    resourcePart(summary.repos, 'repo'),
    resourcePart(summary.skills, 'skill'),
    resourcePart(summary.tools, 'tool'),
    resourcePart(summary.mcps, 'MCP'),
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' · ') : 'No resources attached'
}

function resourcePart(value: number, label: string): string | null {
  if (value === 0) return null
  if (label === 'MCP') return `${value} MCP`
  return `${value} ${label}${value === 1 ? '' : 's'}`
}
