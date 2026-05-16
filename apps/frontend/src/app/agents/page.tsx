/**
 * Agents list — resource-list pattern. Page header + stat grid +
 * filter bar + grid of agent cards. The most-recently-touched
 * agent renders as the Featured variant.
 */

import { useMemo, useRef, useState } from 'react'
import {
  agentExportBundleSchema,
  type AgentResponse,
} from '@agent-bridge/shared'
import { Link } from '../../lib/link'
import { useWorkspace } from '../../lib/workspace-context'
import { PageHeader } from '../_chrome/page-header'
import { Button } from '../../ui/button'
import { BridgeRow } from '../../ui/bridge-row'
import { ImportIcon, PlusIcon, SearchIcon } from '../../ui/icons'
import { EmptyState } from '../../ui/empty'
import { RowMenu } from '../../ui/row-menu'
import { ContextMenu } from '../../ui/context-menu'
import { confirmDialog } from '../../ui/dialog-store'
import { ApiError, exportAgentBundle, importAgentBundle } from '../../lib/rpc'
import { agentGlyphKind, deriveAgentBridges } from '../../lib/agent-helpers'
import { CreateAgentSheet } from '../../features/agent-builder/create-agent-sheet'
import { toast } from '../../ui/toast-store'
import { navigate } from '../../lib/router'

type Filter = 'all' | 'active' | 'draft' | 'archived'

const filters: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
]

function isDraft(a: AgentResponse): boolean {
  return !a.systemPrompt || a.systemPrompt.trim().length === 0
}

export function AgentsListPage() {
  const { agents, refresh, removeAgent } = useWorkspace()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleImport = async (file: File) => {
    setImporting(true)
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const parsed = agentExportBundleSchema.safeParse(json)
      if (!parsed.success) {
        toast.error("That doesn't look like an agent bundle.")
        return
      }
      const res = await importAgentBundle({ bundle: parsed.data })
      refresh()
      toast.success(`Imported · ${parsed.data.agent.slug}`)
      navigate(`/agents/${res.agentId}`)
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Import failed',
      )
    } finally {
      setImporting(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents
      .filter((a) => {
        if (filter === 'active' && isDraft(a)) return false
        if (filter === 'draft' && !isDraft(a)) return false
        if (filter === 'archived') return false
        return true
      })
      .filter((a) => {
        if (!q) return true
        return (
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q)
        )
      })
  }, [agents, filter, query])

  const sorted = useMemo(
    () =>
      [...filtered].sort(
        (a, b) =>
          new Date(b.updatedAt ?? 0).getTime() -
          new Date(a.updatedAt ?? 0).getTime(),
      ),
    [filtered],
  )

  const featuredId = sorted[0]?.id

  return (
    <div className="ab-page">
      <PageHeader
        title="Agents"
        subtitle="Custom assistants that show up as callable tools in your IDE. Each one bundles a system prompt, model, repos, and MCP connections."
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImport(f)
                e.target.value = ''
              }}
            />
            <Button
              variant="secondary"
              leading={<ImportIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? 'Importing…' : 'Import'}
            </Button>
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setSheetOpen(true)}
            >
              New agent
            </Button>
          </>
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          glyph={<PlusIcon />}
          title="You don't have any agents yet."
          body="An agent is a system prompt plus the tools and repos it can reach. Wire one up here and it becomes a callable tool in your IDE."
          action={
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setSheetOpen(true)}
            >
              Create your first agent
            </Button>
          }
        />
      ) : (
        <>
          <div className="ab-filter-bar">
            <div className="ab-search">
              <SearchIcon />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents…"
              />
            </div>
            <div className="ab-filter-chips">
              {filters.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={
                    'ab-chip' + (filter === f.value ? ' is-active' : '')
                  }
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {sorted.length === 0 ? (
            <EmptyState
              glyph={<SearchIcon />}
              title="No agents match those filters"
              body="Try another search or clear the filter chips."
            />
          ) : (
            <div className="ab-grid-cards">
              {sorted.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  featured={a.id === featuredId}
                  onConnectBridge={() => navigate(`/bridge#${a.slug}`)}
                  onExport={async () => {
                    try {
                      const bundle = await exportAgentBundle(a.id)
                      const blob = new Blob(
                        [JSON.stringify(bundle, null, 2)],
                        { type: 'application/json' },
                      )
                      const url = URL.createObjectURL(blob)
                      const link = document.createElement('a')
                      link.href = url
                      link.download = `${a.slug}.json`
                      document.body.appendChild(link)
                      link.click()
                      document.body.removeChild(link)
                      setTimeout(() => URL.revokeObjectURL(url), 0)
                      toast.success('Bundle exported')
                    } catch (err) {
                      toast.error(
                        err instanceof ApiError
                          ? err.message
                          : err instanceof Error
                            ? err.message
                            : 'Export failed',
                      )
                    }
                  }}
                  onDelete={async () => {
                    if (
                      !(await confirmDialog({
                        title: `Delete agent “${a.name}”?`,
                        body: 'All chat history, skills, and bridge tools tied to this agent are removed. This cannot be undone.',
                        confirmLabel: 'Delete agent',
                        destructive: true,
                      }))
                    ) {
                      return
                    }
                    try {
                      await removeAgent(a.id)
                      toast.success('Agent deleted')
                    } catch (err) {
                      toast.error(
                        err instanceof ApiError
                          ? err.message
                          : err instanceof Error
                            ? err.message
                            : 'Delete failed',
                      )
                    }
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      <CreateAgentSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  )
}

function AgentCard({
  agent,
  featured,
  onConnectBridge,
  onExport,
  onDelete,
}: {
  agent: AgentResponse
  featured: boolean
  onConnectBridge: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const draft = isDraft(agent)
  const bridges = deriveAgentBridges(agent.id)
  const ctxItems = [
    { label: 'Open agent', onClick: () => navigate(`/agents/${agent.id}`) },
    { label: 'Export bundle', onClick: onExport },
    {
      label: 'Delete agent',
      destructive: true,
      onClick: onDelete,
    },
  ]
  return (
    <ContextMenu items={ctxItems}>
      <Link
        to={`/agents/${agent.id}`}
        className={
          'ab-card ab-card-link ab-card-pad' +
          (featured ? ' ab-card-featured' : '')
        }
      >
        {featured && (
          <div className="ab-agent-state ab-agent-state-recent">
            <span className="ab-agent-state-dot" aria-hidden="true" />
            Most recent
          </div>
        )}
        {!featured && draft && (
          <div className="ab-agent-state ab-agent-state-draft">
            <span className="ab-agent-state-dot" aria-hidden="true" />
            Draft
          </div>
        )}
        <div className="ab-agent-head">
          <div className={`ab-glyph ab-glyph-${agentGlyphKind(agent.id)}`}>
            {(agent.name ?? 'A').charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ab-agent-name">{agent.name}</div>
            <div className="ab-agent-slug">{agent.slug}</div>
          </div>
          <RowMenu
            items={[
              { label: 'Export bundle', onClick: onExport },
              {
                label: 'Delete agent',
                destructive: true,
                onClick: onDelete,
              },
            ]}
          />
        </div>
        <div className="ab-agent-body">
          {agent.description?.trim() || (
            <span style={{ color: 'var(--text-muted)' }}>
              No description yet.
            </span>
          )}
        </div>
        <BridgeRow ides={bridges} live onConnect={onConnectBridge} />
      </Link>
    </ContextMenu>
  )
}

export default AgentsListPage
