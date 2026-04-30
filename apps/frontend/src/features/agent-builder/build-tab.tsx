/**
 * Build tab — Identity + Model + Resources sections. Auto-saves
 * via the existing patchAgent mutator. Resources sub-sections show
 * the attached repos / MCPs / skills with brand glyphs and tap into
 * the workspace context.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { Button } from '../../ui/button'
import { Pill, type PillKind } from '../../ui/pill'
import { BrandGlyph } from '../../ui/brand-glyph'
import { EmptyState } from '../../ui/empty'
import { PlusIcon, FileIcon, PencilIcon } from '../../ui/icons'
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

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

// Mirror the library page's repo-status mapping so an attached repo
// shows the SAME pill the user saw when they registered it. Errors
// surface in red with the lastError message exposed under the row.
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

export function BuildTab({ agentId }: { agentId: string }) {
  const {
    agents,
    llmProviders,
    agentResources,
    patchAgent,
    detachRepo,
    removeSkill,
    patchSkill,
    setAgentMcpTools,
  } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const resources = agentResources[agentId]

  // We track the agent id we've reset for; whenever it changes we
  // re-seed the form via the "adjust state based on props" pattern.
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
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

  // ─── Debounced auto-save ──────────────────────────────────────────
  // Identity / model fields auto-save 800ms after the last edit.
  // We compare against the canonical `agent` to know when there's
  // genuinely something to flush.
  const [autoSaveState, setAutoSaveState] = useState<
    'idle' | 'pending' | 'saving' | 'saved' | 'error'
  >('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const draft = useMemo(
    () => ({
      name: name.trim(),
      slug,
      systemPrompt,
      llmProviderId: providerId,
      model,
    }),
    [name, slug, systemPrompt, providerId, model],
  )

  const isDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    return (
      draft.name !== agent.name ||
      draft.slug !== agent.slug ||
      draft.systemPrompt !== agent.systemPrompt ||
      draft.llmProviderId !== agent.llmProviderId ||
      draft.model !== agent.model
    )
  }, [agent, seededFor, draft])

  useEffect(() => {
    if (!agent) return
    if (!isDirty) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    let cancelled = false
    autoSaveTimer.current = setTimeout(async () => {
      if (cancelled) return
      if (!draft.name) {
        setAutoSaveState('error')
        return
      }
      setAutoSaveState('saving')
      try {
        await patchAgent(agent.id, draft)
        if (!cancelled) {
          setAutoSaveState('saved')
          setSavedAt(Date.now())
        }
      } catch (e) {
        if (cancelled) return
        setAutoSaveState('error')
        toast.error(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Auto-save failed',
        )
      }
    }, 800)
    // While the timer is queued, surface "Saving in a moment…" via
    // a microtask so the lint rule sees the setState as an
    // external-system update (not a synchronous side effect).
    queueMicrotask(() => {
      if (!cancelled) setAutoSaveState('pending')
    })
    return () => {
      cancelled = true
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    }
  }, [agent, isDirty, draft, patchAgent])

  if (agent && seededFor !== agent.id) {
    setSeededFor(agent.id)
    setName(agent.name)
    setSlug(agent.slug)
    setSystemPrompt(agent.systemPrompt)
    setProviderId(agent.llmProviderId)
    setModel(agent.model)
  }

  const provider = useMemo(
    () => llmProviders.find((p) => p.id === providerId) ?? null,
    [llmProviders, providerId],
  )
  const cachedModels = useMemo(
    () => provider?.models?.models ?? [],
    [provider],
  )

  const providerOpts: DropdownOption[] = useMemo(
    () =>
      llmProviders.map((p) => ({
        value: p.id,
        label: p.label,
        sub: p.kind,
        disabled: !p.apiKey.set && !LOCAL_KINDS.has(p.kind),
        disabledReason:
          !p.apiKey.set && !LOCAL_KINDS.has(p.kind)
            ? 'No API key set on this provider'
            : undefined,
      })),
    [llmProviders],
  )
  const modelOpts: DropdownOption[] = useMemo(
    () =>
      cachedModels.map((m) => ({ value: m, label: m, monoLabel: true })),
    [cachedModels],
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

  if (!agent) return null

  return (
    <div>
      {/* Identity */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Identity</div>
          <div className="ab-section-sub">
            How the agent introduces itself when called from your IDE.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="b-name">
              Name
            </label>
            <input
              id="b-name"
              className="ab-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="b-slug">
              Slug
            </label>
            <input
              id="b-slug"
              className="ab-input ab-mono"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            {slug !== agent.slug && (
              <span
                className="ab-field-help"
                style={{ color: 'var(--warn)' }}
              >
                ⚠ Bridge tool name will change to{' '}
                <code className="ab-mono">query_{slug || '<slug>'}</code> —
                connected IDEs need to reconnect to pick up the rename.
              </span>
            )}
          </div>
          <div className="ab-field ab-field-col">
            <label className="ab-field-label" htmlFor="b-prompt">
              System prompt
            </label>
            <textarea
              id="b-prompt"
              className="ab-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
            />
            <span className="ab-field-help">
              Prepended to every conversation. Markdown supported.
            </span>
          </div>
        </div>
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          {autoSaveState === 'pending' && <span>Saving in a moment…</span>}
          {autoSaveState === 'saving' && (
            <>
              <span className="ab-pulse-dot" />
              <span>Saving…</span>
            </>
          )}
          {autoSaveState === 'saved' && savedAt !== null && (
            <SavedAgo since={savedAt} />
          )}
          {autoSaveState === 'error' && (
            <span style={{ color: 'var(--danger)' }}>
              Auto-save failed
            </span>
          )}
          {autoSaveState === 'idle' && !isDirty && savedAt !== null && (
            <SavedAgo since={savedAt} />
          )}
          {autoSaveState === 'idle' && !isDirty && savedAt === null && (
            <span>All changes saved.</span>
          )}
        </div>
      </div>

      {/* Model */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Model</div>
          <div className="ab-section-sub">
            Which provider answers requests for this agent.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <span className="ab-field-label">Provider</span>
            <Dropdown
              value={providerId}
              onChange={setProviderId}
              options={providerOpts}
              placeholder={
                providerOpts.length === 0
                  ? 'No providers yet — add one in Library'
                  : 'Pick a provider'
              }
              disabled={providerOpts.length === 0}
            />
          </div>
          <div className="ab-field">
            <span className="ab-field-label">Model</span>
            <Dropdown
              value={model}
              onChange={setModel}
              options={modelOpts}
              placeholder={providerId ? 'Pick a model' : 'Pick a provider first'}
              disabled={!providerId || modelOpts.length === 0}
            />
          </div>
        </div>
      </div>

      {/* Resources */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Resources</div>
          <div className="ab-section-sub">
            Repositories, MCP connections, and skills this agent can reach.
          </div>
        </div>

        {/* Repositories */}
        <div className="ab-resource-section">
          <div className="ab-resource-head">
            <div>
              <span className="ab-resource-title">Repositories</span>
              <span className="ab-resource-count">
                {resources?.attachedRepos.length ?? 0} attached
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setRepoSheet(true)}
            >
              Attach repo
            </Button>
          </div>
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
                          className="ab-list-row-sub"
                          style={{
                            marginTop: 4,
                            color: 'var(--danger)',
                            display: '-webkit-box',
                            WebkitBoxOrient: 'vertical',
                            WebkitLineClamp: 2,
                            overflow: 'hidden',
                          }}
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
                            label: 'Edit attachment',
                            onClick: () =>
                              setEditingRepoAttachmentId(r.repo.id),
                          },
                          {
                            label: 'Open in library',
                            onClick: () => navigate(`/library/repos/${r.repo.id}`),
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
                      <span className="ab-row-affordance" aria-hidden="true">
                        <PencilIcon />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <EdgesSection agentId={agentId} />

        {/* MCP connections */}
        <div className="ab-resource-section">
          <div className="ab-resource-head">
            <div>
              <span className="ab-resource-title">MCP connections</span>
              <span className="ab-resource-count">
                {resources?.mcpAllowlist.length ?? 0} allowed tools
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setMcpSheet(true)}
            >
              Connect MCP
            </Button>
          </div>
          {(resources?.mcpAllowlist.length ?? 0) === 0 ? (
            <EmptyState
              glyph={<FileIcon />}
              title="No MCP connections allowed"
              body="MCP servers expose external tools (Linear, Notion, Slack, etc.) that this agent can call."
            />
          ) : (
            <div className="ab-card ab-list-card">
              {groupAllowlistByConnection(
                resources?.mcpAllowlist ?? [],
              ).map((group) => {
                const enabledCount = group.tools.filter((t) => t.enabled).length
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
                    <div
                      className="ab-list-row-head"
                      style={{ gap: 6 }}
                    >
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
                      <span className="ab-row-affordance" aria-hidden="true">
                        <PencilIcon />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Skills */}
        <div className="ab-resource-section">
          <div className="ab-resource-head">
            <div>
              <span className="ab-resource-title">Skills</span>
              <span className="ab-resource-count">
                {resources?.skills.length ?? 0} attached
              </span>
            </div>
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
          </div>
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
                      <span className="ab-row-affordance" aria-hidden="true">
                        <PencilIcon />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
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
    </div>
  )
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
  // Sort tools alphabetically within each group for stable display.
  for (const group of out.values()) {
    group.tools.sort((a, b) => a.toolName.localeCompare(b.toolName))
  }
  return [...out.values()]
}

function SavedAgo({ since }: { since: number }) {
  // Tick once a second so the relative timestamp stays fresh while
  // the user lingers on the form. Stops as soon as the row dirties
  // again because the parent stops rendering this branch.
  const [now, setNow] = useState(since)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const delta = Math.max(0, now - since)
  const label =
    delta < 4_000
      ? 'Saved just now'
      : delta < 60_000
        ? `Saved ${Math.round(delta / 1000)}s ago`
        : delta < 60 * 60_000
          ? `Saved ${Math.floor(delta / 60_000)}m ago`
          : `Saved ${Math.floor(delta / (60 * 60_000))}h ago`
  return <span style={{ color: 'var(--success)' }}>{label}</span>
}
