/**
 * Sectioned text-labelled sidebar. Reads the current path from the
 * router and marks the active section. Counts come from the
 * workspace context.
 */

import { Link } from '../../lib/link'
import { usePathname } from '../../lib/router'
import { useWorkspace } from '../../lib/workspace-context'
import {
  AgentsIcon,
  BridgeIcon,
  HomeIcon,
  LogsIcon,
  McpIcon,
  ProvidersIcon,
  ReposIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
} from '../../ui/icons'
import { useTheme } from '../../lib/theme'
import { openPalette } from '../../ui/command-palette-store'
import { Tooltip } from '../../ui/tooltip'
import { useSidebarState } from '../../lib/use-sidebar-state'

interface NavSpec {
  to: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
  matchPrefix?: string
  count?: number
}

export function Sidebar() {
  const path = usePathname()
  const { agents, llmProviders, repos, mcpConnections } = useWorkspace()
  const { theme, setTheme } = useTheme()

  const navigate: NavSpec[] = [
    { to: '/', label: 'Home', Icon: HomeIcon },
    {
      to: '/agents',
      label: 'Agents',
      Icon: AgentsIcon,
      matchPrefix: '/agents',
      count: agents.length,
    },
    { to: '/bridge', label: 'Bridge', Icon: BridgeIcon, matchPrefix: '/bridge' },
    { to: '/logs', label: 'Logs', Icon: LogsIcon, matchPrefix: '/logs' },
  ]

  const library: NavSpec[] = [
    {
      to: '/library/providers',
      label: 'LLM providers',
      Icon: ProvidersIcon,
      matchPrefix: '/library/providers',
      count: llmProviders.length,
    },
    {
      to: '/library/repos',
      label: 'Repositories',
      Icon: ReposIcon,
      matchPrefix: '/library/repos',
      count: repos.length,
    },
    {
      to: '/library/mcp',
      label: 'MCP connections',
      Icon: McpIcon,
      matchPrefix: '/library/mcp',
      count: mcpConnections.length,
    },
  ]

  const system: NavSpec[] = [
    {
      to: '/settings',
      label: 'Settings',
      Icon: SettingsIcon,
      matchPrefix: '/settings',
    },
  ]

  const isActive = (spec: NavSpec) => {
    if (spec.to === '/') return path === '/'
    return path === spec.to || (spec.matchPrefix && path.startsWith(spec.matchPrefix + '/'))
      ? true
      : path === spec.to
  }

  const renderSection = (label: string, items: NavSpec[]) => (
    <nav className="ab-nav-section">
      <div className="ab-nav-label">{label}</div>
      {items.map((item) => {
        const active = isActive(item)
        return (
          <Tooltip key={item.to} label={item.label}>
            <Link
              to={item.to}
              className="ab-nav-link"
              aria-current={active ? 'page' : undefined}
            >
              <item.Icon />
              <span>{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="ab-nav-count">{item.count}</span>
              )}
            </Link>
          </Tooltip>
        )
      })}
    </nav>
  )

  const cycleTheme = () => {
    if (theme === 'system') setTheme('light')
    else if (theme === 'light') setTheme('dark')
    else setTheme('system')
  }

  const ThemeIcon = theme === 'light' ? SunIcon : MoonIcon

  const { override, toggle } = useSidebarState()
  // Source-of-truth for the icon: the override OR the responsive
  // collapse rule. We read the active state by querying the parent
  // grid via a CSS pseudo. Simpler: just flip on the override.
  const collapsedHint =
    override === 'collapsed'
      ? 'Expand sidebar'
      : override === 'expanded'
        ? 'Collapse sidebar'
        : 'Collapse sidebar'

  return (
    <aside className="ab-sidebar">
      <div className="ab-brand">
        <div className="ab-brand-mark">A</div>
        <div className="ab-brand-text">
          <div className="ab-brand-name">Agent Bridge</div>
          <div className="ab-brand-org">your workspace</div>
        </div>
      </div>

      {renderSection('Navigate', navigate)}
      {renderSection('Library', library)}
      {renderSection('System', system)}

      <div className="ab-sidebar-footer">
        <Tooltip label="Search (⌘K)">
          <button
            className="ab-cmdk"
            type="button"
            onClick={() => openPalette()}
          >
            <SearchIcon />
            <span>Search</span>
            <span className="ab-kbd">⌘K</span>
          </button>
        </Tooltip>
        <Tooltip label={`Theme: ${theme}`}>
          <button
            className="ab-icon-btn"
            type="button"
            onClick={cycleTheme}
            aria-label="Toggle theme"
          >
            <ThemeIcon />
          </button>
        </Tooltip>
        <Tooltip label={collapsedHint}>
          <button
            className="ab-icon-btn"
            type="button"
            onClick={toggle}
            aria-label={collapsedHint}
          >
            <svg
              viewBox="0 0 24 24"
              width={16}
              height={16}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{
                transition: 'transform 160ms var(--ease-out)',
                transform:
                  override === 'collapsed'
                    ? 'rotate(180deg)'
                    : 'rotate(0deg)',
              }}
            >
              <path d="M11 17l-5-5 5-5" />
              <path d="M17 17V7" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </aside>
  )
}
