/**
 * Tools tab content (rendered inside `Resources`). the agent's
 * INBOUND tool surface: native `tools` rows (HTTP / shell / Mastra
 * built-ins) the LLM can call while answering, plus the read-only
 * gitnexus "System defaults" catalog auto-mounted when the agent
 * has at least one indexed repo.
 *
 * NOTE: this file ONLY deals with inbound tools. The OUTBOUND
 * surface. what the IDE sees on `tools/list` (operator-authored
 * `bridge_tools` rows + the always-on coding-agent toolkit
 * virtuals). lives in `features/agent-bridge-tools/bridge-tools-tab.tsx`.
 * Don't conflate them: same word, opposite directions, two
 * different DB tables. See `docs/ARCHITECTURE.md` §8.
 */

import { useEffect, useState } from 'react'
import type { SystemToolDefinition } from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import { ChevronDownIcon, PlusIcon, ToolIcon } from '../../ui/icons'
import { RowMenu } from '../../ui/row-menu'
import { confirmDialog } from '../../ui/dialog-store'
import { toast } from '../../ui/toast-store'
import { ApiError, getGitnexusSystemTools } from '../../lib/rpc'
import { useDragReorder } from '../../lib/use-drag-reorder'
import { ToolSheet } from './tool-sheet'

type SystemToolsState =
  | { status: 'loading' }
  | { status: 'ready'; tools: ReadonlyArray<SystemToolDefinition> }
  | { status: 'error'; message: string }

// Small uppercase caption that separates the operator's custom rows
// from the always-attached built-in rows inside a Tools / Skills card.
function BuiltInSubhead() {
  return (
    <div
      style={{
        margin: '18px 4px 8px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}
    >
      Built-in
    </div>
  )
}

// Pull a one-line summary out of a tool description so the System
// defaults rows stay scannable. Cuts at the first hard newline OR the
// first sentence terminator followed by a capital letter — that handles
// both "X. WHEN TO USE: …" and "X.\nDetails …" styles. Falls back to
// the raw text when neither marker is present (short descriptions).
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const nl = trimmed.indexOf('\n')
  const sentenceMatch = trimmed.match(/[.!?]\s+(?=[A-Z])/)
  const sentenceCut =
    sentenceMatch && sentenceMatch.index !== undefined
      ? sentenceMatch.index + 1
      : -1
  let cut = -1
  if (nl >= 0 && sentenceCut >= 0) cut = Math.min(nl, sentenceCut)
  else if (nl >= 0) cut = nl
  else if (sentenceCut >= 0) cut = sentenceCut
  return cut < 0 ? trimmed : trimmed.slice(0, cut).trim()
}

export function ToolsTab({ agentId }: { agentId: string }) {
  const { agentResources, removeTool, patchTool } = useWorkspace()
  const tools = agentResources[agentId]?.tools ?? []
  const attachedRepos = agentResources[agentId]?.attachedRepos ?? []
  const readyRepos = attachedRepos.filter((r) => r.repo.status === 'ready')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [systemTools, setSystemTools] = useState<SystemToolsState>({
    status: 'loading',
  })
  const [expandedSystemTool, setExpandedSystemTool] = useState<string | null>(
    null,
  )
  const toggleSystemTool = (name: string) =>
    setExpandedSystemTool((cur) => (cur === name ? null : name))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await getGitnexusSystemTools()
        if (cancelled) return
        if (result.ok) {
          setSystemTools({ status: 'ready', tools: result.tools })
        } else {
          setSystemTools({ status: 'error', message: result.message })
        }
      } catch (e) {
        if (cancelled) return
        setSystemTools({
          status: 'error',
          message:
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : 'Failed to load system tools',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  // Built-in (system) tool rows. read-only list of the gitnexus
  // tools auto-mounted when this agent has a ready repo. Rendered as
  // a fragment so the unified Tools card can drop them under the
  // operator-authored rows in the same `ab-list-card`, mirroring
  // the Skills card pattern in `resources-panel.tsx`.
  const renderSystemRows = () => {
    if (systemTools.status === 'loading') {
      return (
        <div
          className="ab-list-row"
          style={{ opacity: 0.6, fontSize: 13, color: 'var(--text-dim)' }}
        >
          <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
            <ToolIcon />
          </div>
          <div className="ab-list-row-head">
            <div className="ab-list-row-title">Loading built-in tools…</div>
          </div>
        </div>
      )
    }
    if (systemTools.status === 'error') {
      return (
        <div className="ab-list-row" style={{ fontSize: 13 }}>
          <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
            <ToolIcon />
          </div>
          <div className="ab-list-row-head">
            <div className="ab-list-row-title">Built-in tools (unavailable)</div>
            <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
              {systemTools.message}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div style={{ opacity: readyRepos.length === 0 ? 0.6 : 1 }}>
        {systemTools.tools.map((t) => {
          const summary = firstSentence(t.description)
          const hasMore = summary !== t.description.trim()
          const isExpanded = expandedSystemTool === t.name
          return (
            <div key={t.name}>
              <button
                type="button"
                className="ab-list-row"
                onClick={hasMore ? () => toggleSystemTool(t.name) : undefined}
                disabled={!hasMore}
                aria-expanded={hasMore ? isExpanded : undefined}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: hasMore ? 'pointer' : 'default',
                }}
              >
                <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                  <ToolIcon />
                </div>
                <div className="ab-list-row-head">
                  <div className="ab-list-row-title ab-mono">{t.name}</div>
                  <div className="ab-list-row-sub">{summary}</div>
                </div>
                <div className="ab-list-row-meta">
                  <Pill kind="accent">Built-in</Pill>
                  {hasMore && (
                    <span
                      className="ab-row-affordance"
                      aria-hidden="true"
                      style={{
                        transform: isExpanded ? 'rotate(180deg)' : undefined,
                        transition: 'transform 160ms var(--ease-out)',
                        display: 'inline-flex',
                      }}
                    >
                      <ChevronDownIcon />
                    </span>
                  )}
                </div>
              </button>
              {isExpanded && (
                <div
                  style={{
                    padding: '14px 18px 14px 62px',
                    fontSize: 13,
                    lineHeight: 1.55,
                    background: 'var(--surface-hi)',
                    borderTop: '1px solid var(--border)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {t.description.trim()}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const systemToolCount =
    systemTools.status === 'ready' ? systemTools.tools.length : 0

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
            <div className="ab-section-title">Tools</div>
            <div className="ab-section-sub">
              {tools.length} attached · {systemToolCount} built-in ·
              tools the agent calls while answering (HTTP, shell, Mastra
              built-ins, gitnexus). For tools the IDE calls into the
              agent, see the <strong>Bridge tools</strong> tab.
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

        {readyRepos.length === 0 && systemTools.status === 'ready' && (
          <div
            className="ab-field-help"
            style={{ marginBottom: 10, color: 'var(--warn)' }}
          >
            No indexed repositories attached. the built-in tools below
            are listed for reference but won't have data to query until
            at least one repo finishes indexing.
          </div>
        )}

        {tools.length === 0 ? (
          <>
            <EmptyState
              glyph={<ToolIcon />}
              title="No custom tools yet"
              body="Tools extend the agent at run time. The LLM decides when to call them based on your system prompt and the user's question. The built-in tools below are always attached."
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
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">{renderSystemRows()}</div>
          </>
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
                  </div>
                </div>
                )
              })}
            </div>
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">{renderSystemRows()}</div>
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
