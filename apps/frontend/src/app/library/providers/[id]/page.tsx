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
import { ApiError, refreshLlmProviderModels, testLlmProvider } from '../../../../lib/rpc'
import { toast } from '../../../../ui/toast-store'
import { confirmDialog } from '../../../../ui/dialog-store'
import { useDefaultProviderId } from '../../../../lib/use-default-provider'

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

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
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [modelTestState, setModelTestState] = useState<
    Record<string, 'pending' | 'ok' | 'error'>
  >({})
  const [modelTestMsg, setModelTestMsg] = useState<Record<string, string>>({})
  const { defaultProviderId, setDefaultProviderId } = useDefaultProviderId()

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

  if (!provider) return <NotFound />

  const save = async () => {
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
      }
      await patchLlmProvider(provider.id, patch)
      setApiKey('')
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

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testLlmProvider(provider.id, {})
      setTestResult(
        res.ok
          ? `OK · ${res.durationMs}ms${res.model ? ` via ${res.model}` : ''}`
          : `Failed · ${res.message ?? res.code ?? 'unknown'}`,
      )
    } catch (e) {
      setTestResult(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Test failed',
      )
    } finally {
      setTesting(false)
    }
  }

  const testModel = async (model: string) => {
    setModelTestState((s) => ({ ...s, [model]: 'pending' }))
    setModelTestMsg((s) => {
      const next = { ...s }
      delete next[model]
      return next
    })
    try {
      const res = await testLlmProvider(provider.id, { defaultModel: model })
      if (res.ok) {
        setModelTestState((s) => ({ ...s, [model]: 'ok' }))
        setModelTestMsg((s) => ({
          ...s,
          [model]: `${res.durationMs}ms`,
        }))
      } else {
        setModelTestState((s) => ({ ...s, [model]: 'error' }))
        setModelTestMsg((s) => ({
          ...s,
          [model]: res.message ?? res.code,
        }))
      }
    } catch (e) {
      setModelTestState((s) => ({ ...s, [model]: 'error' }))
      setModelTestMsg((s) => ({
        ...s,
        [model]:
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'failed',
      }))
    }
  }

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
          <Button variant="ghost" onClick={() => navigate('/library/providers')}>
            ← Back
          </Button>
          {defaultProviderId === provider.id ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDefaultProviderId(null)
                toast.success('Removed as default')
              }}
            >
              Default ★
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                setDefaultProviderId(provider.id)
                toast.success(`${provider.label} is now the default`)
              }}
            >
              Set as default
            </Button>
          )}
          <Button variant="secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh models'}
          </Button>
          <Button variant="primary" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </div>

      {testResult && (
        <div
          className="ab-card ab-card-pad ab-form-section"
          style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Pill
            kind={testResult.startsWith('OK') ? 'success' : 'danger'}
            dot
          >
            {testResult.startsWith('OK') ? 'Test passed' : 'Test failed'}
          </Pill>
          <span className="ab-section-sub">{testResult}</span>
        </div>
      )}

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
          <div className="ab-section-title">Defaults</div>
          <div className="ab-section-sub">
            Used when an agent picks this provider but doesn't override the
            model.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="pd-default-model">
              Default model
            </label>
            <input
              id="pd-default-model"
              className="ab-input ab-mono"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="pd-embed-model">
              Default embedding model
            </label>
            <input
              id="pd-embed-model"
              className="ab-input ab-mono"
              value={defaultEmbeddingModel}
              onChange={(e) => setDefaultEmbeddingModel(e.target.value)}
              placeholder="(none)"
            />
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
              Snapshot of <code className="ab-mono">/v1/models</code>.
              Refresh to pick up new releases.
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
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            {provider.models.models.map((m) => {
              const state = modelTestState[m]
              const msg = modelTestMsg[m]
              return (
                <button
                  key={m}
                  type="button"
                  className="ab-mono"
                  onClick={() => void testModel(m)}
                  disabled={state === 'pending'}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--radius-pill)',
                    background:
                      state === 'ok'
                        ? 'var(--success-bg)'
                        : state === 'error'
                          ? 'var(--danger-bg)'
                          : 'var(--surface-hi)',
                    border:
                      '1px solid ' +
                      (state === 'ok'
                        ? 'rgba(52, 211, 153, 0.22)'
                        : state === 'error'
                          ? 'rgba(251, 113, 133, 0.24)'
                          : 'var(--border)'),
                    color:
                      state === 'ok'
                        ? 'var(--success)'
                        : state === 'error'
                          ? 'var(--danger)'
                          : 'var(--text)',
                    fontSize: 12,
                    cursor: state === 'pending' ? 'wait' : 'pointer',
                    font: 'inherit',
                  }}
                  title={
                    state === 'pending'
                      ? 'Testing…'
                      : msg
                        ? `${state === 'ok' ? 'OK · ' : ''}${msg}`
                        : 'Click to test this model'
                  }
                >
                  {m}
                  {state === 'pending' && ' …'}
                  {state === 'ok' && ' ✓'}
                  {state === 'error' && ' ✕'}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="ab-field-help">
            No models cached yet. Hit{' '}
            <strong>Refresh models</strong> after setting a key.
          </div>
        )}
      </div>

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
          <Link to="/library/providers" className="ab-btn ab-btn-ghost">
            Cancel
          </Link>
          <Button variant="primary" onClick={save} disabled={busy}>
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
