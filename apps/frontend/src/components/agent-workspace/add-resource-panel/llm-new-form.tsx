import { useCallback, useEffect, useRef, useState } from 'react'
import {
  llmProviderCreateInputSchema,
  llmProviderKinds,
  type LlmProviderKind,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { ModelPicker } from '../../common/model-picker'
import { AddFormActions, ErrorText } from './form-atoms'

const LOCAL_LLM_KINDS: readonly LlmProviderKind[] = [
  'llama_cpp',
  'ollama',
  'openai_compatible',
]

function isLocalKind(kind: LlmProviderKind): boolean {
  return LOCAL_LLM_KINDS.includes(kind)
}

export function LlmNewForm({
  agentId,
  onCancel,
  onDone,
}: {
  readonly agentId: string
  readonly onCancel: () => void
  readonly onDone: () => void
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
    const parsed = llmProviderCreateInputSchema.safeParse({
      label: label.trim(),
      kind,
      baseUrl: local ? baseUrl.trim() || undefined : undefined,
      defaultModel: defaultModel.trim() || undefined,
      apiKey: apiKey.trim()
        ? ({ action: 'set', plaintext: apiKey.trim() } as const)
        : undefined,
    })
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
      className="add-resource-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
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
        {/* Fresh providers have no cached models yet, so the picker
            renders as a plain text input. After creation the operator
            can hit "Refresh models" on the inspector to populate the
            dropdown for future edits. */}
        <ModelPicker
          value={defaultModel}
          onChange={setDefaultModel}
          models={[]}
          placeholder="gpt-4.1-mini"
          className="field-mono"
          disabled={busy}
          ariaLabel="Default model id"
        />
        <span className="field-hint">
          Refresh the model list after saving to enable autocomplete here.
        </span>
      </label>
      <label className="field">
        <span className="field-label">API key (optional)</span>
        <input
          type="password"
          className="field-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          disabled={busy}
          autoComplete="off"
        />
        <span className="field-hint">Encrypted at rest.</span>
      </label>
      <ErrorText message={err} />
      <AddFormActions
        submitLabel={busy ? 'Creating...' : 'Create and assign'}
        busy={busy}
        disabled={label.trim().length === 0}
        onCancel={onCancel}
      />
    </form>
  )
}
