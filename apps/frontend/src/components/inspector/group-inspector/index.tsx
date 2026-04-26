/**
 * Group inspector — rendered when the user clicks a group card's chrome
 * (i.e. not on a pill). Shows a short summary plus a list of items with
 * click-through into the individual resource inspector.
 *
 * Kept deliberately small: CRUD on individual items happens in their
 * own inspector panels (reached by clicking a pill), and adding new
 * items happens via the agent's hover-triggered quick-add popover.
 */

import type {
  AgentResponse,
  AttachedRepoResponse,
  LlmProviderResponse,
  McpConnectionResponse,
  RepoResponse,
  SkillResponse,
  ToolResponse,
} from '@agent-bridge/shared'
import type { WorkspaceSelection } from '../../canvas/workspace-canvas'
import type {
  GroupKind,
} from '../../canvas/nodes/group-node'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

import './index.css'

interface ListEntry {
  id: string
  label: string
  sublabel?: string
  onSelect: WorkspaceSelection
}

const KIND_COPY: Record<GroupKind, { title: string; empty: string }> = {
  skill: {
    title: 'Skills',
    empty: 'No skills yet. Use the + button on the agent card to add one.',
  },
  tool: {
    title: 'Tools',
    empty: 'No tools yet. Use the + button on the agent card to add one.',
  },
  repo: {
    title: 'Repositories',
    empty: 'No repositories attached. Use the + button on the agent card.',
  },
  mcp: {
    title: 'MCP connections',
    empty: 'No MCP tools enabled for this agent.',
  },
  llm: {
    title: 'LLM provider',
    empty: 'No LLM assigned. Use the + button on the agent card.',
  },
}

export function GroupInspector({
  groupKind,
  agent,
  workspace,
  onSelect,
}: {
  groupKind: GroupKind
  agent: AgentResponse
  workspace: WorkspaceContextValue
  onSelect: (next: WorkspaceSelection) => void
}) {
  const entries = collectEntries(groupKind, agent, workspace)
  const copy = KIND_COPY[groupKind]

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>{copy.title}</span>
          {entries.length > 0 ? (
            <span className="badge">{entries.length}</span>
          ) : null}
        </div>

        <div className="read-row">
          <span className="read-label">Agent</span>
          <span className="read-value">
            {agent.name} <code>{agent.slug}</code>
          </span>
        </div>

        {entries.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>
            {copy.empty}
          </p>
        ) : (
          <ul className="inspector-list">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="inspector-list-item"
                  onClick={() => onSelect(e.onSelect)}
                  title={e.sublabel ? `${e.label} — ${e.sublabel}` : e.label}
                >
                  <span className="inspector-list-label">{e.label}</span>
                  {e.sublabel ? (
                    <span className="inspector-list-sub">{e.sublabel}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
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

function collectEntries(
  groupKind: GroupKind,
  agent: AgentResponse,
  workspace: WorkspaceContextValue,
): ListEntry[] {
  const res = workspace.agentResources[agent.id]
  if (!res) return []

  switch (groupKind) {
    case 'skill':
      return res.skills.map(
        (s: SkillResponse): ListEntry => ({
          id: s.id,
          label: s.name,
          onSelect: { kind: 'skill', id: s.id, agentId: agent.id },
        }),
      )
    case 'tool':
      return res.tools.map(
        (t: ToolResponse): ListEntry => ({
          id: t.id,
          label: t.name,
          sublabel: t.kind,
          onSelect: { kind: 'tool', id: t.id, agentId: agent.id },
        }),
      )
    case 'repo':
      return res.attachedRepos.map(
        (att: AttachedRepoResponse): ListEntry => {
          const r: RepoResponse = att.repo
          return {
            id: r.id,
            label: shortRemote(r.remoteUrl),
            sublabel: att.role?.trim() ? att.role : r.branch,
            onSelect: { kind: 'repo', id: r.id },
          }
        },
      )
    case 'mcp': {
      // One entry per distinct mcpConnection, not per allowlist row.
      const seen = new Map<string, { enabled: number; name: string }>()
      for (const e of res.mcpAllowlist) {
        if (!e.enabled) continue
        const prev = seen.get(e.mcpConnectionId)
        if (prev) {
          prev.enabled += 1
        } else {
          seen.set(e.mcpConnectionId, {
            enabled: 1,
            name: e.mcpConnectionName,
          })
        }
      }
      return [...seen.entries()].map(
        ([id, info]): ListEntry => {
          const conn = workspace.mcpConnections.find(
            (c: McpConnectionResponse) => c.id === id,
          )
          return {
            id,
            label: conn?.name ?? info.name,
            sublabel: info.enabled === 1 ? '1 tool' : `${info.enabled} tools`,
            onSelect: { kind: 'mcp', id },
          }
        },
      )
    }
    case 'llm': {
      if (!agent.llmProviderId) return []
      const prov = workspace.llmProviders.find(
        (p: LlmProviderResponse) => p.id === agent.llmProviderId,
      )
      if (!prov) return []
      return [
        {
          id: prov.id,
          label: prov.label,
          sublabel: prov.kind,
          onSelect: { kind: 'llm', id: prov.id },
        },
      ]
    }
  }
}
