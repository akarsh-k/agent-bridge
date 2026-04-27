/**
 * Contextual right work panel. Hosts the Inspector, focused-agent Chat, and
 * Activity stream; only one is visible at a time via tabs.
 *
 * Inspector dispatch — the rail picks which form/card to render from the
 * tagged `WorkspaceSelection`:
 *   - agent  → `AgentInspector` (full edit)
 *   - group  → `GroupInspector` (list of items with click-through)
 *   - repo   → `RepoInspector`  (read-only, with attachment map)
 *   - mcp    → `McpInspector`   (read-only, with allowlist map)
 *   - llm    → `LlmProviderInspector`
 *   - skill  → `SkillInspector`
 *   - tool   → `ToolInspector`
 *
 * Collapse behaviour is handled by the parent flipping `data-collapsed`
 * on the root; CSS transitions the width to zero so the canvas reclaims
 * the space.
 */

import type { AgentResponse, RunEvent } from '@agent-bridge/shared'
import { AgentInspector } from '../../inspector/agent-inspector'
import { ActivityPanel } from '../../activity/activity-panel'
import { ChatPanel } from '../../chat/chat-panel'
import { GroupInspector } from '../../inspector/group-inspector'
import { RepoInspector } from '../../inspector/repo-inspector'
import { McpInspector } from '../../inspector/mcp-inspector'
import { LlmProviderInspector } from '../../inspector/llm-provider-inspector'
import { SkillInspector } from '../../inspector/skill-inspector'
import { ToolInspector } from '../../inspector/tool-inspector'
import type { WorkspaceSelection } from '../../canvas/workspace-canvas'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

import './index.css'

type RailTab = 'inspector' | 'chat' | 'activity'

export function RightRail({
  collapsed,
  tab,
  onTabChange,
  workspace,
  selection,
  onSelect,
  focusedAgent,
  activityStreamId,
  activityEvents,
  activityConnected,
}: {
  collapsed: boolean
  tab: RailTab
  onTabChange: (tab: RailTab) => void
  workspace: WorkspaceContextValue
  selection: WorkspaceSelection
  onSelect: (next: WorkspaceSelection) => void
  focusedAgent: AgentResponse | null
  activityStreamId: string | null
  activityEvents: readonly RunEvent[]
  activityConnected: boolean
}) {
  const focusedAgentName = focusedAgent?.name ?? null
  const activityEventCount = activityEvents.filter(
    (e) => e.kind !== 'ping',
  ).length

  return (
    <aside
      className={`right-rail right-rail-${tab}`}
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Inspector, chat, and activity"
    >
      <header className="rail-header">
        <div>
          <div className="rail-eyebrow">
            {focusedAgentName ? 'Focused agent' : 'Workspace'}
          </div>
          <div className="rail-title">
            {tab === 'inspector'
              ? 'Inspector'
              : tab === 'chat'
                ? 'Chat'
                : 'Activity'}
          </div>
          <div className="rail-subtitle">
            {tab === 'inspector'
              ? inspectorSubtitle(selection, focusedAgentName)
              : tab === 'chat'
                ? chatSubtitle(focusedAgent)
                : activitySubtitle(activityStreamId, activityConnected)}
          </div>
        </div>
        {tab === 'activity' ? (
          <span
            className={`rail-live-pill${activityConnected ? ' is-live' : ''}`}
          >
            {activityConnected ? 'Live' : 'Idle'}
          </span>
        ) : null}
      </header>

      <div className="rail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'inspector'}
          className="rail-tab"
          onClick={() => onTabChange('inspector')}
        >
          Inspector
        </button>
        {focusedAgent ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className="rail-tab"
            onClick={() => onTabChange('chat')}
          >
            Chat
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          className="rail-tab"
          onClick={() => onTabChange('activity')}
        >
          Activity
          {activityEventCount > 0 ? (
            <span className="rail-tab-count">{activityEventCount}</span>
          ) : null}
        </button>
      </div>

      <div className="rail-body" role="tabpanel">
        {tab === 'inspector' ? (
          renderInspector(workspace, selection, onSelect, focusedAgentName)
        ) : tab === 'chat' && focusedAgent ? (
          <ChatPanel agent={focusedAgent} />
        ) : (
          <ActivityPanel
            streamId={activityStreamId}
            events={activityEvents}
            connected={activityConnected}
          />
        )}
      </div>
    </aside>
  )
}

function renderInspector(
  workspace: WorkspaceContextValue,
  selection: WorkspaceSelection,
  onSelect: (next: WorkspaceSelection) => void,
  focusedAgentName: string | null,
) {
  if (!selection) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-kicker">No selection</div>
        <div className="rail-empty-title">
          {focusedAgentName
            ? `Select something for ${focusedAgentName}`
            : 'Select an agent to inspect'}
        </div>
        <div className="rail-empty-hint">
          {focusedAgentName
            ? 'Choose the agent card or one of its resources to edit configuration here.'
            : 'Click an agent card to focus it, chat, and manage its resources.'}
        </div>
      </div>
    )
  }

  switch (selection.kind) {
    case 'agent': {
      const agent = workspace.getAgent(selection.id)
      if (!agent) return <NotFound kind="agent" />
      return <AgentInspector key={agent.id} agent={agent} />
    }
    case 'group': {
      const agent = workspace.getAgent(selection.agentId)
      if (!agent) return <NotFound kind="group" />
      return (
        <GroupInspector
          key={`${agent.id}:${selection.groupKind}`}
          groupKind={selection.groupKind}
          agent={agent}
          workspace={workspace}
          onSelect={onSelect}
        />
      )
    }
    case 'skill': {
      const bundle = workspace.agentResources[selection.agentId]
      const skill = bundle?.skills.find((s) => s.id === selection.id)
      const agent = workspace.getAgent(selection.agentId) ?? null
      if (!skill) return <NotFound kind="skill" />
      return <SkillInspector key={skill.id} skill={skill} agent={agent} />
    }
    case 'tool': {
      const bundle = workspace.agentResources[selection.agentId]
      const tool = bundle?.tools.find((t) => t.id === selection.id)
      const agent = workspace.getAgent(selection.agentId) ?? null
      if (!tool) return <NotFound kind="tool" />
      return <ToolInspector key={tool.id} tool={tool} agent={agent} />
    }
    case 'repo': {
      const repo = workspace.repos.find((r) => r.id === selection.id)
      if (!repo) return <NotFound kind="repo" />
      return <RepoInspector key={repo.id} repo={repo} workspace={workspace} />
    }
    case 'mcp': {
      const conn = workspace.mcpConnections.find((c) => c.id === selection.id)
      if (!conn) return <NotFound kind="mcp" />
      return (
        <McpInspector key={conn.id} connection={conn} workspace={workspace} />
      )
    }
    case 'llm': {
      const p = workspace.llmProviders.find((x) => x.id === selection.id)
      if (!p) return <NotFound kind="llm" />
      return (
        <LlmProviderInspector key={p.id} provider={p} workspace={workspace} />
      )
    }
  }
}

function chatSubtitle(agent: AgentResponse | null): string {
  if (!agent) return 'Focus an agent to start chatting'
  if (!agent.llmProviderId) return 'Attach an LLM provider before chatting'
  return 'Ask questions and test behavior'
}

function inspectorSubtitle(
  selection: WorkspaceSelection,
  focusedAgentName: string | null,
): string {
  if (!selection) {
    return focusedAgentName
      ? `Ready for ${focusedAgentName}`
      : 'Select an agent or resource'
  }
  switch (selection.kind) {
    case 'agent':
      return 'Agent settings and defaults'
    case 'group':
      return `${selection.groupKind.toUpperCase()} resource group`
    case 'skill':
      return 'Prompt skill details'
    case 'tool':
      return 'Callable tool details'
    case 'repo':
      return 'Repository context'
    case 'mcp':
      return 'MCP connection details'
    case 'llm':
      return 'LLM provider details'
  }
}

function activitySubtitle(streamId: string | null, connected: boolean): string {
  if (!streamId) return 'Focus an agent to watch runs'
  return connected ? 'Streaming agent run events' : 'Waiting for events'
}

function NotFound({ kind }: { kind: string }) {
  return (
    <div className="rail-empty">
      <div className="rail-empty-kicker">Missing</div>
      <div className="rail-empty-title">Selected {kind} vanished</div>
      <div className="rail-empty-hint">
        It may have been deleted while you were looking at it.
      </div>
    </div>
  )
}
