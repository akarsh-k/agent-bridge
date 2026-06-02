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
import { useTimeAgo } from '../../../../lib/use-time-ago'

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
  // Vector dimension. embedding providers only (form field hidden
  // otherwise). Stored as a string so the user can clear the input
  // back to "use gitnexus default 384". The save path coerces to
  // number-or-null at submit time. NULL means gitnexus's 384 default;
  // any other value forwards as `GITNEXUS_EMBEDDING_DIMS=<n>` to
  // gitnexus during repo indexing.
  const [embeddingDims, setEmbeddingDims] = useState('')
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
    setEmbeddingDims(
      provider.embeddingDims != null ? String(provider.embeddingDims) : '',
    )
    setApiKey('')
  }

  // Auto-fill `embeddingDims` after a successful embedding-test. The
  // probe reads the actual `data[0].embedding.length` from the
  // upstream response, so the operator never has to look up their
  // model's dimension.
  //
  // We look up the detected dim by the LOCALLY-EDITED `defaultModel`
  // state (not `provider.defaultModel`), because `testCurrentDefault`
  // / chip clicks all run against the local value. Looking up by the
  // saved value misses fills when the operator changes the model
  // input but hasn't saved yet.
  //
  // Behavior:
  //   - empty input → fills silently (operator hasn't typed anything)
  //   - input differs from detected → overwrites + toast
  //     (likely they copy-pasted a wrong number; surfacing the
  //     auto-correct keeps it from being a silent change).
  const probedModel = defaultModel.trim()
  const detectedDim =
    provider?.role === 'embedding' && probedModel
      ? tester.embeddingDimOf(probedModel)
      : undefined
  const [seededDimFor, setSeededDimFor] = useState<string | null>(null)
  if (
    provider &&
    detectedDim !== undefined &&
    seededDimFor !== `${provider.id}:${probedModel}:${detectedDim}`
  ) {
    setSeededDimFor(`${provider.id}:${probedModel}:${detectedDim}`)
    const trimmed = embeddingDims.trim()
    const current = trimmed === '' ? null : Number.parseInt(trimmed, 10)
    if (current !== detectedDim) {
      setEmbeddingDims(String(detectedDim))
      if (current !== null) {
        toast.success(
          `Detected ${detectedDim}-dim vectors from ${probedModel} (was ${current}). Save to apply.`,
        )
      } else {
        toast.success(
          `Detected ${detectedDim}-dim vectors from ${probedModel}. Save to apply.`,
        )
      }
    }
  }

  const isLocal = useMemo(
    () => (provider ? LOCAL_KINDS.has(provider.kind) : false),
    [provider],
  )
  const isEmbedding = provider?.role === 'embedding'

  // Build the model dropdown filtered by the row's role — chat-role
  // shows chat-capable models, embedding-role shows embedding-capable
  // models. Always include the currently-selected value even if it's
  // no longer in the cached list so a legacy value doesn't disappear.
  const modelOpts: DropdownOption[] = useMemo(() => {
    if (!provider) return []
    const cached = provider.models?.models ?? []
    const filtered = cached.filter((m) =>
      provider.role === 'embedding'
        ? isEmbeddingCapable(m, provider.kind)
        : isChatCapable(m, provider.kind),
    )
    const opts: DropdownOption[] = filtered.map((m) => ({
      value: m,
      label: m,
      monoLabel: true,
      sub:
        provider.kind === 'openai'
          ? provider.role === 'embedding'
            ? 'embedding'
            : categorizeOpenAIModel(m).toLowerCase()
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
    opts.unshift({
      value: '',
      label: '(none — no model selected)',
    })
    return opts
  }, [provider, defaultModel])

  const modelStale = useMemo(() => {
    if (!provider) return false
    const v = defaultModel.trim()
    if (!v) return false
    const cached = (provider.models?.models ?? []).filter((m) =>
      provider.role === 'embedding'
        ? isEmbeddingCapable(m, provider.kind)
        : isChatCapable(m, provider.kind),
    )
    return !cached.includes(v)
  }, [provider, defaultModel])

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
    if (isLocal && (baseUrl.trim() || null) !== (provider.baseUrl ?? null)) {
      return true
    }
    if ((defaultModel.trim() || null) !== (provider.defaultModel ?? null)) {
      return true
    }
    // Embedding dims dirty check. parsed from the trimmed input string
    // to avoid `'1024' !== 1024` false positives.
    if (isEmbedding) {
      const trimmed = embeddingDims.trim()
      const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10)
      const stored = provider.embeddingDims ?? null
      if (parsed !== stored) return true
    }
    if (apiKey.trim() !== '') return true
    return false
  }, [
    provider,
    label,
    baseUrl,
    isLocal,
    defaultModel,
    isEmbedding,
    embeddingDims,
    apiKey,
  ])

  // Re-tick "Catalog refreshed Xs ago" labels on a timer so the value
  // doesn't lie to anyone reading the page for several minutes. Hook
  // call must run on every render (Rules of Hooks) — derive the Date
  // up here and let the hook handle the not-yet-fetched / no-provider
  // cases with a null input.
  const fetchedAtDate = provider?.models?.fetchedAt
    ? new Date(provider.models.fetchedAt)
    : null
  const catalogRefreshedLabel = useTimeAgo(fetchedAtDate, {
    compact: true,
    fallback: '—',
  })

  if (!provider) return <NotFound />

  const discard = () => {
    setLabel(provider.label)
    setBaseUrl(provider.baseUrl ?? '')
    setDefaultModel(provider.defaultModel ?? '')
    setEmbeddingDims(
      provider.embeddingDims != null ? String(provider.embeddingDims) : '',
    )
    setApiKey('')
  }

  const save = async () => {
    // Wipe trigger: this row is the embedding provider AND its model
    // is moving to a different value. Old vectors live in the previous
    // model's geometry — they're orphaned the moment the model
    // changes. Confirm with the user before wiping.
    const oldModel = (provider.defaultModel ?? '').trim()
    const newModel = defaultModel.trim()
    const embeddingModelChanging =
      provider.role === 'embedding' && oldModel !== newModel

    let wipeSemanticVectors = false
    if (embeddingModelChanging) {
      const recallAgents = agents.filter(
        (a) =>
          a.memoryEnabled &&
          a.memoryConfig &&
          (a.memoryConfig as { semanticRecall?: unknown }).semanticRecall,
      )
      if (recallAgents.length > 0) {
        const ok = await confirmDialog({
          title: 'Change embedding model?',
          body:
            `${recallAgents.length} agent${recallAgents.length === 1 ? '' : 's'} ` +
            `(${recallAgents.map((a) => a.name).join(', ')}) ` +
            `have semantic recall enabled. Switching from ${oldModel || '(none)'} ` +
            `to ${newModel || '(none)'} puts every existing vector in the ` +
            `wrong model's geometry and would produce garbage recall results.\n\n` +
            `Confirm to apply the change and wipe every stored vector. ` +
            `Agents re-embed naturally on subsequent conversations. ` +
            `Working memory and recent-message replay are unaffected.`,
          confirmLabel: 'Change and wipe vectors',
          destructive: true,
        })
        if (!ok) return
      }
      wipeSemanticVectors = true
    }

    setBusy(true)
    try {
      // Parse embedding dims at submit time. Empty input → null
      // (use gitnexus's 384 default). Non-empty + non-numeric or
      // out-of-range → reject before sending so the operator sees a
      // local error instead of a backend 400.
      let embeddingDimsValue: number | null = null
      if (provider.role === 'embedding') {
        const trimmed = embeddingDims.trim()
        if (trimmed.length > 0) {
          const parsed = Number.parseInt(trimmed, 10)
          if (!Number.isFinite(parsed) || parsed < 8 || parsed > 8192) {
            toast.error(
              'Vector dimension must be a whole number between 8 and 8192. Common values: 384, 768, 1024, 1536, 3072.',
            )
            setBusy(false)
            return
          }
          embeddingDimsValue = parsed
        }
      }
      const patch: LlmProviderUpdateInput = {
        label: label.trim(),
        baseUrl: isLocal ? baseUrl.trim() || null : null,
        defaultModel: defaultModel.trim() || null,
        ...(provider.role === 'embedding'
          ? { embeddingDims: embeddingDimsValue }
          : {}),
        ...(apiKey.trim()
          ? { apiKey: { action: 'set', plaintext: apiKey.trim() } as const }
          : {}),
        ...(wipeSemanticVectors ? { wipeSemanticVectors: true } : {}),
      }
      await patchLlmProvider(provider.id, patch)
      setApiKey('')
      toast.success(
        wipeSemanticVectors
          ? 'Provider saved · stored vectors wiped'
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
        const stillThere =
          defaultModel.trim() &&
          newCatalog
            .filter((m) =>
              provider.role === 'embedding'
                ? isEmbeddingCapable(m, provider.kind)
                : isChatCapable(m, provider.kind),
            )
            .includes(defaultModel.trim())
        if (stillThere) {
          void testModel(
            defaultModel.trim(),
            provider.role === 'embedding' ? 'embedding' : 'chat',
          )
        }
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
    void testModel(m, isEmbedding ? 'embedding' : 'chat')
  }
  const headerTestState = tester.stateOf(
    defaultModel,
    isEmbedding ? 'embedding' : 'chat',
  )

  const remove = async () => {
    let body: string
    if (isEmbedding) {
      body =
        'This is the workspace embedding provider. Deleting it wipes ' +
        'every stored vector across the workspace; agents re-embed ' +
        'naturally on subsequent conversations once a new embedding ' +
        'provider is configured. This cannot be undone.'
    } else {
      const usingNames = dependentAgents
        .slice(0, 3)
        .map((a) => `"${a.name}"`)
        .join(', ')
      body =
        dependentAgents.length === 0
          ? 'No agents are using this provider. Safe to delete.'
          : `${dependentAgents.length} agent${
              dependentAgents.length === 1 ? '' : 's'
            } use this provider${
              dependentAgents.length <= 3
                ? ` (${usingNames})`
                : ` (${usingNames}, …)`
            }. They'll lose their model assignment. This cannot be undone.`
    }
    if (
      !(await confirmDialog({
        title: `Delete provider "${provider.label}"?`,
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
            <Button variant="primary" size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
      <div className="ab-detail-header">
        <div className="ab-detail-glyph ab-glyph ab-glyph-violet">
          {provider.label.charAt(0).toUpperCase()}
        </div>
        <div className="ab-detail-body">
          <h1 className="ab-page-title ab-page-title--no-mb">
            {provider.label}
          </h1>
          <div className="ab-detail-meta">
            <span className="ab-mono">{provider.kind}</span>
            <Pill kind={isEmbedding ? 'accent' : 'neutral'}>
              {isEmbedding ? 'Embedding · workspace' : 'Chat'}
            </Pill>
            {/* Steady state — no `dot` (reserved for live/active
                signals like an in-flight call). */}
            <Pill kind={provider.apiKey.set ? 'success' : 'warn'}>
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
                ? "Pick a chat default first — there's nothing to test against."
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
            Encrypted API key + paste-only rotation. Leave blank to keep the
            current key.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field ab-field-col">
            <label className="ab-field-label" htmlFor="pd-key">
              API key {provider.apiKey.set && '· (already set)'}
            </label>
            <div className="ab-input-row">
              <input
                id="pd-key"
                className="ab-input ab-mono ab-input--flex"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider.apiKey.set ? '••••••••' : 'sk-…'}
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
          <div className="ab-section-title">Model</div>
          <div className="ab-section-sub">
            {isEmbedding
              ? 'The embedding model this provider serves. Used by every workspace consumer of vectors (semantic recall today, repo indexing later).'
              : 'The chat model this provider serves. Agents that pick this provider use this model.'}
          </div>
        </div>
        <div className="ab-field">
          <div className="ab-field-label-row">
            <span className="ab-field-label">
              {isEmbedding ? 'Embedding model' : 'Chat model'}
            </span>
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
          {modelStale && (
            // Persistent advisory — `role="status"` so screen readers
            // don't re-announce on every parent re-render. Bumped from
            // `alert` (transient/just-happened) to `status` (state).
            <div className="ab-stale-warning" role="status">
              <span>
                ⚠ Saved model <code className="ab-mono">{defaultModel}</code>{' '}
                isn't in the current catalog. The endpoint may be running a
                different model than when this was set.
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
              if (v) void testModel(v, isEmbedding ? 'embedding' : 'chat')
            }}
            options={modelOpts}
            placeholder={
              modelOpts.length <= 1
                ? 'No models cached — click Refresh ↻'
                : isEmbedding
                  ? 'Pick an embedding model'
                  : 'Pick a chat model'
            }
            disabled={modelOpts.length === 0}
          />
          <ModelTestStatus
            model={defaultModel}
            state={tester.stateOf(
              defaultModel,
              isEmbedding ? 'embedding' : 'chat',
            )}
            message={tester.messageOf(
              defaultModel,
              isEmbedding ? 'embedding' : 'chat',
            )}
          />
          {provider.models?.fetchedAt && (
            <span
              className="ab-field-help"
              title={new Date(provider.models.fetchedAt).toLocaleString()}
            >
              Catalog refreshed {catalogRefreshedLabel}.
            </span>
          )}
        </div>
      </div>

      {isEmbedding && (
        <div className="ab-card ab-card-pad ab-form-section">
          <div className="ab-section-head">
            <div className="ab-section-title">Vector dimension</div>
            <div className="ab-section-sub">
              How many numbers each embedding vector contains. MUST match what
              your model actually returns — gitnexus crashes during repo
              indexing with{' '}
              <code className="ab-mono">Embedding dimension mismatch</code> if
              this is wrong. Leave empty to use gitnexus's 384 default. Common
              values: <code className="ab-mono">384</code> (default),{' '}
              <code className="ab-mono">768</code> (all-mpnet-base),{' '}
              <code className="ab-mono">1024</code> (BGE-large,
              Qwen3-Embedding-0.6B), <code className="ab-mono">1536</code>{' '}
              (text-embedding-3-small), <code className="ab-mono">3072</code>{' '}
              (text-embedding-3-large).
            </div>
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="pd-embedding-dims">
              Dimension
            </label>
            <input
              id="pd-embedding-dims"
              className="ab-input ab-mono ab-input--narrow"
              type="number"
              min={8}
              max={8192}
              step={1}
              inputMode="numeric"
              value={embeddingDims}
              onChange={(e) => setEmbeddingDims(e.target.value)}
              placeholder="384 (default)"
            />
            <span className="ab-field-help">
              Saved on this provider; forwarded to gitnexus as{' '}
              <code className="ab-mono">GITNEXUS_EMBEDDING_DIMS</code> on every{' '}
              <code className="ab-mono">analyze</code> run.
            </span>
          </div>
        </div>
      )}

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head ab-section-head--row">
          <div className="ab-section-head-body">
            <div className="ab-section-title">Cached models</div>
            <div className="ab-section-sub">
              Snapshot of <code className="ab-mono">/v1/models</code>. Click any
              model to send a one-token test prompt and verify your key +
              endpoint.
            </div>
          </div>
          {provider.models?.fetchedAt && (
            <span
              className="ab-field-help ab-field-help--nowrap"
              title={new Date(provider.models.fetchedAt).toLocaleString()}
            >
              Refreshed {catalogRefreshedLabel}
            </span>
          )}
        </div>
        {provider.models && provider.models.models.length > 0 ? (
          <>
            <div className="ab-field ab-field--mb">
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
                No models match "{modelSearch}".
              </div>
            ) : (
              <div className="ab-model-groups">
                {groupedModels.map(([groupName, models]) => {
                  const isReadOnlyGroup =
                    READONLY_GRID_CATEGORIES.has(groupName)
                  return (
                    <div key={groupName || 'all'}>
                      {groupName && (
                        <div className="ab-model-group-label">
                          {groupName}{' '}
                          <span className="ab-model-group-count">
                            ({models.length})
                          </span>
                        </div>
                      )}
                      <div className="ab-model-chip-grid">
                        {models.map((m) => {
                          const isDefault = provider.defaultModel === m
                          const flagClass = isDefault ? ' is-default' : ''

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
                              </div>
                            )
                          }

                          // Capability is determined by the row's role —
                          // chat-role rows test against chat-completions,
                          // embedding-role rows against /v1/embeddings.
                          const capability: 'chat' | 'embedding' =
                            provider.role === 'embedding' ? 'embedding' : 'chat'
                          const state = tester.stateOf(m, capability)
                          const msg = tester.messageOf(m, capability)
                          const stateClass =
                            state === 'ok'
                              ? ' is-passed'
                              : state === 'error'
                                ? ' is-failed'
                                : ''
                          // Per-chip "Set as default" affordance —
                          // promotes the chip to this row's `default_model`.
                          const promote = !isDefault
                            ? {
                                glyph: '★',
                                title: `Use ${m} as this provider's model`,
                                handler: () => setDefaultModel(m),
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
            No models cached yet. Hit <strong>Refresh models</strong> after
            setting a key.
          </div>
        )}
      </div>

      {/* Bottom action row — duplicates the sticky save banner above
          for users who scroll-to-end-then-commit by habit. Both spots
          call the same handlers. Delete stays on the left, away from
          the primary save action. */}
      <div className="ab-detail-footer">
        <Button variant="danger" onClick={remove} disabled={busy}>
          Delete provider
        </Button>
        <div className="ab-page-actions">
          <Button variant="ghost" onClick={discard} disabled={busy || !isDirty}>
            Discard
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !isDirty}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <div className="ab-page">
      <div className="ab-card ab-card-pad">
        <div className="ab-section-title">Provider not found</div>
        <div className="ab-section-sub ab-section-sub--mt">
          Provider may have been deleted.
        </div>
        <div className="ab-not-found-action">
          <Link to="/library/providers" className="ab-btn ab-btn-secondary">
            Back to providers
          </Link>
        </div>
      </div>
    </div>
  )
}
