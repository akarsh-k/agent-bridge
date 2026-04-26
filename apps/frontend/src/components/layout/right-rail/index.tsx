/**
 * Contextual right rail. Hosts the Inspector (for the selected node) and
 * the Activity stream; only one is visible at a time via tabs.
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

import type { RunEvent } from '@agent-bridge/shared'
import { AgentInspector } from '../../inspector/agent-inspector'
import { ActivityPanel } from '../../activity/activity-panel'
import { GroupInspector } from '../../inspector/group-inspector'
import { RepoInspector } from '../../inspector/repo-inspector'
import { McpInspector } from '../../inspector/mcp-inspector'
import { LlmProviderInspector } from '../../inspector/llm-provider-inspector'
import { SkillInspector } from '../../inspector/skill-inspector'
import { ToolInspector } from '../../inspector/tool-inspector'
import type { WorkspaceSelection } from '../../canvas/workspace-canvas'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

import './index.css'

type RailTab = 'inspector' | 'activity'

export function RightRail({
  collapsed,
  tab,
  onTabChange,
  workspace,
  selection,
  onSelect,
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
  activityStreamId: string | null
  activityEvents: readonly RunEvent[]
  activityConnected: boolean
}) {
  const activityEventCount = activityEvents.filter(
    (e) => e.kind !== 'ping',
  ).length

  return (
    <aside
      className="right-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Inspector and activity"
    >
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
          renderInspector(workspace, selection, onSelect)
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
) {
  if (!selection) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-title">Nothing selected</div>
        <div className="rail-empty-hint">
          Click a node on the canvas to edit its configuration.
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

function NotFound({ kind }: { kind: string }) {
  return (
    <div className="rail-empty">
      <div className="rail-empty-title">Selected {kind} vanished</div>
      <div className="rail-empty-hint">
        It may have been deleted while you were looking at it.
      </div>
    </div>
  )
}
