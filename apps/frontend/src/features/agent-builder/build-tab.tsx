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
import { confirmDialog } from '../../ui/dialog-store'
import { ApiError } from '../../lib/rpc'
import {
  categorizeOpenAIModel,
  isChatCapable,
} from '../../lib/model-categories'
import { ModelTestStatus } from '../agent-tools/model-test-status'
import { useModelTester } from '../../lib/use-model-tester'
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
  const [model, setModel] = useState<string | null>(null)
  // Set when the user confirmed (via dialog) that switching the
  // provider should wipe stale semantic vectors. Cleared after the
  // next successful save so a follow-up edit doesn't accidentally
  // wipe again.
  const [pendingWipe, setPendingWipe] = useState(false)
  // Shared test machinery — owns per-model state + clears the cache
  // when providerId flips so OpenAI test results don't carry into a
  // local-Ollama run after the user switches providers.
  const tester = useModelTester(providerId)

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
      ...(pendingWipe ? { wipeSemanticVectors: true as const } : {}),
    }),
    [name, slug, systemPrompt, providerId, model, pendingWipe],
  )

  /**
   * Wraps the provider Dropdown's onChange with a guard: when the
   * user is moving an agent that has stored semantic vectors to a
   * provider with a different (or no) embedding model, those vectors
   * are about to become unusable garbage. Confirm with the user
   * BEFORE accepting the dropdown change so the auto-save effect
   * doesn't silently kick off the wipe-then-save cascade.
   */
  const handleProviderChange = async (next: string | null) => {
    if (!agent) {
      setProviderId(next)
      return
    }
    const oldId = agent.llmProviderId
    if (next === oldId) {
      setProviderId(next)
      return
    }
    const recallEnabled =
      agent.memoryEnabled &&
      !!agent.memoryConfig &&
      !!(agent.memoryConfig as { semanticRecall?: unknown }).semanticRecall
    const oldEmbed = oldId
      ? llmProviders.find((p) => p.id === oldId)?.defaultEmbeddingModel ?? null
      : null
    const newEmbed = next
      ? llmProviders.find((p) => p.id === next)?.defaultEmbeddingModel ?? null
      : null
    if (recallEnabled && oldEmbed && oldEmbed !== newEmbed) {
      const ok = await confirmDialog({
        title: 'Switch provider?',
        body:
          `This agent has semantic recall enabled with embedding model ` +
          `${oldEmbed}. The new provider uses ${newEmbed ?? '(none)'}, ` +
          `so the agent's stored vectors are about to live in the wrong ` +
          `vector space — they'd produce irrelevant recall results.\n\n` +
          `Confirm to switch and wipe this agent's stored vectors. ` +
          `The agent re-embeds naturally on subsequent conversations. ` +
          `Working memory and recent-message replay are unaffected.`,
        confirmLabel: 'Switch and wipe vectors',
        destructive: true,
      })
      if (!ok) return
      setPendingWipe(true)
    }
    setProviderId(next)
  }

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
          // Clear the wipe flag so a subsequent edit doesn't
          // accidentally re-send it on a save that has nothing to do
          // with the provider change.
          setPendingWipe(false)
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
    setPendingWipe(false)
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
  const modelOpts: DropdownOption[] = useMemo(() => {
    if (!provider) return []
    // Only chat-capable models — agents talk via /v1/chat/completions,
    // so picking an embedding/audio/image model here would 404 at run
    // time. For local providers no filtering — the model id is
    // arbitrary and we don't second-guess it.
    const filtered = cachedModels.filter((m) => isChatCapable(m, provider.kind))
    const opts: DropdownOption[] = filtered.map((m) => ({
      value: m,
      label: m,
      monoLabel: true,
      sub:
        provider.kind === 'openai'
          ? categorizeOpenAIModel(m).toLowerCase()
          : undefined,
    }))
    // Preserve a legacy / non-cataloged value the agent already uses
    // so it doesn't silently disappear from the dropdown.
    if (model && !filtered.includes(model)) {
      opts.unshift({
        value: model,
        label: model,
        monoLabel: true,
        sub: 'current value (not in catalog)',
      })
    }
    return opts
  }, [provider, cachedModels, model])

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
              onChange={(v) => void handleProviderChange(v)}
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
              onChange={(v) => {
                setModel(v)
                // Auto-test on user change so the operator sees
                // pass/fail right next to the dropdown — same pattern
                // as the provider page's model dropdowns. Skip when
                // the value clears or the change isn't user-driven.
                if (v) void tester.test(v)
              }}
              options={modelOpts}
              placeholder={providerId ? 'Pick a model' : 'Pick a provider first'}
              disabled={!providerId || modelOpts.length === 0}
            />
            <ModelTestStatus
              model={model ?? ''}
              state={tester.stateOf(model)}
              message={tester.messageOf(model)}
            />
          </div>
        </div>
      </div>

      <ContextBudgetCard agentId={agentId} />
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
