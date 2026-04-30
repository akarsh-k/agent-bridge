/**
 * Bridge tools tab — custom functions the agent exposes to the
 * connected IDEs over MCP.
 */

import { useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import { PencilIcon, PlusIcon, ToolIcon } from '../../ui/icons'
import { RowMenu } from '../../ui/row-menu'
import { confirmDialog } from '../../ui/dialog-store'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { useDragReorder } from '../../lib/use-drag-reorder'
import { ToolSheet } from './tool-sheet'

export function ToolsTab({ agentId }: { agentId: string }) {
  const { agentResources, removeTool, patchTool } = useWorkspace()
  const tools = agentResources[agentId]?.tools ?? []
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const reorder = async (nextIds: ReadonlyArray<string>) => {
    const byId = new Map(tools.map((t) => [t.id, t]))
    try {
      for (let i = 0; i < nextIds.length; i++) {
        const id = nextIds[i]!
        const cur = byId.get(id)
        if (!cur || cur.position === i) continue
        await patchTool(agentId, id, { position: i })
      }
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Reorder failed',
      )
    }
  }
  const drag = useDragReorder(tools, (t) => t.id, (next) => void reorder(next))

  const remove = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Delete tool “${name}”?`,
        body: 'The agent loses access to this tool on its next run.',
        confirmLabel: 'Delete tool',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeTool(agentId, id)
      toast.success('Tool deleted')
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

  const openCreate = () => {
    setEditingId(null)
    setSheetOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setSheetOpen(true)
  }

  return (
    <div>
      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="ab-section-title">Agent tools</div>
            <div className="ab-section-sub">
              {tools.length} attached · internal tools the agent can call
              during a run (HTTP, shell, Mastra built-ins). For tools the
              IDE calls into the agent, see the{' '}
              <strong>Bridge tools</strong> tab.
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leading={<PlusIcon strokeWidth={2.4} />}
            onClick={openCreate}
          >
            Add tool
          </Button>
        </div>

        {tools.length === 0 ? (
          <EmptyState
            glyph={<ToolIcon />}
            title="No tools yet"
            body="Tools extend the agent at run time. The LLM decides when to call them based on your system prompt and the user's question."
            action={
              <Button
                variant="primary"
                leading={<PlusIcon strokeWidth={2.4} />}
                onClick={openCreate}
              >
                Add tool
              </Button>
            }
          />
        ) : (
          <>
            <div className="ab-card ab-list-card">
              {tools.map((t) => {
                const dp = drag.rowProps(t.id)
                return (
                  <div
                    className="ab-list-row is-edit"
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openEdit(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openEdit(t.id)
                      }
                    }}
                    draggable={dp.draggable}
                    onDragStart={dp.onDragStart}
                    onDragEnter={dp.onDragEnter}
                    onDragOver={dp.onDragOver}
                    onDragEnd={dp.onDragEnd}
                    onDrop={dp.onDrop}
                    style={{
                      opacity: dp.isDragging ? 0.4 : 1,
                      ...(dp.isDropTarget
                        ? {
                            background: 'var(--accent-bg)',
                            boxShadow: 'inset 0 2px 0 var(--accent-400)',
                          }
                        : null),
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: 14,
                        marginRight: -4,
                        cursor: 'grab',
                        userSelect: 'none',
                      }}
                      title="Drag to reorder"
                    >
                      ⋮⋮
                    </span>
                    <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                      <ToolIcon />
                    </div>
                    <div className="ab-list-row-head">
                      <div className="ab-list-row-title ab-mono">{t.name}</div>
                      <div className="ab-list-row-sub">
                        {t.description ?? 'No description'}
                      </div>
                    </div>
                    <div className="ab-list-row-meta">
                      <Pill kind="neutral">{t.kind}</Pill>
                      <Pill kind="success" dot>
                        Active
                      </Pill>
                      <RowMenu
                        items={[
                          {
                            label: 'Edit tool',
                            onClick: () => openEdit(t.id),
                          },
                          {
                            label: 'Delete tool',
                            destructive: true,
                            onClick: () => void remove(t.id, t.name),
                          },
                        ]}
                      />
                      <span className="ab-row-affordance" aria-hidden="true">
                        <PencilIcon />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      <ToolSheet
        open={sheetOpen}
        agentId={agentId}
        toolId={editingId}
        onClose={() => {
          setSheetOpen(false)
          setEditingId(null)
        }}
      />
    </div>
  )
}
