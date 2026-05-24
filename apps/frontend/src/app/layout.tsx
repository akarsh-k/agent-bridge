/**
 * Root layout for the rewritten shell. Owns sidebar + topbar +
 * route dispatch. Uses the existing custom router (path-only). The
 * old Railway-canvas App.tsx is no longer mounted; this shell is
 * the app.
 */

import { useMemo } from 'react'
import { WorkspaceProvider } from '../lib/workspace-provider'
import { useWorkspace } from '../lib/workspace-context'
import {
  matchAgentDetail,
  matchAgentsList,
  matchBridge,
  matchHome,
  matchLibraryDetail,
  matchLibraryFiles,
  matchLibraryMcp,
  matchLibraryProviders,
  matchLibraryRepos,
  matchLogs,
  matchOAuthCallback,
  matchSettings,
  navigate,
  usePathname,
} from '../lib/router'
import { Sidebar } from './_chrome/sidebar'
import { Topbar, type Crumb } from './_chrome/topbar'
import { ToastHost } from '../ui/toast'
import { DialogHost } from '../ui/dialog'
import { NavGuardModal } from '../ui/nav-guard-modal'
import { CommandPalette } from '../ui/command-palette'
import { openPalette } from '../ui/command-palette-store'
import { KeyboardHelp } from '../ui/keyboard-help'
import { useEffect } from 'react'
import { useSidebarState } from '../lib/use-sidebar-state'

import { HomePage } from './home/page'
import { AgentsListPage } from './agents/page'
import { AgentDetailPage } from './agents/[id]/page'
import { ProvidersPage } from './library/providers/page'
import { ProviderDetailPage } from './library/providers/[id]/page'
import { ReposPage } from './library/repos/page'
import { RepoDetailPage } from './library/repos/[id]/page'
import { FilesPage } from './library/files/page'
import { McpPage } from './library/mcp/page'
import { McpDetailPage } from './library/mcp/[id]/page'
import { BridgePage } from './bridge/page'
import { LogsPage } from './logs/page'
import { SettingsPage } from './settings/page'
import { OAuthCallbackPage } from './oauth/callback/page'

function RouterOutlet() {
  const path = usePathname()
  const { agents, status } = useWorkspace()

  const route = useMemo(() => {
    if (matchHome(path)) return { kind: 'home' as const }
    if (matchAgentsList(path)) return { kind: 'agents' as const }
    const ad = matchAgentDetail(path)
    if (ad) {
      // `/agents/:id/test` is kept as a backwards-compat alias for
      // `/agents/:id/chat` (the route was renamed when the chat tab
      // was renamed from "Test" earlier in the rewrite).
      const t = ad.tab === 'test' ? 'chat' : ad.tab
      return {
        kind: 'agent-detail' as const,
        id: ad.id,
        tab: t,
        threadId: ad.threadId,
      }
    }
    const ld = matchLibraryDetail(path)
    if (ld) return { kind: 'library-detail' as const, ...ld }
    if (matchLibraryProviders(path)) return { kind: 'providers' as const }
    if (matchLibraryRepos(path)) return { kind: 'repos' as const }
    if (matchLibraryFiles(path)) return { kind: 'files' as const }
    if (matchLibraryMcp(path)) return { kind: 'mcp' as const }
    if (matchBridge(path)) return { kind: 'bridge' as const }
    if (matchLogs(path)) return { kind: 'logs' as const }
    if (matchSettings(path)) return { kind: 'settings' as const }
    return { kind: 'not-found' as const }
  }, [path])

  const crumbs: Crumb[] = useMemo(() => {
    switch (route.kind) {
      case 'home':
        return [{ label: 'Home' }]
      case 'agents':
        return [{ label: 'Workspace', to: '/' }, { label: 'Agents' }]
      case 'agent-detail': {
        const agent = agents.find((a) => a.id === route.id)
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Agents', to: '/agents' },
          { label: agent?.name ?? 'Agent' },
        ]
      }
      case 'providers':
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Library' },
          { label: 'LLM providers' },
        ]
      case 'repos':
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Library' },
          { label: 'Repositories' },
        ]
      case 'files':
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Library' },
          { label: 'Files' },
        ]
      case 'mcp':
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Library' },
          { label: 'MCP connections' },
        ]
      case 'library-detail': {
        const sectionLabel =
          route.section === 'providers'
            ? 'LLM providers'
            : route.section === 'repos'
              ? 'Repositories'
              : 'MCP connections'
        const sectionPath = `/library/${route.section}`
        return [
          { label: 'Workspace', to: '/' },
          { label: 'Library' },
          { label: sectionLabel, to: sectionPath },
          { label: '…' },
        ]
      }
      case 'bridge':
        return [{ label: 'Workspace', to: '/' }, { label: 'Bridge' }]
      case 'logs':
        return [{ label: 'Workspace', to: '/' }, { label: 'Logs' }]
      case 'settings':
        return [{ label: 'Workspace', to: '/' }, { label: 'Settings' }]
      default:
        return [{ label: 'Not found' }]
    }
  }, [route, agents])

  if (status === 'loading') {
    return (
      <>
        <Topbar crumbs={[{ label: 'Loading…' }]} />
        <div className="ab-page">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--text-dim)',
            }}
          >
            <span className="ab-pulse-dot" />
            Loading workspace…
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Topbar crumbs={crumbs} />
      {route.kind === 'home' && <HomePage />}
      {route.kind === 'agents' && <AgentsListPage />}
      {route.kind === 'agent-detail' && (
        <AgentDetailPage
          id={route.id}
          initialTab={route.tab}
          initialThreadId={route.threadId}
        />
      )}
      {route.kind === 'providers' && <ProvidersPage />}
      {route.kind === 'repos' && <ReposPage />}
      {route.kind === 'files' && <FilesPage />}
      {route.kind === 'mcp' && <McpPage />}
      {route.kind === 'library-detail' && route.section === 'providers' && (
        <ProviderDetailPage id={route.id} />
      )}
      {route.kind === 'library-detail' && route.section === 'repos' && (
        <RepoDetailPage id={route.id} />
      )}
      {route.kind === 'library-detail' && route.section === 'mcp' && (
        <McpDetailPage id={route.id} />
      )}
      {route.kind === 'bridge' && <BridgePage />}
      {route.kind === 'logs' && <LogsPage />}
      {route.kind === 'settings' && <SettingsPage />}
      {route.kind === 'not-found' && (
        <div className="ab-page">
          <div className="ab-card ab-card-pad">
            <div className="ab-section-title">Page not found</div>
            <div className="ab-section-sub" style={{ marginTop: 4 }}>
              <code className="ab-mono">{path}</code> doesn't match any route.
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="ab-btn ab-btn-secondary"
                onClick={() => navigate('/')}
              >
                Go home
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function GlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openPalette()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return null
}

export function AppLayout() {
  // OAuth callback runs inside a popup and shouldn't paint the main
  // shell — short-circuit before the WorkspaceProvider too, which
  // would otherwise try to fetch + render the sidebar in a 480 px
  // window for half a second before this closes itself.
  const path = usePathname()
  if (matchOAuthCallback(path)) {
    return <OAuthCallbackPage />
  }
  return (
    <WorkspaceProvider>
      <GlobalShortcuts />
      <AppGrid />
      <ToastHost />
      <DialogHost />
      <NavGuardModal />
      <CommandPalette />
      <KeyboardHelp />
    </WorkspaceProvider>
  )
}

function AppGrid() {
  const { override } = useSidebarState()
  return (
    <div
      className="ab-app"
      data-sidebar={override ?? undefined}
    >
      <Sidebar />
      <main className="ab-main">
        <RouterOutlet />
      </main>
    </div>
  )
}
