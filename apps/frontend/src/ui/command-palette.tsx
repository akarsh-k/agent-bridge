/**
 * Cmd-K command palette. Global keyboard shortcut + sidebar
 * button open it. Three groups: agents, library entries, quick
 * actions. Fuzzy substring search; arrow keys + Enter run the item.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../lib/workspace-context'
import { navigate } from '../lib/router'
import {
  closePalette,
  subscribePaletteState,
} from './command-palette-store'
import type { SVGProps } from 'react'
import { matchAgentDetail } from '../lib/router'
import {
  AgentsIcon,
  BridgeIcon,
  HomeIcon,
  McpIcon,
  PlayIcon,
  ProvidersIcon,
  ReposIcon,
  SearchIcon,
  SettingsIcon,
} from './icons'

interface PaletteItem {
  id: string
  group: string
  label: string
  hint?: string
  Icon: React.ComponentType<SVGProps<SVGSVGElement>>
  run: () => void
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => subscribePaletteState(setOpen), [])
  if (!open) return null
  return <Inner onClose={() => closePalette()} />
}

function Inner({ onClose }: { onClose: () => void }) {
  const { agents, llmProviders, repos, mcpConnections } = useWorkspace()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Detect agent-scope so we can surface tab-jumps relative to it.
  const path =
    typeof window === 'undefined' ? '/' : window.location.pathname
  const agentDetail = matchAgentDetail(path)
  const scopedAgent = agentDetail
    ? agents.find((a) => a.id === agentDetail.id)
    : null

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = []

    // When the user opens ⌘K from an agent detail, lead with that
    // agent's own actions — they're almost certainly what's wanted.
    if (scopedAgent) {
      out.push(
        {
          id: 'agent-configure',
          group: `On ${scopedAgent.name}`,
          label: 'Open Configure tab',
          hint: 'identity, prompt, model, memory',
          Icon: AgentsIcon,
          run: () => navigate(`/agents/${scopedAgent.id}`),
        },
        {
          id: 'agent-resources',
          group: `On ${scopedAgent.name}`,
          label: 'Open Resources tab',
          hint: 'repos, MCPs, skills, tools',
          Icon: AgentsIcon,
          run: () => navigate(`/agents/${scopedAgent.id}/resources`),
        },
        {
          id: 'agent-chat',
          group: `On ${scopedAgent.name}`,
          label: 'Open Chat',
          hint: 'test prompt',
          Icon: PlayIcon,
          run: () => navigate(`/agents/${scopedAgent.id}/chat`),
        },
        {
          id: 'agent-logs',
          group: `On ${scopedAgent.name}`,
          label: 'Open Logs',
          hint: 'live activity',
          Icon: BridgeIcon,
          run: () => navigate(`/agents/${scopedAgent.id}/logs`),
        },
        {
          id: 'agent-bridge',
          group: `On ${scopedAgent.name}`,
          label: 'Open in IDE bridge',
          hint: scopedAgent.slug,
          Icon: BridgeIcon,
          run: () => navigate(`/bridge#${scopedAgent.slug}`),
        },
      )
    }

    out.push(
      {
        id: 'go-home',
        group: 'Go to',
        label: 'Home',
        Icon: HomeIcon,
        run: () => navigate('/'),
      },
      {
        id: 'go-agents',
        group: 'Go to',
        label: 'Agents',
        Icon: AgentsIcon,
        run: () => navigate('/agents'),
      },
      {
        id: 'go-bridge',
        group: 'Go to',
        label: 'Bridge',
        Icon: BridgeIcon,
        run: () => navigate('/bridge'),
      },
      {
        id: 'go-providers',
        group: 'Go to',
        label: 'Library / Providers',
        Icon: ProvidersIcon,
        run: () => navigate('/library/providers'),
      },
      {
        id: 'go-repos',
        group: 'Go to',
        label: 'Library / Repositories',
        Icon: ReposIcon,
        run: () => navigate('/library/repos'),
      },
      {
        id: 'go-mcp',
        group: 'Go to',
        label: 'Library / MCP connections',
        Icon: McpIcon,
        run: () => navigate('/library/mcp'),
      },
      {
        id: 'go-settings',
        group: 'Go to',
        label: 'Settings',
        Icon: SettingsIcon,
        run: () => navigate('/settings'),
      },
    )
    for (const a of agents) {
      out.push({
        id: `agent:${a.id}`,
        group: 'Agents',
        label: a.name,
        hint: a.slug,
        Icon: AgentsIcon,
        run: () => navigate(`/agents/${a.id}`),
      })
    }
    for (const p of llmProviders) {
      out.push({
        id: `prov:${p.id}`,
        group: 'LLM providers',
        label: p.label,
        hint: p.kind,
        Icon: ProvidersIcon,
        run: () => navigate(`/library/providers/${p.id}`),
      })
    }
    for (const r of repos) {
      out.push({
        id: `repo:${r.id}`,
        group: 'Repositories',
        label: shortRepoName(r.remoteUrl),
        hint: r.branch,
        Icon: ReposIcon,
        run: () => navigate(`/library/repos/${r.id}`),
      })
    }
    for (const m of mcpConnections) {
      out.push({
        id: `mcp:${m.id}`,
        group: 'MCP connections',
        label: m.name,
        hint: m.transport,
        Icon: McpIcon,
        run: () => navigate(`/library/mcp/${m.id}`),
      })
    }
    return out
  }, [agents, llmProviders, repos, mcpConnections, scopedAgent])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      q
        ? items.filter(
            (it) =>
              it.label.toLowerCase().includes(q) ||
              (it.hint?.toLowerCase().includes(q) ?? false),
          )
        : items,
    [items, q],
  )

  // Reset highlight when filter changes — derived state pattern.
  const [filterKey, setFilterKey] = useState('')
  if (filterKey !== q) {
    setFilterKey(q)
    setActive(0)
  }

  // Surface the section that matches the current page first — when
  // on `/library/repos` the user almost certainly wants to jump to a
  // repository, not an agent. The `On {agent}` group is already
  // pinned at the top via insertion order; this reorders the rest.
  const priorityGroup = useMemo<string | null>(() => {
    if (path.startsWith('/agents/')) return null // handled by "On {agent}"
    if (path === '/agents' || path.startsWith('/agents'))
      return 'Agents'
    if (path.startsWith('/library/providers')) return 'LLM providers'
    if (path.startsWith('/library/repos')) return 'Repositories'
    if (path.startsWith('/library/mcp')) return 'MCP connections'
    return null
  }, [path])

  // Group by `group`, preserving insertion order, then float the
  // current page's group to the top (after `On {agent}` if present).
  const groups = useMemo(() => {
    const m = new Map<string, PaletteItem[]>()
    for (const it of filtered) {
      const g = m.get(it.group) ?? []
      g.push(it)
      m.set(it.group, g)
    }
    const entries = [...m.entries()]
    if (!priorityGroup) return entries
    return entries.sort(([a], [b]) => {
      if (a === b) return 0
      // Keep "On {agent}" pinned at the very top if it exists.
      if (a.startsWith('On ')) return -1
      if (b.startsWith('On ')) return 1
      if (a === priorityGroup) return -1
      if (b === priorityGroup) return 1
      return 0
    })
  }, [filtered, priorityGroup])

  // Flat index used for keyboard nav. Recompute from the (possibly
  // reordered) groups so arrow keys traverse in the visible order.
  const flatList = useMemo(() => groups.flatMap(([, list]) => list), [groups])

  const run = (it: PaletteItem) => {
    onClose()
    it.run()
  }

  return (
    <>
      <div
        className="ab-sheet-backdrop is-open"
        onClick={onClose}
        style={{ zIndex: 110 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          position: 'fixed',
          top: '12vh',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(560px, calc(100vw - 32px))',
          maxHeight: '70vh',
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          zIndex: 111,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'ab-popover-in 200ms var(--ease-out)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <SearchIcon
            width={16}
            height={16}
            style={{ color: 'var(--text-muted)', flexShrink: 0 }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to anything…"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 14,
              font: 'inherit',
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) =>
                  flatList.length === 0
                    ? 0
                    : (i + 1) % flatList.length,
                )
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) =>
                  flatList.length === 0
                    ? 0
                    : (i - 1 + flatList.length) % flatList.length,
                )
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const it = flatList[active]
                if (it) run(it)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
          <span className="ab-kbd">esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 4 }}>
          {flatList.length === 0 ? (
            <div
              className="ab-section-sub"
              style={{ padding: '24px 16px', textAlign: 'center' }}
            >
              No matches.
            </div>
          ) : (
            groups.map(([group, list]) => (
              <div key={group}>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    padding: '10px 12px 4px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {group}
                </div>
                {list.map((it) => {
                  const flatIdx = flatList.indexOf(it)
                  const isActive = flatIdx === active
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => run(it)}
                      onMouseEnter={() => setActive(flatIdx)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 7,
                        border: 'none',
                        background: isActive
                          ? 'var(--accent-bg)'
                          : 'transparent',
                        color: 'var(--text)',
                        fontSize: 13,
                        cursor: 'pointer',
                        textAlign: 'left',
                        font: 'inherit',
                      }}
                    >
                      <it.Icon
                        width={14}
                        height={14}
                        style={{
                          color: 'var(--text-dim)',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1 }}>{it.label}</span>
                      {it.hint && (
                        <span
                          className="ab-mono"
                          style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                          }}
                        >
                          {it.hint}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}
