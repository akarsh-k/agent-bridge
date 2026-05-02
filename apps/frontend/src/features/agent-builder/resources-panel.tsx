/**
 * Attached resources panel — shows the repos / MCP allowlist / skills
 * the agent can reach. Owns its own sheet state (Attach / Edit
 * sheets). Lives at the top of the Resources tab; renders each
 * sub-section as its own top-level card so the tab reads as a
 * stack of focused panels (no outer "Resources" wrapper — the tab
 * itself carries that name).
 */

import { useEffect, useState } from 'react'
import type {
  CodingAgentSystemSkillResponse,
  GitnexusLibrarySkillsResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill, type PillKind } from '../../ui/pill'
import { BrandGlyph } from '../../ui/brand-glyph'
import { EmptyState } from '../../ui/empty'
import { Markdown } from '../../ui/markdown'
import { PlusIcon, FileIcon, ChevronDownIcon } from '../../ui/icons'
import { toast } from '../../ui/toast-store'
import { confirmDialog } from '../../ui/dialog-store'
import { RowMenu } from '../../ui/row-menu'
import {
  ApiError,
  getCodingAgentSystemSkill,
  getGitnexusLibrarySkills,
} from '../../lib/rpc'
import { navigate } from '../../lib/router'
import { useDragReorder } from '../../lib/use-drag-reorder'
import { AttachRepoSheet } from './attach-repo-sheet'
import { AttachMcpSheet } from './attach-mcp-sheet'
import { SkillSheet } from './skill-sheet'
import { EdgesSection } from './edges-section'
import { EditAttachedRepoSheet } from './edit-attached-repo-sheet'

const REPO_STATUS_PILL: Record<
  string,
  { kind: PillKind; label: string }
> = {
  pending: { kind: 'neutral', label: 'Pending' },
  cloning: { kind: 'warn', label: 'Cloning' },
  cloned: { kind: 'neutral', label: 'Cloned' },
  indexing: { kind: 'warn', label: 'Indexing' },
  ready: { kind: 'success', label: 'Indexed' },
  error: { kind: 'danger', label: 'Error' },
}

interface AllowlistGroup {
  mcpConnectionId: string
  mcpConnectionName: string
  tools: Array<{ toolName: string; enabled: boolean }>
}

function groupAllowlistByConnection(
  list: ReadonlyArray<{
    mcpConnectionId: string
    mcpConnectionName: string
    toolName: string
    enabled: boolean
  }>,
): AllowlistGroup[] {
  const out = new Map<string, AllowlistGroup>()
  for (const e of list) {
    const cur = out.get(e.mcpConnectionId)
    if (cur) {
      cur.tools.push({ toolName: e.toolName, enabled: e.enabled })
    } else {
      out.set(e.mcpConnectionId, {
        mcpConnectionId: e.mcpConnectionId,
        mcpConnectionName: e.mcpConnectionName,
        tools: [{ toolName: e.toolName, enabled: e.enabled }],
      })
    }
  }
  return [...out.values()]
}

// Small uppercase caption that separates the operator's custom rows
// from the always-attached built-in rows inside a card. Same idiom
// used by the Tools tab.
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

// Card-head row used by every Resources sub-card: title + sub on the
// left, action button on the right. Inline style is fine here. it's
// a layout concern that doesn't reuse outside this file.
function CardHead({
  title,
  sub,
  action,
}: {
  title: string
  sub: string
  action?: React.ReactNode
}) {
  return (
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
        <div className="ab-section-title">{title}</div>
        <div className="ab-section-sub">{sub}</div>
      </div>
      {action}
    </div>
  )
}

export function ResourcesPanel({ agentId }: { agentId: string }) {
  const {
    agentResources,
    detachRepo,
    removeSkill,
    patchSkill,
    setAgentMcpTools,
  } = useWorkspace()
  const resources = agentResources[agentId]

  const [repoSheet, setRepoSheet] = useState(false)
  const [mcpSheet, setMcpSheet] = useState(false)
  const [skillSheet, setSkillSheet] = useState(false)
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [editingRepoAttachmentId, setEditingRepoAttachmentId] = useState<
    string | null
  >(null)

  const reorderSkills = async (nextIds: ReadonlyArray<string>) => {
    const skills = resources?.skills ?? []
    const byId = new Map(skills.map((s) => [s.id, s]))
    try {
      for (let i = 0; i < nextIds.length; i++) {
        const id = nextIds[i]!
        const cur = byId.get(id)
        if (!cur || cur.position === i) continue
        await patchSkill(agentId, id, { position: i })
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

  const skillDrag = useDragReorder(
    resources?.skills ?? [],
    (s) => s.id,
    (next) => void reorderSkills(next),
  )

  const detachRepoConfirmed = async (repoId: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Detach ${label}?`,
        body: 'The repo stays in your library — only this agent loses access.',
        confirmLabel: 'Detach',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await detachRepo(agentId, repoId)
      toast.success('Repo detached')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to detach',
      )
    }
  }

  const removeSkillConfirmed = async (skillId: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Delete skill “${name}”?`,
        confirmLabel: 'Delete skill',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeSkill(agentId, skillId)
      toast.success('Skill deleted')
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

  const removeMcpEntry = async (
    mcpConnectionId: string,
    toolName: string,
  ) => {
    if (
      !(await confirmDialog({
        title: `Disallow tool “${toolName}”?`,
        body: 'The MCP server stays connected — this agent just stops being able to call this specific tool.',
        confirmLabel: 'Disallow',
        destructive: true,
      }))
    ) {
      return
    }
    const entries = (resources?.mcpAllowlist ?? [])
      .filter(
        (m) =>
          m.enabled &&
          !(m.mcpConnectionId === mcpConnectionId && m.toolName === toolName),
      )
      .map((m) => ({
        mcpConnectionId: m.mcpConnectionId,
        toolName: m.toolName,
      }))
    try {
      await setAgentMcpTools(agentId, entries)
      toast.success('Tool removed from allowlist')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed',
      )
    }
  }

  return (
    <>
      {/* Repositories card — list of attached repos. */}
      <div className="ab-card ab-card-pad ab-form-section">
        <CardHead
          title="Repositories"
          sub={`${resources?.attachedRepos.length ?? 0} attached · code the agent can read and reason about`}
          action={
            <Button
              variant="secondary"
              size="sm"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setRepoSheet(true)}
            >
              Attach repo
            </Button>
          }
        />
        {(resources?.attachedRepos.length ?? 0) === 0 ? (
          <EmptyState
            glyph={<FileIcon />}
            title="No repositories attached"
            body="Attach a repo so this agent can read your codebase, generate a wiki, and answer questions about it."
            action={
              <Button
                variant="primary"
                leading={<PlusIcon strokeWidth={2.4} />}
                onClick={() => setRepoSheet(true)}
              >
                Attach a repository
              </Button>
            }
          />
        ) : (
          <div className="ab-card ab-list-card">
            {resources?.attachedRepos.map((r) => {
              const sp =
                REPO_STATUS_PILL[r.repo.status] ?? REPO_STATUS_PILL.pending!
              const inError = r.repo.status === 'error'
              return (
                <div
                  className="ab-list-row is-edit"
                  key={r.repo.id}
                  onClick={() => setEditingRepoAttachmentId(r.repo.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setEditingRepoAttachmentId(r.repo.id)
                    }
                  }}
                >
                  <BrandGlyph kind="github" />
                  <div className="ab-list-row-head">
                    <div className="ab-list-row-title">
                      {r.role || r.repo.remoteUrl}
                    </div>
                    <div className="ab-list-row-sub ab-mono">
                      {r.repo.remoteUrl}
                    </div>
                    {r.aliases && r.aliases.length > 0 && (
                      <div
                        className="ab-list-row-sub"
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 4,
                          marginTop: 4,
                        }}
                        title="Names a coding agent might use to refer to this repo"
                      >
                        {r.aliases.map((a) => (
                          <span key={a} className="ab-pill">
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                    {inError && r.repo.lastError && (
                      <div
                        className="ab-list-row-error"
                        title={r.repo.lastError}
                      >
                        {r.repo.lastError}
                      </div>
                    )}
                  </div>
                  <div className="ab-list-row-meta">
                    <Pill kind={sp.kind} dot>
                      {sp.label}
                    </Pill>
                    <RowMenu
                      items={[
                        {
                          label: 'Edit role',
                          onClick: () =>
                            setEditingRepoAttachmentId(r.repo.id),
                        },
                        {
                          label: 'Manage repository',
                          onClick: () =>
                            navigate(`/library/repos/${r.repo.id}`),
                        },
                        {
                          label: 'Detach repo',
                          destructive: true,
                          onClick: () =>
                            void detachRepoConfirmed(
                              r.repo.id,
                              r.role || r.repo.remoteUrl,
                            ),
                        },
                      ]}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Repo relations — promoted to its own card so it's visible at
          a glance and the action button lines up with the others. */}
      <EdgesSection agentId={agentId} />

      {/* MCP connections card */}
      <div className="ab-card ab-card-pad ab-form-section">
        <CardHead
          title="MCP connections"
          sub={`${resources?.mcpAllowlist.length ?? 0} allowed tools · external servers (Linear, Notion, …) the agent can call`}
          action={
            <Button
              variant="secondary"
              size="sm"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setMcpSheet(true)}
            >
              Connect MCP
            </Button>
          }
        />
        {(resources?.mcpAllowlist.length ?? 0) === 0 ? (
          <EmptyState
            glyph={<FileIcon />}
            title="No MCP connections allowed"
            body="MCP servers expose external tools (Linear, Notion, Slack, etc.) that this agent can call."
          />
        ) : (
          <div className="ab-card ab-list-card">
            {groupAllowlistByConnection(resources?.mcpAllowlist ?? []).map(
              (group) => {
                const enabledCount = group.tools.filter((t) => t.enabled)
                  .length
                return (
                  <div
                    className="ab-list-row is-edit"
                    key={group.mcpConnectionId}
                    role="button"
                    tabIndex={0}
                    onClick={() => setMcpSheet(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setMcpSheet(true)
                      }
                    }}
                  >
                    <BrandGlyph kind="mcp" />
                    <div className="ab-list-row-head" style={{ gap: 6 }}>
                      <div className="ab-list-row-title">
                        {group.mcpConnectionName}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 4,
                          marginTop: 2,
                        }}
                      >
                        {group.tools.map((t) => (
                          <span
                            key={t.toolName}
                            className="ab-mono"
                            title={t.enabled ? 'Allowed' : 'Disabled'}
                            style={{
                              fontSize: 11,
                              padding: '2px 7px',
                              borderRadius: 'var(--radius-pill)',
                              background: t.enabled
                                ? 'var(--accent-bg)'
                                : 'var(--surface-hi)',
                              color: t.enabled
                                ? 'var(--accent-300)'
                                : 'var(--text-muted)',
                              border:
                                '1px solid ' +
                                (t.enabled
                                  ? 'var(--accent-border)'
                                  : 'var(--border)'),
                            }}
                          >
                            {t.toolName}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="ab-list-row-meta">
                      <Pill kind="success" dot>
                        {enabledCount} allowed
                      </Pill>
                      <RowMenu
                        items={[
                          {
                            label: 'Edit allowlist',
                            onClick: () => setMcpSheet(true),
                          },
                          {
                            label: 'Remove all',
                            destructive: true,
                            onClick: () => {
                              for (const t of group.tools) {
                                void removeMcpEntry(
                                  group.mcpConnectionId,
                                  t.toolName,
                                )
                              }
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>
                )
              },
            )}
          </div>
        )}
      </div>

      {/* Skills card */}
      <div className="ab-card ab-card-pad ab-form-section">
        <CardHead
          title="Skills"
          sub={`${resources?.skills.length ?? 0} attached · 2 built-in · reusable instruction packs the agent runs through`}
          action={
            <Button
              variant="secondary"
              size="sm"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => {
                setEditingSkillId(null)
                setSkillSheet(true)
              }}
            >
              Add skill
            </Button>
          }
        />
        {(resources?.skills.length ?? 0) === 0 ? (
          <>
            <EmptyState
              glyph={<FileIcon />}
              title="No custom skills yet"
              body="Skills are reusable instruction packs that teach an agent how to do something well. like &ldquo;PR reviewer&rdquo; or &ldquo;migration writer&rdquo;. The system skill below is always attached automatically."
              action={
                <Button
                  variant="primary"
                  leading={<PlusIcon strokeWidth={2.4} />}
                  onClick={() => {
                    setEditingSkillId(null)
                    setSkillSheet(true)
                  }}
                >
                  Add a skill
                </Button>
              }
            />
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">
              <SystemSkillRow />
              <GitnexusLibrarySkillsRow />
            </div>
          </>
        ) : (
          <>
            <div className="ab-card ab-list-card">
              {resources?.skills.map((s) => {
              const drag = skillDrag.rowProps(s.id)
              return (
                <div
                  className="ab-list-row is-edit"
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setEditingSkillId(s.id)
                    setSkillSheet(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setEditingSkillId(s.id)
                      setSkillSheet(true)
                    }
                  }}
                  draggable={drag.draggable}
                  onDragStart={drag.onDragStart}
                  onDragEnter={drag.onDragEnter}
                  onDragOver={drag.onDragOver}
                  onDragEnd={drag.onDragEnd}
                  onDrop={drag.onDrop}
                  style={{
                    opacity: drag.isDragging ? 0.4 : 1,
                    ...(drag.isDropTarget
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
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="ab-list-row-head">
                    <div className="ab-list-row-title">{s.name}</div>
                    <div
                      className="ab-list-row-sub"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.markdownBody.slice(0, 80) || 'No body yet'}
                    </div>
                  </div>
                  <div className="ab-list-row-meta">
                    <RowMenu
                      items={[
                        {
                          label: 'Edit skill',
                          onClick: () => {
                            setEditingSkillId(s.id)
                            setSkillSheet(true)
                          },
                        },
                        {
                          label: 'Delete skill',
                          destructive: true,
                          onClick: () =>
                            void removeSkillConfirmed(s.id, s.name),
                        },
                      ]}
                    />
                  </div>
                </div>
                )
              })}
            </div>
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">
              <SystemSkillRow />
              <GitnexusLibrarySkillsRow />
            </div>
          </>
        )}
      </div>

      <AttachRepoSheet
        open={repoSheet}
        agentId={agentId}
        onClose={() => setRepoSheet(false)}
      />
      <AttachMcpSheet
        open={mcpSheet}
        agentId={agentId}
        onClose={() => setMcpSheet(false)}
      />
      <SkillSheet
        open={skillSheet}
        agentId={agentId}
        skillId={editingSkillId}
        onClose={() => {
          setSkillSheet(false)
          setEditingSkillId(null)
        }}
      />
      <EditAttachedRepoSheet
        open={editingRepoAttachmentId !== null}
        agentId={agentId}
        attachment={
          editingRepoAttachmentId
            ? (resources?.attachedRepos.find(
                (a) => a.repo.id === editingRepoAttachmentId,
              ) ?? null)
            : null
        }
        onClose={() => setEditingRepoAttachmentId(null)}
      />
    </>
  )
}

// ─── Coding-agent system-skill row ──────────────────────────────────────

type SystemSkillState =
  | { status: 'loading' }
  | { status: 'ready'; data: CodingAgentSystemSkillResponse }
  | { status: 'error'; message: string }

/**
 * Read-only row shown at the bottom of the Skills list. The system
 * skill is the markdown body Agent Bridge auto-appends to every
 * agent's instructions in `composeInstructions`. operators can't
 * edit, reorder, or delete it (hence: no drag handle, no row menu).
 * Click expands the body inline so the operator can read what gets
 * sent to the LLM.
 *
 * Lives in the same Skills card as the operator-authored rows so
 * the section presents a single unified view of "what's in my
 * agent's system prompt". The visual `Built-in` pill + chevron
 * accordion matches the gitnexus "System defaults" pattern on the
 * Tools tab.
 */
function SystemSkillRow() {
  const [state, setState] = useState<SystemSkillState>({ status: 'loading' })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await getCodingAgentSystemSkill()
        if (!cancelled) setState({ status: 'ready', data })
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'Failed to load system skill',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <div
        className="ab-list-row"
        style={{ opacity: 0.6, fontSize: 13, color: 'var(--text-dim)' }}
      >
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">Loading system skill…</div>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="ab-list-row" style={{ fontSize: 13 }}>
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">System skill (unavailable)</div>
          <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
            {state.message}
          </div>
        </div>
      </div>
    )
  }

  if (state.data.ok === false) {
    return (
      <div className="ab-list-row" style={{ fontSize: 13 }}>
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">System skill (unavailable)</div>
          <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
            {state.data.message}
          </div>
        </div>
      </div>
    )
  }

  const skill = state.data
  return (
    <>
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
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">
            Coding-agent toolkit guidance
          </div>
          <div className="ab-list-row-sub">
            Always last in prompt order · v{skill.version} ·{' '}
            {skill.body.length.toLocaleString()} chars
          </div>
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
          }}
        >
          <Markdown source={skill.body} />
        </div>
      )}
    </>
  )
}

// ─── GitNexus library skills row ────────────────────────────────────────

type GitnexusLibSkillsState =
  | { status: 'loading' }
  | { status: 'ready'; data: GitnexusLibrarySkillsResponse }
  | { status: 'error'; message: string }

/**
 * Read-only row at the bottom of the Skills list. Surfaces the
 * markdown skill files that ship inside the gitnexus npm package
 * (`node_modules/.../gitnexus/skills/*.md`) which `composeInstructions`
 * auto-attaches to every agent's instructions. Operators see them
 * for transparency; can't edit (vendor content, version-locked).
 *
 * Expand to see the list of attached skill names; click one to read
 * its body inline. Mirrors the SystemSkillRow accordion pattern.
 */
function GitnexusLibrarySkillsRow() {
  const [state, setState] = useState<GitnexusLibSkillsState>({
    status: 'loading',
  })
  const [expanded, setExpanded] = useState(false)
  const [openSlug, setOpenSlug] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await getGitnexusLibrarySkills()
        if (!cancelled) setState({ status: 'ready', data })
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'Failed to load gitnexus library skills',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <div
        className="ab-list-row"
        style={{ opacity: 0.6, fontSize: 13, color: 'var(--text-dim)' }}
      >
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">Loading gitnexus library skills…</div>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="ab-list-row" style={{ fontSize: 13 }}>
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">GitNexus library skills (unavailable)</div>
          <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
            {state.message}
          </div>
        </div>
      </div>
    )
  }

  if (state.data.ok === false) {
    return (
      <div className="ab-list-row" style={{ fontSize: 13 }}>
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">GitNexus library skills (unavailable)</div>
          <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
            {state.data.message}
          </div>
        </div>
      </div>
    )
  }

  const data = state.data
  if (data.skills.length === 0) {
    return (
      <div className="ab-list-row" style={{ fontSize: 13 }}>
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">GitNexus library skills</div>
          <div className="ab-list-row-sub" style={{ color: 'var(--text-muted)' }}>
            No skills shipped with this gitnexus version.
          </div>
        </div>
      </div>
    )
  }

  const totalBytes = data.skills.reduce((sum, s) => sum + s.bytes, 0)
  return (
    <>
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
          <FileIcon />
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title">
            GitNexus library skills ({data.skills.length})
          </div>
          <div className="ab-list-row-sub">
            Vendor-shipped from gitnexus v{data.version} ·{' '}
            {totalBytes.toLocaleString()} chars total
          </div>
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
            background: 'var(--surface-hi)',
            borderTop: '1px solid var(--border)',
          }}
        >
          {data.skills.map((s) => {
            const isOpen = openSlug === s.slug
            return (
              <div key={s.slug} style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  className="ab-list-row"
                  onClick={() => setOpenSlug(isOpen ? null : s.slug)}
                  aria-expanded={isOpen}
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
                    <FileIcon />
                  </div>
                  <div className="ab-list-row-head">
                    <div className="ab-list-row-title">{s.name}</div>
                    <div className="ab-list-row-sub">
                      {s.description} · {s.bytes.toLocaleString()} chars
                    </div>
                  </div>
                  <div className="ab-list-row-meta">
                    <span
                      className="ab-row-affordance"
                      aria-hidden="true"
                      style={{
                        transform: isOpen ? 'rotate(180deg)' : undefined,
                        transition: 'transform 160ms var(--ease-out)',
                        display: 'inline-flex',
                      }}
                    >
                      <ChevronDownIcon />
                    </span>
                  </div>
                </button>
                {isOpen && (
                  <div
                    style={{
                      padding: '14px 18px 14px 62px',
                      fontSize: 13,
                      lineHeight: 1.55,
                      borderTop: '1px solid var(--border)',
                    }}
                  >
                    <Markdown source={s.body} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
