import { useMemo } from 'react'
import type { AgentResponse } from '@agent-bridge/shared'

import type { WorkspaceSelection } from '../../canvas/workspace-canvas'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import type { AddResourceKind } from '../add-resource-panel'

import './index.css'

type TrayTab = 'skill' | 'tool' | 'repo' | 'llm' | 'mcp'

const TABS: readonly {
  id: TrayTab
  label: string
  addKind?: AddResourceKind
}[] = [
  { id: 'skill', label: 'Skills', addKind: 'skill' },
  { id: 'tool', label: 'Tools', addKind: 'tool' },
  { id: 'repo', label: 'Repos', addKind: 'repo' },
  { id: 'llm', label: 'LLM', addKind: 'llm' },
  { id: 'mcp', label: 'MCP' },
]

export function ResourceTray({
  agent,
  workspace,
  onAdd,
}: {
  readonly agent: AgentResponse
  readonly workspace: WorkspaceContextValue
  readonly onSelect?: (next: WorkspaceSelection) => void
  readonly onAdd: (kind: AddResourceKind) => void
}) {
  const counts = useMemo(
    () => buildTrayCounts(agent, workspace),
    [agent, workspace],
  )
  const total = TABS.reduce((sum, tab) => sum + counts[tab.id], 0)
  const attachableTabs = TABS.filter((tab) => tab.addKind)

  return (
    <aside className="resource-tray" aria-label="Attached resources">
      <header className="resource-tray-head">
        <div>
          <div className="resource-tray-eyebrow">Agent resources</div>
          <div className="resource-tray-title">
            {total === 0
              ? 'No resources attached'
              : `${total} resource${total === 1 ? '' : 's'} attached`}
          </div>
        </div>
        <div className="resource-tray-actions" aria-label="Attach resources">
          {attachableTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="resource-tray-action"
              onClick={() => tab.addKind && onAdd(tab.addKind)}
            >
              {tab.label === 'LLM'
                ? 'Set LLM'
                : `Attach ${singular(tab.label)}`}
            </button>
          ))}
        </div>
      </header>

      <div className="resource-tray-summary" aria-label="Resource counts">
        {TABS.map((tab) => (
          <span key={tab.id} className="resource-tray-summary-item">
            <span className={`resource-kind-dot resource-kind-dot-${tab.id}`} />
            <span>{tab.label}</span>
            <strong>{counts[tab.id]}</strong>
          </span>
        ))}
      </div>
    </aside>
  )
}

function singular(label: string): string {
  if (label === 'Repos') return 'repo'
  if (label.endsWith('s')) return label.slice(0, -1).toLowerCase()
  return label
}

function buildTrayCounts(
  agent: AgentResponse,
  workspace: WorkspaceContextValue,
): Record<TrayTab, number> {
  const res = workspace.agentResources[agent.id]

  const mcpById = new Map<string, { name: string; count: number }>()
  for (const entry of res?.mcpAllowlist ?? []) {
    if (!entry.enabled) continue
    const prev = mcpById.get(entry.mcpConnectionId)
    if (prev) prev.count += 1
    else {
      mcpById.set(entry.mcpConnectionId, {
        name: entry.mcpConnectionName,
        count: 1,
      })
    }
  }

  return {
    skill: res?.skills.length ?? 0,
    tool: res?.tools.length ?? 0,
    repo: res?.attachedRepos.length ?? 0,
    llm: agent.llmProviderId ? 1 : 0,
    mcp: mcpById.size,
  } satisfies Record<TrayTab, number>
}
