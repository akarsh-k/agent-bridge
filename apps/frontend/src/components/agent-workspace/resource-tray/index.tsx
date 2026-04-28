import { useMemo, useState } from 'react'
import type { AgentResponse } from '@agent-bridge/shared'

import type { AddResourceKind } from '../add-resource-panel'
import type { WorkspaceSelection } from '../../canvas/workspace-canvas'
import type { GroupKind } from '../../canvas/nodes/group-node'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import { shortRemote } from '../add-resource-panel/utils'
import { ResourceIcon } from '../add-resource-panel/resource-icons'
import {
  repoIconKind,
  type ResourceIconKind,
} from '../add-resource-panel/resource-icon-utils'

import './index.css'

type TrayKind = 'skill' | 'tool' | 'repo' | 'llm' | 'mcp'

interface TrayItem {
  readonly id: string
  readonly label: string
  readonly meta?: string
  readonly badge?: string
  readonly iconKind: ResourceIconKind
  readonly selection: WorkspaceSelection
}

interface TrayGroup {
  readonly kind: TrayKind
  readonly label: string
  readonly glyph: string
  readonly description: string
  readonly count: number
  readonly addKind?: AddResourceKind
  readonly items: readonly TrayItem[]
  readonly groupSelection?: WorkspaceSelection
}

const VISIBLE_ITEMS = 3

export function ResourceTray({
  agent,
  workspace,
  selection,
  onSelect,
  onAdd,
}: {
  readonly agent: AgentResponse
  readonly workspace: WorkspaceContextValue
  readonly selection: WorkspaceSelection
  readonly onSelect: (next: WorkspaceSelection) => void
  readonly onAdd: (kind: AddResourceKind) => void
}) {
  const groups = useMemo(
    () => buildGroups(agent, workspace),
    [agent, workspace],
  )
  const [openKind, setOpenKind] = useState<TrayKind | null>(null)
  const total = groups.reduce((sum, group) => sum + group.count, 0)

  const toggleGroup = (kind: TrayKind) => {
    setOpenKind((current) => (current === kind ? null : kind))
  }

  return (
    <aside className="resource-tray" aria-label="Attached resources">
      <header className="resource-tray-head">
        <div>
          <div className="resource-tray-eyebrow">Attached to</div>
          <div className="resource-tray-title">{agent.name}</div>
        </div>
        <div className="resource-tray-total">
          {total === 1 ? '1 item' : `${total} items`}
        </div>
      </header>

      <div className="resource-tray-groups">
        {groups.map((group) => {
          const isOpen = openKind === group.kind
          const panelId = `resource-tray-${group.kind}`
          return (
            <section
              key={group.kind}
              className={`resource-tray-group resource-tray-group-${group.kind}${
                isOpen ? ' is-open' : ''
              }`}
            >
              <div className="resource-tray-group-head">
                <button
                  type="button"
                  className="resource-tray-group-title"
                  onClick={() => toggleGroup(group.kind)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                >
                  <span className="resource-tray-kind-icon" aria-hidden="true">
                    {group.glyph}
                  </span>
                  <span className="resource-tray-group-copy">
                    <span className="resource-tray-group-label">
                      {group.label}
                    </span>
                    <span className="resource-tray-group-desc">
                      {group.description}
                    </span>
                  </span>
                  <strong>{group.count}</strong>
                  <span className="resource-tray-chevron" aria-hidden="true" />
                </button>

                {group.addKind ? (
                  <AddButton
                    addKind={group.addKind}
                    label={group.label}
                    onAdd={onAdd}
                  />
                ) : null}
              </div>

              {isOpen ? (
                <div id={panelId} className="resource-tray-panel">
                  {group.items.length === 0 ? (
                    <div className="resource-tray-empty">None attached</div>
                  ) : (
                    <div className="resource-tray-items">
                      {group.items.slice(0, VISIBLE_ITEMS).map((item) => {
                        const isSelected = isSameSelection(selection, item.selection)
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`resource-tray-item${
                              isSelected ? ' is-selected' : ''
                            }`}
                            onClick={() => onSelect(item.selection)}
                            aria-pressed={isSelected}
                          >
                            <ResourceIcon
                              kind={item.iconKind}
                              className="resource-tray-item-icon"
                            />
                            <span className="resource-tray-item-copy">
                              <span className="resource-tray-item-label">
                                {item.label}
                              </span>
                              {item.meta ? (
                                <span className="resource-tray-item-meta">
                                  {item.meta}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {group.groupSelection && group.count > VISIBLE_ITEMS ? (
                    <MoreButton
                      count={group.count - VISIBLE_ITEMS}
                      selection={group.groupSelection}
                      onSelect={onSelect}
                    />
                  ) : null}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

function isSameSelection(
  current: WorkspaceSelection,
  candidate: WorkspaceSelection,
): boolean {
  if (!current || !candidate) return false
  if (current.kind !== candidate.kind) return false

  switch (current.kind) {
    case 'agent':
      return candidate.kind === 'agent' && current.id === candidate.id
    case 'repo':
      return candidate.kind === 'repo' && current.id === candidate.id
    case 'mcp':
      return candidate.kind === 'mcp' && current.id === candidate.id
    case 'llm':
      return candidate.kind === 'llm' && current.id === candidate.id
    case 'group':
      return (
        candidate.kind === 'group' &&
        current.agentId === candidate.agentId &&
        current.groupKind === candidate.groupKind
      )
    case 'skill':
      return (
        candidate.kind === 'skill' &&
        current.id === candidate.id &&
        current.agentId === candidate.agentId
      )
    case 'tool':
      return (
        candidate.kind === 'tool' &&
        current.id === candidate.id &&
        current.agentId === candidate.agentId
      )
  }
}

function AddButton({
  addKind,
  label,
  onAdd,
}: {
  readonly addKind: AddResourceKind
  readonly label: string
  readonly onAdd: (kind: AddResourceKind) => void
}) {
  return (
    <button
      type="button"
      className="resource-tray-add"
      onClick={() => onAdd(addKind)}
      aria-label={`Attach ${label.toLowerCase()}`}
      title={`Attach ${label.toLowerCase()}`}
    >
      <span className="icon-plus" aria-hidden="true" />
    </button>
  )
}

function MoreButton({
  count,
  selection,
  onSelect,
}: {
  readonly count: number
  readonly selection: WorkspaceSelection
  readonly onSelect: (next: WorkspaceSelection) => void
}) {
  return (
    <button
      type="button"
      className="resource-tray-more"
      onClick={() => onSelect(selection)}
    >
      +{count} more
    </button>
  )
}

function buildGroups(
  agent: AgentResponse,
  workspace: WorkspaceContextValue,
): readonly TrayGroup[] {
  const resources = workspace.agentResources[agent.id]
  const groupSelection = (groupKind: GroupKind): WorkspaceSelection => ({
    kind: 'group',
    groupKind,
    agentId: agent.id,
  })

  const mcpById = new Map<string, { name: string; count: number }>()
  for (const entry of resources?.mcpAllowlist ?? []) {
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

  const llmProvider = agent.llmProviderId
    ? workspace.llmProviders.find(
        (provider) => provider.id === agent.llmProviderId,
      )
    : null

  return [
    {
      kind: 'llm',
      label: 'LLM',
      glyph: '◎',
      description: 'Model provider',
      count: llmProvider ? 1 : 0,
      addKind: 'llm',
      items: llmProvider
        ? [
            {
              id: llmProvider.id,
              label: llmProvider.label,
              meta: llmProvider.defaultModel ?? llmProvider.kind,
              badge: llmProvider.kind,
              iconKind: 'llm',
              selection: { kind: 'llm', id: llmProvider.id },
            },
          ]
        : [],
      groupSelection: groupSelection('llm'),
    },
    {
      kind: 'repo',
      label: 'Repos',
      glyph: '❯',
      description: 'Source context',
      count: resources?.attachedRepos.length ?? 0,
      addKind: 'repo',
      items: (resources?.attachedRepos ?? []).map((attached) => ({
        id: attached.repo.id,
        label: compactRepoLabel(attached.repo.remoteUrl),
        meta: attached.role
          ? `${attached.repo.branch} · ${attached.role}`
          : attached.repo.branch,
        badge: attached.repo.status,
        iconKind: repoIconKind(attached.repo.remoteUrl),
        selection: { kind: 'repo', id: attached.repo.id },
      })),
      groupSelection: groupSelection('repo'),
    },
    {
      kind: 'skill',
      label: 'Skills',
      glyph: '✺',
      description: 'Prompt behavior',
      count: resources?.skills.length ?? 0,
      addKind: 'skill',
      items: (resources?.skills ?? []).map((skill) => ({
        id: skill.id,
        label: skill.name,
        meta: 'Prompt instruction',
        badge: 'skill',
        iconKind: 'skill',
        selection: { kind: 'skill', id: skill.id, agentId: agent.id },
      })),
      groupSelection: groupSelection('skill'),
    },
    {
      kind: 'tool',
      label: 'Tools',
      glyph: '⚙',
      description: 'Callable actions',
      count: resources?.tools.length ?? 0,
      addKind: 'tool',
      items: (resources?.tools ?? []).map((tool) => ({
        id: tool.id,
        label: tool.name,
        meta: tool.kind,
        badge: 'callable',
        iconKind: tool.kind,
        selection: { kind: 'tool', id: tool.id, agentId: agent.id },
      })),
      groupSelection: groupSelection('tool'),
    },
    {
      kind: 'mcp',
      label: 'MCP',
      glyph: '⬡',
      description: 'External tools',
      count: mcpById.size,
      addKind: 'mcp',
      items: [...mcpById.entries()].map(([id, info]) => ({
        id,
        label: info.name,
        meta:
          info.count === 1 ? '1 enabled tool' : `${info.count} enabled tools`,
        badge: 'mcp',
        iconKind: 'mcp',
        selection: { kind: 'mcp', id },
      })),
      groupSelection: groupSelection('mcp'),
    },
  ]
}

function compactRepoLabel(remoteUrl: string): string {
  return shortRemote(remoteUrl)
    .replace(/^github\.com\//i, '')
    .replace(/^www\.github\.com\//i, '')
}
