/**
 * Tiny canvas trigger only. The creation/editing flow is intentionally
 * workspace-level now (`AddResourcePanel`) so forms have room to breathe
 * and are not clipped by React Flow node bounds.
 */

import type { AddResourceKind } from '../../agent-workspace/add-resource-panel'

import './index.css'

export function AgentQuickAdd({
  agentId,
  onOpen,
}: {
  readonly agentId: string
  readonly onOpen: (agentId: string, kind?: AddResourceKind) => void
}) {
  return (
    <div className="node-qa-host nodrag" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="node-agent-action node-agent-action-primary node-qa-trigger"
        aria-label="Add resource to agent"
        title="Add to agent"
        onClick={(e) => {
          e.stopPropagation()
          onOpen(agentId)
        }}
      >
        <span>Attach resource</span>
      </button>
    </div>
  )
}
