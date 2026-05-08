/**
 * Profile section — Identity + Provider. Identity auto-saves on the
 * 800ms debounce; provider commits via an explicit Save (since the
 * change can affect cost/behavior). The agent does not own a model
 * field — the chosen provider's `defaultModel` is what runs.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Button } from '../../ui/button'
import { ContextBudgetCard } from './context-budget-card'

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

  // ─── Debounced auto-save ──────────────────────────────────────────
  // Identity fields auto-save 800ms after the last edit. Provider
  // change is manual-save (cost/behavior implications).
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
    }),
    [name, slug, systemPrompt, providerId],
  )

  // Identity fields — auto-saved on the 800ms debounce.
  const isIdentityDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    return (
      draft.name !== agent.name ||
      draft.slug !== agent.slug ||
      draft.systemPrompt !== agent.systemPrompt
    )
  }, [agent, seededFor, draft.name, draft.slug, draft.systemPrompt])

  // Provider — manual save only.
  const isProviderDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    return draft.llmProviderId !== agent.llmProviderId
  }, [agent, seededFor, draft.llmProviderId])

  const [manualSaving, setManualSaving] = useState(false)

  useEffect(() => {
    if (!agent) return
    if (!isIdentityDirty) return
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
        await patchAgent(agent.id, {
          name: draft.name,
          slug: draft.slug,
          systemPrompt: draft.systemPrompt,
        })
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
    queueMicrotask(() => {
      if (!cancelled) setAutoSaveState('pending')
    })
    return () => {
      cancelled = true
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    }
  }, [
    agent,
    isIdentityDirty,
    draft.name,
    draft.slug,
    draft.systemPrompt,
    patchAgent,
  ])

  const manualSaveProvider = async (): Promise<void> => {
    if (!agent) return
    setManualSaving(true)
    try {
      await patchAgent(agent.id, { llmProviderId: providerId })
      toast.success('Provider saved')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Save failed',
      )
    } finally {
      setManualSaving(false)
    }
  }

  const discardProviderChanges = (): void => {
    if (!agent) return
    setProviderId(agent.llmProviderId)
  }

  if (agent && seededFor !== agent.id) {
    setSeededFor(agent.id)
    setName(agent.name)
    setSlug(agent.slug)
    setSystemPrompt(agent.systemPrompt)
    setProviderId(agent.llmProviderId)
  }

  const provider = useMemo(
    () => llmProviders.find((p) => p.id === providerId) ?? null,
    [llmProviders, providerId],
  )

  // Only chat-role providers are listed. Embedding providers serve
  // `/v1/embeddings` only, so they can't answer chat completions.
  const providerOpts: DropdownOption[] = useMemo(
    () =>
      llmProviders
        .filter((p) => p.role === 'chat')
        .map((p) => {
          const hasModel = !!p.defaultModel
          const needsKey = !p.apiKey.set && !LOCAL_KINDS.has(p.kind)
          const disabled = !hasModel || needsKey
          return {
            value: p.id,
            label: p.label,
            sub: p.defaultModel ?? `${p.kind} · no model set`,
            disabled,
            disabledReason: !hasModel
              ? 'Provider has no model set — pick one in Library'
              : needsKey
                ? 'No API key set on this provider'
                : undefined,
          }
        }),
    [llmProviders],
  )

  if (!agent) return null

  return (
    <div>
      {isProviderDirty && (
        <div className="ab-save-bar">
          <span className="ab-save-bar-status">
            <span className="ab-pulse-dot" aria-hidden />
            Unsaved provider change
          </span>
          <div className="ab-save-bar-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={discardProviderChanges}
              disabled={manualSaving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void manualSaveProvider()}
              disabled={manualSaving}
            >
              {manualSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
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
          {autoSaveState === 'idle' && !isIdentityDirty && savedAt !== null && (
            <SavedAgo since={savedAt} />
          )}
          {autoSaveState === 'idle' && !isIdentityDirty && savedAt === null && (
            <span>All changes saved.</span>
          )}
        </div>
      </div>

      {/* Provider */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Provider</div>
          <div className="ab-section-sub">
            Which provider answers chat for this agent. The provider's{' '}
            <code className="ab-mono">defaultModel</code> is what runs —
            change it on the provider page if you want a different model.
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
            {provider && (
              <span className="ab-field-help">
                Model:{' '}
                <code className="ab-mono">
                  {provider.defaultModel ?? '(not set)'}
                </code>
              </span>
            )}
          </div>
        </div>
        {isProviderDirty && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              alignItems: 'center',
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={discardProviderChanges}
              disabled={manualSaving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void manualSaveProvider()}
              disabled={manualSaving}
            >
              {manualSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </div>

      <ContextBudgetCard agentId={agentId} />
    </div>
  )
}


function SavedAgo({ since }: { since: number }) {
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
