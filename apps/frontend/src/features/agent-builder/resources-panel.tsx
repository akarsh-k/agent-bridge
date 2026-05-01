/**
 * Attached resources panel — shows the repos / MCP allowlist / skills
 * the agent can reach. Owns its own sheet state (Attach / Edit
 * sheets). Lives at the top of the Resources tab; renders each
 * sub-section as its own top-level card so the tab reads as a
 * stack of focused panels (no outer "Resources" wrapper — the tab
 * itself carries that name).
 */

import { useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill, type PillKind } from '../../ui/pill'
import { BrandGlyph } from '../../ui/brand-glyph'
import { EmptyState } from '../../ui/empty'
import { PlusIcon, FileIcon } from '../../ui/icons'
import { toast } from '../../ui/toast-store'
import { confirmDialog } from '../../ui/dialog-store'
import { RowMenu } from '../../ui/row-menu'
import { ApiError } from '../../lib/rpc'
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

// Card-head row used by every Resources sub-card: title + sub on the
// left, action button on the right. Inline style is fine here — it's
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
          sub={`${resources?.skills.length ?? 0} attached · reusable instruction packs the agent runs through`}
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
          <EmptyState
            glyph={<FileIcon />}
            title="No skills attached"
            body="Skills are reusable instruction packs that teach an agent how to do something well — like &ldquo;PR reviewer&rdquo; or &ldquo;migration writer&rdquo;."
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
        ) : (
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
