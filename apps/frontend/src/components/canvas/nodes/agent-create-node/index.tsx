import { type NodeProps } from '@xyflow/react'

import './index.css'

export interface AgentCreateNodeData extends Record<string, unknown> {
  readonly creating?: boolean
  readonly onCreateAgent?: () => Promise<void>
}

export function AgentCreateNode({ data }: NodeProps) {
  const { creating, onCreateAgent } = data as AgentCreateNodeData

  return (
    <button
      type="button"
      className="node node-agent-create nodrag"
      onClick={(event) => {
        event.stopPropagation()
        if (!creating) void onCreateAgent?.()
      }}
      disabled={creating || !onCreateAgent}
    >
      <span className="node-agent-create-topline">
        <span className="node-agent-create-mark icon-plus" aria-hidden="true" />
        <span className="node-agent-create-kicker">New workspace agent</span>
      </span>
      <span className="node-agent-create-main">
        <span className="node-agent-create-title">
          {creating ? 'Creating agent...' : 'Create new agent'}
        </span>
        <span className="node-agent-create-copy">
          Set up an LLM, attach resources, and start testing from one focused
          view.
        </span>
      </span>
      <span className="node-agent-create-action">
        {creating ? 'Please wait' : 'Start setup'}
      </span>
    </button>
  )
}
