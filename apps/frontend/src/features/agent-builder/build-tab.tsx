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
import { ApiError, refreshLlmProviderModels } from '../../lib/rpc'
import { Button } from '../../ui/button'
import {
  categorizeOpenAIModel,
  isChatCapable,
} from '../../lib/model-categories'
import { ModelTestStatus } from '../agent-tools/model-test-status'
import { useModelTester } from '../../lib/use-model-tester'
import { ContextBudgetCard } from './context-budget-card'

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

export function BuildTab({ agentId }: { agentId: string }) {
  const { agents, llmProviders, patchAgent, patchLlmProviderModels } =
    useWorkspace()
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
  // In-flight indicator for the inline "Refresh models" button next to
  // the model dropdown. Lets the operator repopulate the catalog
  // without leaving the agent-builder.
  const [refreshingModels, setRefreshingModels] = useState(false)
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
    // Compare against the FORM's current value, not the agent's saved
    // value. Otherwise toggling Provider away from openai (unsaved) and
    // back to whatever-was-saved short-circuits the auto-pick branch
    // and leaves a stale `model` in the form.
    if (next === providerId) return

    // Wipe-vectors confirm only fires when we have a saved agent AND
    // we're actually moving away from the saved provider's embedding
    // setup. Going back to whatever's saved is a no-op for vectors —
    // we'd be returning to the same vector space.
    if (agent) {
      const oldSavedId = agent.llmProviderId
      if (next !== oldSavedId) {
        const recallEnabled =
          agent.memoryEnabled &&
          !!agent.memoryConfig &&
          !!(agent.memoryConfig as { semanticRecall?: unknown }).semanticRecall
        const oldEmbed = oldSavedId
          ? llmProviders.find((p) => p.id === oldSavedId)
              ?.defaultEmbeddingModel ?? null
          : null
        const newEmbed = next
          ? llmProviders.find((p) => p.id === next)?.defaultEmbeddingModel ??
            null
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
      }
    }

    setProviderId(next)

    // Auto-pick a sensible model for the new provider so the operator
    // doesn't land in an "old model still selected, not in new catalog"
    // limbo. Three cases:
    //  - Provider cleared → also clear the model. Without this, the
    //    dropdown's "current value (not in catalog)" entry keeps the
    //    stale string visible.
    //  - New provider's chat-capable catalog includes the current
    //    model → keep it. The operator made a deliberate choice and
    //    it's still valid.
    //  - New provider's catalog doesn't include the current model →
    //    fall back to the new provider's `defaultModel` (or null) and
    //    auto-test so pass/fail surfaces immediately.
    if (!next) {
      setModel(null)
      return
    }
    const nextProvider = llmProviders.find((p) => p.id === next)
    if (!nextProvider) return
    const newCachedChat = (nextProvider.models?.models ?? []).filter((m) =>
      isChatCapable(m, nextProvider.kind),
    )
    const currentStillValid =
      model !== null && model.length > 0 && newCachedChat.includes(model)
    if (currentStillValid) return
    const fallback = nextProvider.defaultModel?.trim() || null
    setModel(fallback)
    // Pass the new provider id explicitly. tester.test's closure
    // still has the previous providerId at this point (React hasn't
    // re-rendered yet), so a naive call would race-test the fallback
    // against the previous provider's endpoint and flip the chip
    // red. The user then has to click again to get a green that
    // wasn't actually wrong about the new endpoint.
    if (fallback) void tester.test(fallback, 'chat', next)
  }

  /**
   * Inline "Refresh models" handler for the model dropdown row. Lifted
   * from the provider-detail page so the operator can re-pull the
   * catalog without leaving the agent-builder. Same patch-into-workspace
   * pattern: on success the dropdown re-renders with the fresh list on
   * the next tick. Errors surface as toasts; soft failures (no key,
   * host unreachable) come back as `{ ok: false, code, message }` and
   * we surface those too — the operator needs to know why their
   * dropdown is empty.
   */
  const refreshModels = async (): Promise<void> => {
    if (!provider) return
    setRefreshingModels(true)
    try {
      const res = await refreshLlmProviderModels(provider.id)
      if (res.ok) {
        patchLlmProviderModels(provider.id, res.models)
        toast.success(
          `Refreshed · ${res.models.models.length} model${res.models.models.length === 1 ? '' : 's'} cached`,
        )
      } else {
        toast.error(res.message ?? `Refresh failed (${res.code})`)
      }
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Refresh failed',
      )
    } finally {
      setRefreshingModels(false)
    }
  }

  // Identity fields — auto-saved on the 800ms debounce. Low-stakes
  // text edits feel snappy this way: type and forget.
  const isIdentityDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    return (
      draft.name !== agent.name ||
      draft.slug !== agent.slug ||
      draft.systemPrompt !== agent.systemPrompt
    )
  }, [agent, seededFor, draft.name, draft.slug, draft.systemPrompt])

  // Model section — provider, model, and the wipe-vectors flag — are
  // manual-save only. These have side effects (cost, behavior change,
  // potential vector wipe) that warrant an explicit Save click rather
  // than a sneaky 800ms debounce.
  const isModelDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    return (
      draft.llmProviderId !== agent.llmProviderId ||
      draft.model !== agent.model ||
      pendingWipe
    )
  }, [agent, seededFor, draft.llmProviderId, draft.model, pendingWipe])

  // In-flight indicator for the manual save (sticky banner + bottom
  // row). Kept separate from the auto-save state machine so the two
  // surfaces don't compete for the same status.
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
        // Only ship identity fields. provider / model / pendingWipe
        // ride on the explicit Save in the sticky banner.
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
  }, [
    agent,
    isIdentityDirty,
    draft.name,
    draft.slug,
    draft.systemPrompt,
    patchAgent,
  ])

  /**
   * Manual save for the Model section. Pushes provider, model, and
   * the wipe-vectors flag (set when the user confirmed via the
   * dialog in `handleProviderChange`) in one patch. Does NOT touch
   * identity fields — those auto-save on their own. After a
   * successful save the wipe flag is cleared so a follow-up edit
   * doesn't accidentally re-wipe.
   */
  const manualSaveModel = async (): Promise<void> => {
    if (!agent) return
    setManualSaving(true)
    try {
      await patchAgent(agent.id, {
        llmProviderId: providerId,
        model,
        ...(pendingWipe ? { wipeSemanticVectors: true as const } : {}),
      })
      setPendingWipe(false)
      toast.success('Model saved')
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

  /**
   * Discard pending Model section changes and revert to whatever's
   * persisted. Identity edits are left alone — they're already
   * saved (or about to be on the next debounce tick).
   */
  const discardModelChanges = (): void => {
    if (!agent) return
    setProviderId(agent.llmProviderId)
    setModel(agent.model)
    setPendingWipe(false)
  }

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
      {isModelDirty && (
        <div className="ab-save-bar">
          <span className="ab-save-bar-status">
            <span className="ab-pulse-dot" aria-hidden />
            Unsaved model changes
          </span>
          <div className="ab-save-bar-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={discardModelChanges}
              disabled={manualSaving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void manualSaveModel()}
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
            <div className="ab-field-label-row">
              <span className="ab-field-label">Model</span>
              {provider && (
                <button
                  type="button"
                  className="ab-inline-action"
                  onClick={() => void refreshModels()}
                  disabled={refreshingModels}
                  title="Re-fetch /v1/models from this provider"
                >
                  {refreshingModels ? 'Refreshing…' : '↻ Refresh models'}
                </button>
              )}
            </div>
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
              placeholder={
                !providerId
                  ? 'Pick a provider first'
                  : modelOpts.length === 0
                    ? 'No models cached — click Refresh ↻'
                    : 'Pick a model'
              }
              disabled={!providerId || modelOpts.length === 0}
            />
            <ModelTestStatus
              model={model ?? ''}
              state={tester.stateOf(model)}
              message={tester.messageOf(model)}
            />
            {provider?.models?.fetchedAt && (
              <span
                className="ab-field-help"
                title={new Date(provider.models.fetchedAt).toLocaleString()}
              >
                Catalog refreshed {timeAgoShort(provider.models.fetchedAt)}.
              </span>
            )}
          </div>
        </div>
        {/* Bottom save row for users who scroll-and-commit. Mirrors the
            sticky banner above; both call the same handlers. Hidden
            when there's nothing to save so the section doesn't carry
            a permanently-visible disabled button. */}
        {isModelDirty && (
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
              onClick={discardModelChanges}
              disabled={manualSaving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void manualSaveModel()}
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


function timeAgoShort(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
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
