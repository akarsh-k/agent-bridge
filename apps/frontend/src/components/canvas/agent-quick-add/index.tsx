/**
 * AgentQuickAdd — hover-triggered `+` button + popover menu that lives on
 * the right edge of every agent card.
 *
 * Flow:
 *   closed → menu → (skill-form | tool-form | repo-menu | llm-menu)
 *                → repo-menu → (pick existing | repo-new-form)
 *                → llm-menu  → (pick existing | llm-new-form)
 *
 * Dismiss rules:
 *   - Click outside the popover root closes it (listens on `mousedown` so
 *     we beat React Flow's pane-click handler).
 *   - Escape closes it.
 *   - Successful submit closes it and returns to `closed`.
 *   - The trigger button is hidden by default and reveals on `:hover` of
 *     the parent `.node-agent`; the `.open` class pins it visible while
 *     the popover is up.
 *
 * React Flow hygiene:
 *   - `nodrag` prevents the + / popover from initiating a node drag.
 *   - `nopan` / `nowheel` on the popover surface lets the user scroll
 *     inside it without panning the canvas.
 *   - Every interactive element calls `stopPropagation` so the node's
 *     own click handler (which focuses the agent) doesn't also fire.
 *
 * The popover does NOT handle its own positioning math — CSS owns that
 * (anchored to the + button via `position: absolute`). Keep the forms
 * small; this isn't the place for 12-field config.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  llmProviderCreateInputSchema,
  repoCreateInputSchema,
  skillCreateInputSchema,
  toolCreateInputSchema,
  toolKinds,
  llmProviderKinds,
  type LlmProviderKind,
  type ToolKind,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'

import './index.css'

type View =
  | 'closed'
  | 'menu'
  | 'skill-form'
  | 'tool-form'
  | 'repo-menu'
  | 'repo-new-form'
  | 'llm-menu'
  | 'llm-new-form'

const LOCAL_LLM_KINDS: readonly LlmProviderKind[] = [
  'llama_cpp',
  'ollama',
  'openai_compatible',
]
function isLocalKind(kind: LlmProviderKind): boolean {
  return LOCAL_LLM_KINDS.includes(kind)
}

function shortRemote(url: string): string {
  // Strip common prefixes + trailing .git so the menu row stays readable.
  return url
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
}

// ─── Main component ──────────────────────────────────────────────────────

export function AgentQuickAdd({ agentId }: { agentId: string }) {
  const workspace = useWorkspace()
  const [view, setView] = useState<View>('closed')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => setView('closed'), [])

  // Global dismiss: outside click + Escape. Only registered while the
  // popover is open; otherwise we pay zero listener cost.
  useEffect(() => {
    if (view === 'closed') return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      if (e.target instanceof Node && !root.contains(e.target)) {
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [view, close])

  const open = view !== 'closed'

  return (
    <div
      ref={rootRef}
      className={`node-qa-host nodrag${open ? ' open' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="node-qa-trigger"
        aria-label="Add connected resource"
        title="Add…"
        onClick={(e) => {
          e.stopPropagation()
          setView((v) => (v === 'closed' ? 'menu' : 'closed'))
        }}
      >
        +
      </button>

      {open ? (
        <div
          className="node-qa-popover nopan nowheel"
          role="dialog"
          aria-label="Add connected resource"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {view === 'menu' ? (
            <MenuView
              onPick={(v) => setView(v)}
              hasRepos={workspace.repos.length > 0}
              hasLlms={workspace.llmProviders.length > 0}
            />
          ) : null}
          {view === 'skill-form' ? (
            <SkillForm
              agentId={agentId}
              onBack={() => setView('menu')}
              onDone={close}
            />
          ) : null}
          {view === 'tool-form' ? (
            <ToolForm
              agentId={agentId}
              onBack={() => setView('menu')}
              onDone={close}
            />
          ) : null}
          {view === 'repo-menu' ? (
            <RepoPicker
              agentId={agentId}
              onBack={() => setView('menu')}
              onCreateNew={() => setView('repo-new-form')}
              onDone={close}
            />
          ) : null}
          {view === 'repo-new-form' ? (
            <RepoNewForm
              agentId={agentId}
              onBack={() => setView('repo-menu')}
              onDone={close}
            />
          ) : null}
          {view === 'llm-menu' ? (
            <LlmPicker
              agentId={agentId}
              onBack={() => setView('menu')}
              onCreateNew={() => setView('llm-new-form')}
              onDone={close}
            />
          ) : null}
          {view === 'llm-new-form' ? (
            <LlmNewForm
              agentId={agentId}
              onBack={() => setView('llm-menu')}
              onDone={close}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ─── Menu ────────────────────────────────────────────────────────────────

function MenuView({
  onPick,
  hasRepos,
  hasLlms,
}: {
  onPick: (v: View) => void
  hasRepos: boolean
  hasLlms: boolean
}) {
  return (
    <>
      <QaHeader title="Add to agent" />
      <nav className="qa-menu">
        <MenuItem
          label="Add skill"
          hint="Markdown fragment prepended to the system prompt"
          icon="S"
          tint="skill"
          onClick={() => onPick('skill-form')}
        />
        <MenuItem
          label="Add tool"
          hint="Named callable the agent can invoke"
          icon="T"
          tint="tool"
          onClick={() => onPick('tool-form')}
        />
        <MenuItem
          label="Attach repo"
          hint={hasRepos ? 'Pick or add a new repository' : 'Clone a new Git repo'}
          icon="R"
          tint="repo"
          onClick={() => onPick('repo-menu')}
        />
        <MenuItem
          label="Assign LLM"
          hint={hasLlms ? 'Pick or add a new provider' : 'Configure an LLM provider'}
          icon="L"
          tint="llm"
          onClick={() => onPick('llm-menu')}
        />
      </nav>
    </>
  )
}

function MenuItem({
  label,
  hint,
  icon,
  tint,
  onClick,
}: {
  label: string
  hint: string
  icon: string
  tint: 'skill' | 'tool' | 'repo' | 'llm'
  onClick: () => void
}) {
  return (
    <button type="button" className="qa-menu-item" onClick={onClick}>
      <span className={`qa-menu-icon qa-menu-icon-${tint}`}>{icon}</span>
      <span className="qa-menu-body">
        <span className="qa-menu-label">{label}</span>
        <span className="qa-menu-hint">{hint}</span>
      </span>
      <span className="qa-menu-chev" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

// ─── Skill form ──────────────────────────────────────────────────────────

function SkillForm({
  agentId,
  onBack,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onDone: () => void
}) {
  const { createSkill } = useWorkspace()
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const input = {
      name: name.trim(),
      markdownBody: body.length ? body : undefined,
    }
    const parsed = skillCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid skill')
      return
    }
    setBusy(true)
    try {
      await createSkill(agentId, parsed.data)
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create skill',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, body, createSkill, name, onDone])

  return (
    <form
      className="qa-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <QaHeader title="Add skill" onBack={onBack} />
      <label className="field">
        <span className="field-label">Name</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="code-review"
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Markdown body (optional)</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="You are a meticulous code reviewer…"
          disabled={busy}
        />
      </label>
      {err ? <div className="field-error">{err}</div> : null}
      <QaFormActions
        submitLabel={busy ? 'Adding\u2026' : 'Add skill'}
        busy={busy}
        disabled={name.trim().length === 0}
        onCancel={onBack}
      />
    </form>
  )
}

// ─── Tool form ───────────────────────────────────────────────────────────

function ToolForm({
  agentId,
  onBack,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onDone: () => void
}) {
  const { createTool } = useWorkspace()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ToolKind>('mastra_builtin')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const input = {
      name: name.trim(),
      kind,
      description: description.trim().length ? description.trim() : null,
    }
    const parsed = toolCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid tool')
      return
    }
    setBusy(true)
    try {
      await createTool(agentId, parsed.data)
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create tool',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, createTool, description, kind, name, onDone])

  return (
    <form
      className="qa-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <QaHeader title="Add tool" onBack={onBack} />
      <label className="field">
        <span className="field-label">Name</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="lookup-customer"
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ToolKind)}
          disabled={busy}
        >
          {toolKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Description (optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2_000}
          placeholder="Short summary shown to the LLM"
          disabled={busy}
        />
      </label>
      {err ? <div className="field-error">{err}</div> : null}
      <QaFormActions
        submitLabel={busy ? 'Adding\u2026' : 'Add tool'}
        busy={busy}
        disabled={name.trim().length === 0}
        onCancel={onBack}
      />
    </form>
  )
}

// ─── Repo picker + new form ──────────────────────────────────────────────

function RepoPicker({
  agentId,
  onBack,
  onCreateNew,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onCreateNew: () => void
  onDone: () => void
}) {
  const workspace = useWorkspace()
  const attached = useMemo(() => {
    const ids = new Set<string>()
    for (const a of workspace.agentResources[agentId]?.attachedRepos ?? []) {
      ids.add(a.repo.id)
    }
    return ids
  }, [agentId, workspace.agentResources])
  const available = useMemo(
    () => workspace.repos.filter((r) => !attached.has(r.id)),
    [workspace.repos, attached],
  )

  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const attach = useCallback(
    async (repoId: string) => {
      setErr(null)
      setBusyId(repoId)
      try {
        await workspace.attachRepo(agentId, { repoId })
        onDone()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to attach repo',
        )
      } finally {
        setBusyId(null)
      }
    },
    [agentId, onDone, workspace],
  )

  return (
    <div className="qa-form">
      <QaHeader title="Attach repo" onBack={onBack} />

      {available.length === 0 ? (
        <div className="qa-empty">
          {workspace.repos.length === 0
            ? 'No repos yet.'
            : 'Every repo is already attached.'}
        </div>
      ) : (
        <ul className="qa-list">
          {available.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="qa-list-item"
                onClick={() => void attach(r.id)}
                disabled={busyId !== null}
              >
                <span className="qa-list-primary">{shortRemote(r.remoteUrl)}</span>
                <span className="qa-list-secondary">
                  {r.branch}
                  {busyId === r.id ? ' \u2022 attaching\u2026' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {err ? <div className="field-error">{err}</div> : null}

      <button type="button" className="qa-new-btn" onClick={onCreateNew}>
        <span className="qa-new-plus">+</span>
        New repo
      </button>
    </div>
  )
}

function RepoNewForm({
  agentId,
  onBack,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onDone: () => void
}) {
  const { createRepo, attachRepo } = useWorkspace()
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [pat, setPat] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const input = {
      remoteUrl: remoteUrl.trim(),
      branch: branch.trim() || undefined,
      gitPat: pat.trim()
        ? ({ action: 'set', plaintext: pat.trim() } as const)
        : undefined,
    }
    const parsed = repoCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid repo')
      return
    }
    setBusy(true)
    try {
      const { repo } = await createRepo(parsed.data)
      await attachRepo(agentId, { repoId: repo.id })
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create repo',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, attachRepo, branch, createRepo, onDone, pat, remoteUrl])

  return (
    <form
      className="qa-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <QaHeader title="New repo" onBack={onBack} />
      <label className="field">
        <span className="field-label">Remote URL</span>
        <input
          ref={urlRef}
          className="field-mono"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          maxLength={500}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Branch</span>
        <input
          className="field-mono"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          maxLength={200}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Access token (optional)</span>
        <input
          type="password"
          className="field-mono"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="ghp_…"
          disabled={busy}
          autoComplete="off"
        />
        <span className="field-hint">
          Stored encrypted at rest. Leave blank for public repos.
        </span>
      </label>
      {err ? <div className="field-error">{err}</div> : null}
      <QaFormActions
        submitLabel={busy ? 'Cloning\u2026' : 'Create & attach'}
        busy={busy}
        disabled={remoteUrl.trim().length === 0}
        onCancel={onBack}
      />
    </form>
  )
}

// ─── LLM picker + new form ───────────────────────────────────────────────

function LlmPicker({
  agentId,
  onBack,
  onCreateNew,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onCreateNew: () => void
  onDone: () => void
}) {
  const { llmProviders, agents, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const currentId = agent?.llmProviderId ?? null

  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const assign = useCallback(
    async (providerId: string | null) => {
      setErr(null)
      setBusyId(providerId ?? 'clear')
      try {
        await patchAgent(agentId, { llmProviderId: providerId })
        onDone()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to assign LLM',
        )
      } finally {
        setBusyId(null)
      }
    },
    [agentId, onDone, patchAgent],
  )

  return (
    <div className="qa-form">
      <QaHeader title="Assign LLM" onBack={onBack} />

      {llmProviders.length === 0 ? (
        <div className="qa-empty">No LLM providers yet.</div>
      ) : (
        <ul className="qa-list">
          {llmProviders.map((p) => {
            const active = p.id === currentId
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`qa-list-item${active ? ' active' : ''}`}
                  onClick={() => void assign(p.id)}
                  disabled={busyId !== null}
                >
                  <span className="qa-list-primary">{p.label}</span>
                  <span className="qa-list-secondary">
                    {p.kind}
                    {p.defaultModel ? ` \u2022 ${p.defaultModel}` : ''}
                    {active ? ' \u2022 current' : ''}
                    {busyId === p.id ? ' \u2022 saving\u2026' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {currentId ? (
        <button
          type="button"
          className="qa-clear-btn"
          onClick={() => void assign(null)}
          disabled={busyId !== null}
        >
          Clear current LLM
        </button>
      ) : null}

      {err ? <div className="field-error">{err}</div> : null}

      <button type="button" className="qa-new-btn" onClick={onCreateNew}>
        <span className="qa-new-plus">+</span>
        New LLM provider
      </button>
    </div>
  )
}

function LlmNewForm({
  agentId,
  onBack,
  onDone,
}: {
  agentId: string
  onBack: () => void
  onDone: () => void
}) {
  const { createLlmProvider, patchAgent } = useWorkspace()
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<LlmProviderKind>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const labelRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    labelRef.current?.focus()
  }, [])

  const local = isLocalKind(kind)

  const submit = useCallback(async () => {
    setErr(null)
    const input = {
      label: label.trim(),
      kind,
      baseUrl: local ? baseUrl.trim() || undefined : undefined,
      defaultModel: defaultModel.trim() || undefined,
      apiKey: apiKey.trim()
        ? ({ action: 'set', plaintext: apiKey.trim() } as const)
        : undefined,
    }
    const parsed = llmProviderCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid provider')
      return
    }
    setBusy(true)
    try {
      const prov = await createLlmProvider(parsed.data)
      await patchAgent(agentId, { llmProviderId: prov.id })
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create provider',
      )
    } finally {
      setBusy(false)
    }
  }, [
    agentId,
    apiKey,
    baseUrl,
    createLlmProvider,
    defaultModel,
    kind,
    label,
    local,
    onDone,
    patchAgent,
  ])

  return (
    <form
      className="qa-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <QaHeader title="New LLM provider" onBack={onBack} />
      <label className="field">
        <span className="field-label">Label</span>
        <input
          ref={labelRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="openai-prod"
          maxLength={120}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LlmProviderKind)}
          disabled={busy}
        >
          {llmProviderKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {local ? (
        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            className="field-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            disabled={busy}
          />
          <span className="field-hint">Required for {kind}.</span>
        </label>
      ) : null}
      <label className="field">
        <span className="field-label">Default model (optional)</span>
        <input
          className="field-mono"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="gpt-4.1-mini"
          maxLength={200}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">API key (optional)</span>
        <input
          type="password"
          className="field-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          disabled={busy}
          autoComplete="off"
        />
        <span className="field-hint">Encrypted at rest.</span>
      </label>
      {err ? <div className="field-error">{err}</div> : null}
      <QaFormActions
        submitLabel={busy ? 'Creating\u2026' : 'Create & assign'}
        busy={busy}
        disabled={label.trim().length === 0}
        onCancel={onBack}
      />
    </form>
  )
}

// ─── Shared form atoms ───────────────────────────────────────────────────

function QaHeader({
  title,
  onBack,
}: {
  title: string
  onBack?: () => void
}) {
  return (
    <div className="qa-header">
      {onBack ? (
        <button
          type="button"
          className="qa-back"
          onClick={onBack}
          aria-label="Back"
        >
          ‹
        </button>
      ) : null}
      <span className="qa-title">{title}</span>
    </div>
  )
}

function QaFormActions({
  submitLabel,
  busy,
  disabled,
  onCancel,
}: {
  submitLabel: string
  busy: boolean
  disabled: boolean
  onCancel: () => void
}) {
  return (
    <div className="qa-actions">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={onCancel}
        disabled={busy}
      >
        Cancel
      </button>
      <button
        type="submit"
        className="btn btn-primary btn-sm"
        disabled={busy || disabled}
      >
        {submitLabel}
      </button>
    </div>
  )
}
