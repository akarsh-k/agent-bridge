import { useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { Link } from '../../../lib/link'
import { PageHeader } from '../../_chrome/page-header'
import { Button } from '../../../ui/button'
import { Pill } from '../../../ui/pill'
import { EmptyState } from '../../../ui/empty'
import { BrandGlyph, type BrandKind } from '../../../ui/brand-glyph'
import { RowMenu } from '../../../ui/row-menu'
import { ChevronRightIcon, McpIcon, PlusIcon } from '../../../ui/icons'
import { McpCreateSheet } from '../../../features/library/mcp-create-sheet'
import { McpAuthBadge } from '../../../features/library/mcp-auth-badge'
import { confirmDialog } from '../../../ui/dialog-store'
import { LibraryAttachNote } from '../../../ui/library-attach-note'
import { toast } from '../../../ui/toast-store'
import { ApiError } from '../../../lib/rpc'

function brandFor(name: string): BrandKind {
  const n = name.toLowerCase()
  if (n.includes('linear')) return 'linear'
  if (n.includes('notion')) return 'notion'
  if (n.includes('github')) return 'github'
  return 'mcp'
}

export function McpPage() {
  const { mcpConnections, removeMcpConnection } = useWorkspace()
  const [sheetOpen, setSheetOpen] = useState(false)

  const remove = async (id: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Delete MCP “${label}”?`,
        body: 'Agent allowlists referencing this connection will be cleared.',
        confirmLabel: 'Delete connection',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeMcpConnection(id)
      toast.success('MCP connection deleted')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    }
  }

  return (
    <div className="ab-page">
      <PageHeader
        title="MCP connections"
        subtitle="External tool servers your agents can call — Linear, Notion, Slack, GitHub, Postgres, anything that speaks Model Context Protocol."
        actions={
          <Button
            variant="primary"
            leading={<PlusIcon strokeWidth={2.4} />}
            onClick={() => setSheetOpen(true)}
          >
            Connect MCP
          </Button>
        }
      />

      <LibraryAttachNote subject="mcp" />

      {mcpConnections.length === 0 ? (
        <EmptyState
          glyph={<McpIcon />}
          title="No MCP connections yet"
          body="MCP gives your agent reach into the rest of your stack. Connect one and its tools become callable inside any agent."
          action={
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setSheetOpen(true)}
            >
              Connect your first MCP
            </Button>
          }
        />
      ) : (
        <div className="ab-card ab-list-card">
          {mcpConnections.map((m) => (
            <Link
              className="ab-list-row is-link"
              to={`/library/mcp/${m.id}`}
              key={m.id}
            >
              <BrandGlyph kind={brandFor(m.name)} />
              <div className="ab-list-row-head">
                <div className="ab-list-row-title">{m.name}</div>
                <div className="ab-list-row-sub ab-mono">
                  {m.transport} · {m.commandOrUrl}
                </div>
              </div>
              <div className="ab-list-row-meta">
                <Pill kind="neutral">{m.transport}</Pill>
                <McpAuthBadge auth={m.auth} />
                <RowMenu
                  items={[
                    {
                      label: 'Delete connection',
                      destructive: true,
                      onClick: () => void remove(m.id, m.name),
                    },
                  ]}
                />
                <span className="ab-row-affordance" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <McpCreateSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  )
}
