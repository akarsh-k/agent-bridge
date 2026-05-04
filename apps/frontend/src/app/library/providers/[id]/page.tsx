/**
 * Provider detail page. Edit identity, rotate the API key, set
 * defaults, refresh the cached models list, and run a live test.
 */

import { useMemo, useState } from 'react'
import type { LlmProviderUpdateInput } from '@agent-bridge/shared'
import { useWorkspace } from '../../../../lib/workspace-context'
import { Link } from '../../../../lib/link'
import { navigate } from '../../../../lib/router'
import { Button } from '../../../../ui/button'
import { Pill } from '../../../../ui/pill'
import { Dropdown, type DropdownOption } from '../../../../ui/dropdown'
import { ApiError, refreshLlmProviderModels } from '../../../../lib/rpc'
import { toast } from '../../../../ui/toast-store'
import { confirmDialog } from '../../../../ui/dialog-store'
import { useDefaultProviderId } from '../../../../lib/use-default-provider'
import {
  categorizeOpenAIModel,
  isChatCapable,
  isEmbeddingCapable,
} from '../../../../lib/model-categories'
import { ModelTestStatus } from '../../../../features/agent-tools/model-test-status'
import { useModelTester } from '../../../../lib/use-model-tester'

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

/**
 * Categories rendered as read-only (untestable) on the cached-models
 * grid. Mirrors NON_CHAT_CATEGORIES from the shared categorizer EXCEPT
 * Embeddings — those ARE testable here because we now route them
 * through the /v1/embeddings probe.
 */
const READONLY_GRID_CATEGORIES = new Set([
  'Image generation',
  'Audio transcription',
  'Audio synthesis',
  'Moderation',
  'Realtime',
  'Legacy completions',
])

/** Verb-slot label for a read-only chip. Short so it doesn't push
 *  the model name out of the visible chip width. */
function readonlyVerbFor(category: string): string {
  if (category === 'Image generation') return 'Image'
  if (category === 'Audio transcription') return 'Audio'
  if (category === 'Audio synthesis') return 'Audio'
  if (category === 'Moderation') return 'Mod'
  if (category === 'Realtime') return 'Realtime'
  if (category === 'Legacy completions') return 'Legacy'
  return 'Info'
}

export function ProviderDetailPage({ id }: { id: string }) {
  const {
    agents,
    llmProviders,
    patchLlmProvider,
    patchLlmProviderModels,
    removeLlmProvider,
  } = useWorkspace()
  const provider = llmProviders.find((p) => p.id === id)
  const dependentAgents = useMemo(
    () => agents.filter((a) => a.llmProviderId === id),
    [agents, id],
  )

  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultEmbeddingModel, setDefaultEmbeddingModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const { defaultProviderId, setDefaultProviderId } = useDefaultProviderId()
  const tester = useModelTester(provider?.id ?? null)

  if (provider && seededFor !== provider.id) {
    setSeededFor(provider.id)
    setLabel(provider.label)
    setBaseUrl(provider.baseUrl ?? '')
    setDefaultModel(provider.defaultModel ?? '')
    setDefaultEmbeddingModel(provider.defaultEmbeddingModel ?? '')
    setApiKey('')
  }

  const isLocal = useMemo(
    () => (provider ? LOCAL_KINDS.has(provider.kind) : false),
    [provider],
  )

  // Build dropdown options for the two model fields, filtered by
  // capability so the user can't accidentally pick (say) an embedding
  // model as the chat default. Always include the currently-selected
  // value as an option even if it's no longer in the cached list, so
  // legacy values don't silently disappear from the form.
  const chatModelOpts: DropdownOption[] = useMemo(() => {
    if (!provider) return []
    const cached = provider.models?.models ?? []
    const filtered = cached.filter((m) => isChatCapable(m, provider.kind))
    const opts: DropdownOption[] = filtered.map((m) => ({
      value: m,
      label: m,
      monoLabel: true,
      sub:
        provider.kind === 'openai'
          ? categorizeOpenAIModel(m).toLowerCase()
          : undefined,
    }))
    if (defaultModel && !filtered.includes(defaultModel)) {
      opts.unshift({
        value: defaultModel,
        label: defaultModel,
        monoLabel: true,
        sub: 'stale — not in current catalog',
      })
    }
    // Sentinel that maps to empty/null so the operator can clear the
    // chat default without picking a different model. Mirrors the
    // embedding-side sentinel a few blocks below.
    opts.unshift({
      value: '',
      label: '(none — no provider-level default)',
    })
    return opts
  }, [provider, defaultModel])

  const embeddingModelOpts: DropdownOption[] = useMemo(() => {
    if (!provider) return []
    const cached = provider.models?.models ?? []
    const filtered = cached.filter((m) => isEmbeddingCapable(m, provider.kind))
    const opts: DropdownOption[] = filtered.map((m) => ({
      value: m,
      label: m,
      monoLabel: true,
      sub: provider.kind === 'openai' ? 'embedding' : undefined,
    }))
    if (
      defaultEmbeddingModel &&
      !filtered.includes(defaultEmbeddingModel)
    ) {
      opts.unshift({
        value: defaultEmbeddingModel,
        label: defaultEmbeddingModel,
        monoLabel: true,
        sub: 'stale — not in current catalog',
      })
    }
    // Sentinel that maps to empty/null so the user can disable
    // semantic recall via the same dropdown — empty string saves as
    // null in the patch step.
    opts.unshift({
      value: '',
      label: '(none — disable semantic recall)',
    })
    return opts
  }, [provider, defaultEmbeddingModel])

  // Stale-default detection. The saved default lives in the form
  // state (`defaultModel` / `defaultEmbeddingModel`); we cross-check
  // it against the current chat-/embedding-capable cached lists. A
  // stale default — set to a model the provider no longer advertises
  // (gemma user with `llama-3.1` still saved) — is silently selectable
  // in the dropdown, which has bitten us. Surfacing it as a warning
  // banner above the dropdown lets the operator one-click clear or
  // re-pick. Whitespace-only values count as "no default", not stale.
  const chatModelStale = useMemo(() => {
    if (!provider) return false
    const v = defaultModel.trim()
    if (!v) return false
    const cachedChat = (provider.models?.models ?? []).filter((m) =>
      isChatCapable(m, provider.kind),
    )
    return !cachedChat.includes(v)
  }, [provider, defaultModel])

  const embeddingModelStale = useMemo(() => {
    if (!provider) return false
    const v = defaultEmbeddingModel.trim()
    if (!v) return false
    const cachedEmbedding = (provider.models?.models ?? []).filter((m) =>
      isEmbeddingCapable(m, provider.kind),
    )
    return !cachedEmbedding.includes(v)
  }, [provider, defaultEmbeddingModel])

  // Group + filter the cached model list. For openai we bucket by family
  // heuristic (so the user can scan a 50+ model catalog without
  // scrolling); for any other provider we leave it flat — local model
  // names are arbitrary and the user knows what they pulled in.
  const groupedModels = useMemo(() => {
    const all = provider?.models?.models ?? []
    const q = modelSearch.trim().toLowerCase()
    const filtered = q ? all.filter((m) => m.toLowerCase().includes(q)) : all
    if (provider?.kind !== 'openai') {
      return filtered.length > 0 ? [['', filtered] as const] : []
    }
    const groups = new Map<string, string[]>()
    for (const m of filtered) {
      const cat = categorizeOpenAIModel(m)
      const arr = groups.get(cat) ?? []
      arr.push(m)
      groups.set(cat, arr)
    }
    const order = [
      'GPT-4 family',
      'Reasoning (o-series)',
      'GPT-3.5 family',
      'Other',
      'Image generation',
      'Audio transcription',
      'Audio synthesis',
      'Realtime',
      'Moderation',
      'Embeddings',
      'Legacy completions',
    ]
    return order
      .map((cat) => [cat, groups.get(cat) ?? []] as const)
      .filter(([, arr]) => arr.length > 0)
  }, [provider?.models, provider?.kind, modelSearch])

  // Field-by-field comparison against the saved row. The sticky save
  // banner above the form (and the duplicate save row at the bottom)
  // both key off this — visible when anything is out of sync with
  // what's persisted, hidden when the form matches (or after Discard
  // reverts everything). API key is "dirty" the moment the operator
  // types anything since the field is always empty on load (we never
  // echo the saved key).
  //
  // NOTE: this hook MUST run before the `if (!provider)` early return
  // below or React complains about a conditional hook call. Provider
  // being undefined here just yields `false` (nothing to be dirty
  // about).
  const isDirty = useMemo(() => {
    if (!provider) return false
    if (label.trim() !== (provider.label ?? '').trim()) return true
    if (
      isLocal &&
      (baseUrl.trim() || null) !== (provider.baseUrl ?? null)
    ) {
      return true
    }
    if ((defaultModel.trim() || null) !== (provider.defaultModel ?? null)) {
      return true
    }
    if (
      (defaultEmbeddingModel.trim() || null) !==
      (provider.defaultEmbeddingModel ?? null)
    ) {
      return true
    }
    if (apiKey.trim() !== '') return true
    return false
  }, [
    provider,
    label,
    baseUrl,
    isLocal,
    defaultModel,
    defaultEmbeddingModel,
    apiKey,
  ])

  if (!provider) return <NotFound />

  const discard = () => {
    setLabel(provider.label)
    setBaseUrl(provider.baseUrl ?? '')
    setDefaultModel(provider.defaultModel ?? '')
    setDefaultEmbeddingModel(provider.defaultEmbeddingModel ?? '')
    setApiKey('')
  }

  const save = async () => {
    // Detect whether the embedding model is actually flipping. If yes
    // AND there are agents using this provider with semantic recall
    // already enabled, those agents have stored vectors in the
    // CURRENT model's vector space — switching the model invalidates
    // them. Confirm with the user, then send wipeSemanticVectors: true
    // so the backend cascades the wipe.
    const oldEmbed = (provider.defaultEmbeddingModel ?? '').trim()
    const newEmbed = defaultEmbeddingModel.trim()
    const embeddingChanged = oldEmbed !== newEmbed
    const recallAgents = dependentAgents.filter(
      (a) =>
        a.memoryEnabled &&
        a.memoryConfig &&
        (a.memoryConfig as { semanticRecall?: unknown }).semanticRecall,
    )
    let wipeSemanticVectors = false
    if (embeddingChanged && oldEmbed && recallAgents.length > 0) {
      const ok = await confirmDialog({
        title: 'Switch embedding model?',
        body:
          `${recallAgents.length} agent${recallAgents.length === 1 ? '' : 's'} ` +
          `(${recallAgents.map((a) => a.name).join(', ')}) ` +
          `use this provider for semantic recall. ` +
          `Switching from ${oldEmbed} to ${newEmbed || '(none)'} ` +
          `invalidates their stored vectors — old vectors live in the ` +
          `previous model's vector space and would produce irrelevant ` +
          `recall results.\n\n` +
          `Confirm to wipe stored vectors for those agents. They'll ` +
          `re-embed naturally on subsequent conversations. ` +
          `Working memory and recent-message replay are unaffected.`,
        confirmLabel: 'Switch and wipe vectors',
        destructive: true,
      })
      if (!ok) return
      wipeSemanticVectors = true
    }

    setBusy(true)
    try {
      const patch: LlmProviderUpdateInput = {
        label: label.trim(),
        baseUrl: isLocal ? baseUrl.trim() || null : null,
        defaultModel: defaultModel.trim() || null,
        defaultEmbeddingModel: defaultEmbeddingModel.trim() || null,
        ...(apiKey.trim()
          ? { apiKey: { action: 'set', plaintext: apiKey.trim() } as const }
          : {}),
        ...(wipeSemanticVectors ? { wipeSemanticVectors: true } : {}),
      }
      await patchLlmProvider(provider.id, patch)
      setApiKey('')
      toast.success(
        wipeSemanticVectors
          ? 'Provider saved · semantic vectors wiped'
          : 'Provider saved',
      )
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Save failed',
      )
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    if (
      !(await confirmDialog({
        title: 'Clear API key?',
        body: 'Agents using this provider will fail to call until a new key is set.',
        confirmLabel: 'Clear key',
        destructive: true,
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await patchLlmProvider(provider.id, {
        apiKey: { action: 'clear' } as const,
      })
      toast.success('API key cleared')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed',
      )
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      const res = await refreshLlmProviderModels(provider.id)
      if (res.ok) {
        patchLlmProviderModels(provider.id, res.models)
        toast.success(`Refreshed · ${res.models.models.length} models cached`)

        // Auto-validate the saved defaults against the new catalog. Two
        // cases worth distinguishing:
        //  - Default is still present → re-test it. The endpoint may
        //    have flipped (operator switched llama-server's GGUF) so a
        //    silent stale-test could deceive; an explicit re-test
        //    confirms the new endpoint actually serves what we expect.
        //  - Default is gone from the catalog → don't auto-test (it
        //    would just fail). The new `chatModelStale` /
        //    `embeddingModelStale` warnings render automatically based
        //    on the freshly-patched models list.
        const newCatalog = res.models.models
        const chatStillThere =
          defaultModel.trim() &&
          newCatalog
            .filter((m) => isChatCapable(m, provider.kind))
            .includes(defaultModel.trim())
        if (chatStillThere) void testModel(defaultModel.trim(), 'chat')

        const embedStillThere =
          defaultEmbeddingModel.trim() &&
          newCatalog
            .filter((m) => isEmbeddingCapable(m, provider.kind))
            .includes(defaultEmbeddingModel.trim())
        if (embedStillThere)
          void testModel(defaultEmbeddingModel.trim(), 'embedding')
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
      setRefreshing(false)
    }
  }

  // Local alias kept so the existing call sites read naturally.
  // The actual state + side effects live in the hook.
  const testModel = tester.test

  // Header "Test connection" button now routes through the same
  // per-model tester the dropdown + chip grid use, so the result
  // is reflected on every surface that displays it instead of
  // living in a parallel state dict that nothing else can see.
  // Disabled when the operator hasn't picked a chat default yet —
  // there's nothing concrete to test.
  const testCurrentDefault = () => {
    const m = defaultModel.trim()
    if (!m) return
    void testModel(m, 'chat')
  }
  const headerTestState = tester.stateOf(defaultModel, 'chat')

  const remove = async () => {
    const usingNames = dependentAgents
      .slice(0, 3)
      .map((a) => `“${a.name}”`)
      .join(', ')
    const body =
      dependentAgents.length === 0
        ? 'No agents are using this provider. Safe to delete.'
        : `${dependentAgents.length} agent${
            dependentAgents.length === 1 ? '' : 's'
          } use this provider${
            dependentAgents.length <= 3 ? ` (${usingNames})` : ` (${usingNames}, …)`
          }. They'll lose their model assignment. This cannot be undone.`
    if (
      !(await confirmDialog({
        title: `Delete provider “${provider.label}”?`,
        body,
        confirmLabel: 'Delete provider',
        confirmText: dependentAgents.length > 0 ? provider.label : undefined,
        confirmDelaySec: dependentAgents.length > 0 ? 2 : undefined,
        destructive: true,
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await removeLlmProvider(provider.id)
      toast.success('Provider deleted')
      navigate('/library/providers')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ab-page">
      <Link to="/library/providers" className="ab-back-link">
        Back to LLM providers
      </Link>
      {isDirty && (
        <div className="ab-save-bar">
          <span className="ab-save-bar-status">
            <span className="ab-pulse-dot" aria-hidden />
            Unsaved changes
          </span>
          <div className="ab-save-bar-actions">
            <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
      <div className="ab-detail-header">
        <div className="ab-detail-glyph ab-glyph ab-glyph-violet">
          {provider.label.charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ab-page-title" style={{ marginBottom: 0 }}>
            {provider.label}
          </h1>
          <div className="ab-detail-meta">
            <span className="ab-mono">{provider.kind}</span>
            <span>·</span>
            <Pill kind={provider.apiKey.set ? 'success' : 'warn'} dot>
              {provider.apiKey.set ? 'Key set' : 'No key'}
            </Pill>
            <Pill kind="neutral">
              {provider.models?.models.length ?? 0} models
            </Pill>
          </div>
        </div>
        <div className="ab-page-actions">
          {defaultProviderId === provider.id ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDefaultProviderId(null)
                toast.success('No longer pre-selected for new agents')
              }}
              title="Currently pre-selected when creating a new agent. Click to unset."
            >
              ★ Default for new agents
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                setDefaultProviderId(provider.id)
                toast.success(
                  `${provider.label} will be pre-selected for new agents`,
                )
              }}
              title="Pre-select this provider when creating a new agent (browser-local)."
            >
              Use as default for new agents
            </Button>
          )}
          <Button variant="secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh models'}
          </Button>
          <Button
            variant="primary"
            onClick={testCurrentDefault}
            disabled={!defaultModel.trim() || headerTestState === 'pending'}
            title={
              !defaultModel.trim()
                ? 'Pick a chat default first — there\'s nothing to test against.'
                : `Send a one-token chat to ${defaultModel} to verify the endpoint.`
            }
          >
            {headerTestState === 'pending' ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </div>

      {/* No floating result pill anymore — the per-model status pill in
          the Defaults section already shows pass/fail for the same
          model. Single source of truth keeps the surfaces in sync. */}

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Identity</div>
          <div className="ab-section-sub">
            How the provider shows up in agent pickers.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="pd-label">
              Label
            </label>
            <input
              id="pd-label"
              className="ab-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="ab-field">
            <span className="ab-field-label">Kind</span>
            <input
              className="ab-input ab-mono"
              value={provider.kind}
              disabled
            />
          </div>
          {isLocal && (
            <div className="ab-field ab-field-col">
              <label className="ab-field-label" htmlFor="pd-baseurl">
                Base URL
              </label>
              <input
                id="pd-baseurl"
                className="ab-input ab-mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
            </div>
          )}
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Connection</div>
          <div className="ab-section-sub">
            Encrypted API key + paste-only rotation. Leave blank to keep
            the current key.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field ab-field-col">
            <label className="ab-field-label" htmlFor="pd-key">
              API key {provider.apiKey.set && '· (already set)'}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="pd-key"
                className="ab-input ab-mono"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider.apiKey.set ? '••••••••' : 'sk-…'}
                style={{ flex: 1 }}
              />
              {provider.apiKey.set && (
                <Button variant="ghost" onClick={clearKey} disabled={busy}>
                  Clear
                </Button>
              )}
            </div>
            <span className="ab-field-help">
              Encrypted at rest with your master key.
            </span>
          </div>
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Provider fallbacks</div>
          <div className="ab-section-sub">
            Per-provider defaults. Each agent picks its own chat model in
            the agent builder; these only apply when an agent attaches
            this provider without overriding. The embedding choice is
            always provider-level — agents inherit it.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <div className="ab-field-label-row">
              <span className="ab-field-label">Default model</span>
              <button
                type="button"
                className="ab-inline-action"
                onClick={refresh}
                disabled={refreshing}
                title="Re-fetch /v1/models from this provider's endpoint."
              >
                {refreshing ? 'Refreshing…' : '↻ Refresh models'}
              </button>
            </div>
            {chatModelStale && (
              <div className="ab-stale-warning" role="alert">
                <span>
                  ⚠ Saved default <code className="ab-mono">{defaultModel}</code>{' '}
                  isn't in the current catalog. The endpoint may be running a
                  different model than when this default was set.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDefaultModel('')}
                  disabled={busy}
                >
                  Clear
                </Button>
              </div>
            )}
            <Dropdown
              value={defaultModel || ''}
              onChange={(v) => {
                setDefaultModel(v ?? '')
                if (v) void testModel(v, 'chat')
              }}
              options={chatModelOpts}
              placeholder={
                chatModelOpts.length <= 1
                  ? 'No models cached — click Refresh ↻'
                  : 'Pick a chat model'
              }
              disabled={chatModelOpts.length === 0}
            />
            <ModelTestStatus
              model={defaultModel}
              state={tester.stateOf(defaultModel, 'chat')}
              message={tester.messageOf(defaultModel, 'chat')}
            />
            <span className="ab-field-help">
              Used as the chat model for any agent on this provider that
              doesn't override it.
              {provider.models?.fetchedAt && (
                <>
                  {' '}
                  <span
                    title={new Date(provider.models.fetchedAt).toLocaleString()}
                  >
                    Catalog refreshed {timeAgo(provider.models.fetchedAt)}.
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="ab-field">
            <div className="ab-field-label-row">
              <span className="ab-field-label">Default embedding model</span>
              <button
                type="button"
                className="ab-inline-action"
                onClick={refresh}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing…' : '↻ Refresh models'}
              </button>
            </div>
            {embeddingModelStale && (
              <div className="ab-stale-warning" role="alert">
                <span>
                  ⚠ Saved embedding default{' '}
                  <code className="ab-mono">{defaultEmbeddingModel}</code> isn't
                  in the current catalog. Stored vectors using this model are
                  still readable, but new embeddings will fail.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDefaultEmbeddingModel('')}
                  disabled={busy}
                >
                  Clear
                </Button>
              </div>
            )}
            <Dropdown
              value={defaultEmbeddingModel || ''}
              onChange={(v) => {
                setDefaultEmbeddingModel(v ?? '')
                if (v) void testModel(v, 'embedding')
              }}
              options={embeddingModelOpts}
              placeholder="Pick an embedding model (optional)"
            />
            <ModelTestStatus
              model={defaultEmbeddingModel}
              state={tester.stateOf(defaultEmbeddingModel, 'embedding')}
              message={tester.messageOf(defaultEmbeddingModel, 'embedding')}
            />
            <span className="ab-field-help">
              Powers semantic-recall memory. Pick (none) to disable
              recall on every agent using this provider.
            </span>
          </div>
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">Cached models</div>
            <div className="ab-section-sub">
              Snapshot of <code className="ab-mono">/v1/models</code>. Click
              any model to send a one-token test prompt and verify your key
              + endpoint.
            </div>
          </div>
          {provider.models?.fetchedAt && (
            <span
              className="ab-field-help"
              style={{ margin: 0, whiteSpace: 'nowrap' }}
              title={new Date(provider.models.fetchedAt).toLocaleString()}
            >
              Refreshed {timeAgo(provider.models.fetchedAt)}
            </span>
          )}
        </div>
        {provider.models && provider.models.models.length > 0 ? (
          <>
            <div className="ab-field" style={{ marginBottom: 12 }}>
              <input
                type="search"
                className="ab-input ab-mono"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder={`Search ${provider.models.models.length} model${provider.models.models.length === 1 ? '' : 's'}…`}
              />
            </div>
            {groupedModels.length === 0 ? (
              <div className="ab-field-help">
                No models match “{modelSearch}”.
              </div>
            ) : (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                {groupedModels.map(([groupName, models]) => {
                  const isReadOnlyGroup = READONLY_GRID_CATEGORIES.has(groupName)
                  return (
                    <div key={groupName || 'all'}>
                      {groupName && (
                        <div
                          style={{
                            marginBottom: 8,
                            fontSize: 11,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {groupName}{' '}
                          <span style={{ opacity: 0.6 }}>
                            ({models.length})
                          </span>
                        </div>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 6,
                        }}
                      >
                        {models.map((m) => {
                          const isDefault = provider.defaultModel === m
                          const isEmbedDefault =
                            provider.defaultEmbeddingModel === m
                          const isFlagged = isDefault || isEmbedDefault
                          const flagClass = isFlagged ? ' is-default' : ''

                          // Read-only chip for embedding/image/audio
                          // categories: provider lists them, but our test
                          // hits /v1/chat/completions which they don't
                          // support. Render as a non-interactive label so
                          // the user understands why it's frozen.
                          if (isReadOnlyGroup) {
                            return (
                              <div
                                key={m}
                                className={`ab-model-chip is-readonly${flagClass}`}
                                title={`${groupName} model — listed by your provider but not callable via the chat-completions endpoint we use for testing.`}
                              >
                                <span className="ab-model-chip-verb">
                                  {readonlyVerbFor(groupName)}
                                </span>
                                <span className="ab-mono">{m}</span>
                                {isDefault && (
                                  <span className="ab-model-chip-default-badge">
                                    default
                                  </span>
                                )}
                                {isEmbedDefault && (
                                  <span className="ab-model-chip-default-badge">
                                    embed default
                                  </span>
                                )}
                              </div>
                            )
                          }

                          const capability: 'chat' | 'embedding' =
                            groupName === 'Embeddings' ? 'embedding' : 'chat'
                          const state = tester.stateOf(m, capability)
                          const msg = tester.messageOf(m, capability)
                          const stateClass =
                            state === 'ok'
                              ? ' is-passed'
                              : state === 'error'
                                ? ' is-failed'
                                : ''
                          // Per-chip "Set as default" affordance. Skipped
                          // for chips that already match the relevant
                          // default; otherwise renders a span-role-button
                          // that promotes the chip to the appropriate
                          // default with stopPropagation so the outer
                          // chip's test-on-click doesn't also fire.
                          const promoteEmbed =
                            capability === 'embedding' && !isEmbedDefault
                          const promoteChat =
                            capability === 'chat' && !isDefault
                          const promote = promoteChat
                            ? {
                                glyph: '★',
                                title: `Make ${m} the default chat model`,
                                handler: () => setDefaultModel(m),
                              }
                            : promoteEmbed
                              ? {
                                  glyph: '✶',
                                  title: `Make ${m} the default embedding model`,
                                  handler: () => setDefaultEmbeddingModel(m),
                                }
                              : null
                          return (
                            <button
                              key={m}
                              type="button"
                              className={`ab-model-chip${stateClass}${flagClass}`}
                              onClick={() => void testModel(m, capability)}
                              disabled={state === 'pending'}
                              title={
                                msg
                                  ? `${state === 'ok' ? 'OK · ' : ''}${msg}`
                                  : capability === 'embedding'
                                    ? `Send a tiny embedding request to ${m}`
                                    : `Send a one-token test prompt to ${m}`
                              }
                            >
                              <span className="ab-model-chip-verb">
                                <span
                                  className="ab-model-chip-verb-icon"
                                  aria-hidden
                                >
                                  {state === 'ok'
                                    ? '✓'
                                    : state === 'error'
                                      ? '✕'
                                      : state === 'pending'
                                        ? '…'
                                        : '▶'}
                                </span>
                                {state === 'ok'
                                  ? 'Passed'
                                  : state === 'error'
                                    ? 'Failed'
                                    : state === 'pending'
                                      ? 'Testing'
                                      : 'Test'}
                              </span>
                              <span className="ab-mono">{m}</span>
                              {isDefault && (
                                <span className="ab-model-chip-default-badge">
                                  default
                                </span>
                              )}
                              {isEmbedDefault && (
                                <span className="ab-model-chip-default-badge">
                                  embed default
                                </span>
                              )}
                              {promote && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  className="ab-model-chip-promote"
                                  title={promote.title}
                                  aria-label={promote.title}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    e.preventDefault()
                                    promote.handler()
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      promote.handler()
                                    }
                                  }}
                                >
                                  {promote.glyph}
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <div className="ab-field-help">
            No models cached yet. Hit{' '}
            <strong>Refresh models</strong> after setting a key.
          </div>
        )}
      </div>

      {/* Bottom action row — duplicates the sticky save banner above
          for users who scroll-to-end-then-commit by habit. Both spots
          call the same handlers. Delete stays on the left, away from
          the primary save action. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Button variant="danger" onClick={remove} disabled={busy}>
          Delete provider
        </Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            onClick={discard}
            disabled={busy || !isDirty}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || !isDirty}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function NotFound() {
  return (
    <div className="ab-page">
      <div className="ab-card ab-card-pad">
        <div className="ab-section-title">Provider not found</div>
        <div className="ab-section-sub" style={{ marginTop: 4 }}>
          Provider may have been deleted.
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="/library/providers" className="ab-btn ab-btn-secondary">
            Back to providers
          </Link>
        </div>
      </div>
    </div>
  )
}
