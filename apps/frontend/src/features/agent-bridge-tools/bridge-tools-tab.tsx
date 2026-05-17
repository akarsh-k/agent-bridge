/**
 * Bridge tools tab — outbound MCP tools the agent EXPOSES to the
 * IDE. Distinct from the "Tools" tab which shows the
 * agent's INTERNAL run-time tools.
 *
 * Each bridge tool has:
 *   - `name`        — appears in the IDE's tools/list as
 *                     `query_<agent.slug>__<name>` (the bridge prefixes
 *                     the agent slug; we just store the local name).
 *   - `inputSchema` — JSON-Schema describing the args the IDE passes.
 *   - `promptTemplate` — string interpolated into the agent's prompt.
 *   - `enabled`     — soft-disable without deleting.
 *
 * Bridge tools are NOT in the workspace cache (they're agent-scoped
 * and rarely loaded), so this tab fetches its own list lazily.
 */

import { useEffect, useState } from 'react'
import {
  INSPECT_CODEBASE_METADATA,
  type BridgeToolResponse,
} from '@agent-bridge/shared'
import {
  ApiError,
  deleteBridgeTool,
  listBridgeTools,
} from '../../lib/rpc'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import { RowMenu } from '../../ui/row-menu'
import { confirmDialog } from '../../ui/dialog-store'
import { toast } from '../../ui/toast-store'
import {
  BridgeIcon,
  ChevronDownIcon,
  PlusIcon,
  ToolIcon,
} from '../../ui/icons'
import { useWorkspace } from '../../lib/workspace-context'
import { BridgeToolSheet } from './bridge-tool-sheet'

export function BridgeToolsTab({ agentId }: { agentId: string }) {
  const { agents } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const slug = agent?.slug ?? 'agent'
  const [tools, setTools] = useState<readonly BridgeToolResponse[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  // Refetch on agent change OR after a successful mutation.
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!alive) return
      setLoading(true)
      setErr(null)
      try {
        const list = await listBridgeTools(agentId)
        if (alive) setTools(list)
      } catch (e) {
        if (alive) {
          setErr(
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : 'Failed to load bridge tools',
          )
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, version])

  const reload = () => setVersion((v) => v + 1)
  const openCreate = () => {
    setEditingId(null)
    setSheetOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setSheetOpen(true)
  }

  const remove = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Delete bridge tool “${name}”?`,
        body: 'Connected IDEs keep the cached definition until they reconnect. The agent stops exposing it on the next bridge restart.',
        confirmLabel: 'Delete bridge tool',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await deleteBridgeTool(agentId, id)
      toast.success('Bridge tool deleted')
      reload()
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
    <div>
      {(agent?.inspectorEnabled ?? true) && (
        <InspectorToolkitCard slug={slug} />
      )}

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Bridge tools</div>
          <div className="ab-section-sub">
            Tools this agent <strong>exposes to your IDE</strong> over MCP.
            Each one shows up in Cursor / Claude Code / Codex as a callable
            function. The IDE picks args, the agent fills the prompt
            template, the LLM answers.
          </div>
        </div>

        {err && (
          <div
            className="ab-field-help"
            style={{ color: 'var(--danger)' }}
            role="alert"
          >
            {err}
          </div>
        )}

        {loading && tools.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--text-dim)',
              padding: '10px 0',
              fontSize: 13,
            }}
          >
            <span className="ab-pulse-dot" />
            Loading bridge tools…
          </div>
        ) : tools.length === 0 ? (
          <EmptyState
            glyph={<BridgeIcon />}
            title="No bridge tools yet"
            body={
              <>
                Bridge tools turn this agent into a typed function your IDE
                can call. The bridge auto-publishes them as{' '}
                <code className="ab-mono">query_&lt;slug&gt;__&lt;name&gt;</code>
                .
              </>
            }
            action={
              <Button
                variant="primary"
                leading={<PlusIcon strokeWidth={2.4} />}
                onClick={openCreate}
              >
                Add bridge tool
              </Button>
            }
          />
        ) : (
          <>
            <div className="ab-card ab-list-card">
              {tools.map((t) => (
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
                >
                  <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                    <ToolIcon />
                  </div>
                  <div className="ab-list-row-head">
                    <div className="ab-list-row-title ab-mono">{t.name}</div>
                    <div
                      className="ab-list-row-sub"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.description || 'No description'}
                    </div>
                  </div>
                  <div className="ab-list-row-meta">
                    <Pill kind={t.enabled ? 'success' : 'neutral'} dot>
                      {t.enabled ? 'Enabled' : 'Disabled'}
                    </Pill>
                    <RowMenu
                      items={[
                        {
                          label: 'Edit bridge tool',
                          onClick: () => openEdit(t.id),
                        },
                        {
                          label: 'Delete bridge tool',
                          destructive: true,
                          onClick: () => void remove(t.id, t.name),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <Button
                variant="secondary"
                leading={<PlusIcon strokeWidth={2.4} />}
                onClick={openCreate}
              >
                Add bridge tool
              </Button>
            </div>
          </>
        )}
      </div>

      <BridgeToolSheet
        open={sheetOpen}
        agentId={agentId}
        toolId={editingId}
        existingTool={
          editingId ? (tools.find((t) => t.id === editingId) ?? null) : null
        }
        onClose={() => {
          setSheetOpen(false)
          setEditingId(null)
        }}
        onSaved={() => {
          setSheetOpen(false)
          setEditingId(null)
          reload()
        }}
      />
    </div>
  )
}

/**
 * Read-only card showing the single system MCP tool repo-inspector
 * agents auto-expose: `<slug>__inspect_codebase`. Description is
 * system-controlled (operator agent description + framework note
 * about the structured envelope). Blank agents do NOT render this
 * card — their starter `<slug>__ask_agent` tool lives in
 * `bridge_tools` and shows up in the regular custom-tools list
 * below as a fully-editable row.
 */
function InspectorToolkitCard({ slug }: { slug: string }) {
  const fullName = `${slug}__${INSPECT_CODEBASE_METADATA.nameSuffix}`
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-head" style={{ marginBottom: 6 }}>
        <div className="ab-section-title">Built-in tool · system</div>
        <div className="ab-section-sub">
          Repo inspectors ship one system tool with a structured
          response contract: file paths, code snippets, graph slices,
          cross-repo relationships. The description is system-controlled
          (operator agent description + framework note about the
          envelope). Operators can author additional tools below
          via <strong>bridge_tools</strong>.
        </div>
      </div>
      <div className="ab-card ab-list-card">
        <BuiltInRow fullName={fullName} meta={INSPECT_CODEBASE_METADATA} />
      </div>
    </div>
  )
}

function BuiltInRow({
  fullName,
  meta,
}: {
  fullName: string
  meta: typeof INSPECT_CODEBASE_METADATA
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        type="button"
        className="ab-list-row"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <BridgeIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title ab-mono">{fullName}</div>
          <div className="ab-list-row-sub">{meta.summary}</div>
        </div>
        <div className="ab-list-row-meta">
          <Pill kind="accent">Built-in</Pill>
          <span
            className="ab-row-affordance"
            aria-hidden="true"
            style={{
              transform: expanded ? 'rotate(180deg)' : undefined,
              transition: 'transform 160ms var(--ease-out)',
              display: 'inline-flex',
            }}
          >
            <ChevronDownIcon />
          </span>
        </div>
      </button>
      {expanded && (
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
          {meta.description}
          {'\n\nInputs:'}
          {meta.inputKeys.map((k) => (
            <div key={k.name} style={{ marginTop: 6 }}>
              <span className="ab-mono" style={{ color: 'var(--text)' }}>
                {k.name}
              </span>{' '}
              {k.required ? '(required)' : '(optional)'} — {k.description}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

