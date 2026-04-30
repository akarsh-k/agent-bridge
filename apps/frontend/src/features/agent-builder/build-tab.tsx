/**
 * Profile section — Identity + Model. Auto-saves via patchAgent
 * with the standard 800ms debounce. Lives at the top of the
 * Configure tab; attached resources moved to ResourcesPanel which
 * powers the Resources tab.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

export function BuildTab({ agentId }: { agentId: string }) {
  const { agents, llmProviders, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)

  // We track the agent id we've reset for; whenever it changes we
  // re-seed the form via the "adjust state based on props" pattern.
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)

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
    </div>
  )
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
