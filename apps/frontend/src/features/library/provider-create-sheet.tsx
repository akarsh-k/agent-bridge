/**
 * "Add LLM provider" side-sheet. Validates against the shared Zod
 * schema and pipes through the workspace `createLlmProvider`
 * mutator. After success the new provider is in the list and any
 * agent picker can select it.
 */

import { useMemo, useState } from 'react'
import {
  llmProviderCreateInputSchema,
  llmProviderKinds,
  type LlmProviderKind,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { useDirtyClose } from '../../lib/use-dirty-close'

const LOCAL_KINDS: ReadonlyArray<LlmProviderKind> = [
  'llama_cpp',
  'ollama',
  'openai_compatible',
]
const isLocal = (k: LlmProviderKind): boolean => LOCAL_KINDS.includes(k)

const KIND_LABEL: Record<LlmProviderKind, string> = {
  openai: 'OpenAI / Anthropic (cloud)',
  llama_cpp: 'llama.cpp',
  ollama: 'Ollama',
  openai_compatible: 'OpenAI-compatible (custom)',
}

function ProviderCreateForm({ onClose }: { onClose: () => void }) {
  const { createLlmProvider } = useWorkspace()
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<LlmProviderKind>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const opts: DropdownOption<LlmProviderKind>[] = useMemo(
    () =>
      llmProviderKinds.map((k) => ({
        value: k,
        label: KIND_LABEL[k],
        sub: isLocal(k) ? 'local' : 'cloud',
      })),
    [],
  )
  const local = isLocal(kind)

  const dirty =
    label.length > 0 ||
    baseUrl.length > 0 ||
    defaultModel.length > 0 ||
    apiKey.length > 0
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    setErr(null)
    const parsed = llmProviderCreateInputSchema.safeParse({
      kind,
      label: label.trim(),
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
      await createLlmProvider(parsed.data)
      toast.success(`Provider “${label.trim()}” added`)
      onClose()
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create provider'
      setErr(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="New LLM provider"
      subtitle="Connect an OpenAI / Anthropic key, a local model server, or any OpenAI-compatible endpoint."
      primaryLabel="Add provider"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!label.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="np-label">
          Label
        </label>
        <input
          id="np-label"
          className="ab-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Anthropic — work key"
          autoFocus
        />
      </div>
      <div className="ab-field">
        <span className="ab-field-label">Kind</span>
        <Dropdown<LlmProviderKind>
          value={kind}
          onChange={setKind}
          options={opts}
        />
      </div>
      {local && (
        <div className="ab-field">
          <label className="ab-field-label" htmlFor="np-baseurl">
            Base URL
          </label>
          <input
            id="np-baseurl"
            className="ab-input ab-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
          />
        </div>
      )}
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="np-key">
          API key {local && '(optional for local)'}
        </label>
        <input
          id="np-key"
          className="ab-input ab-mono"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
        />
        <span className="ab-field-help">
          Encrypted at rest with your master key.
        </span>
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="np-default-model">
          Default model (optional)
        </label>
        <input
          id="np-default-model"
          className="ab-input ab-mono"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="claude-opus-4-7"
        />
        <span className="ab-field-help">
          We refresh the full model list after creation.
        </span>
      </div>
      {err && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)' }}
          role="alert"
        >
          {err}
        </div>
      )}
    </Sheet>
  )
}

export function ProviderCreateSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="New LLM provider">
        <></>
      </Sheet>
    )
  }
  return <ProviderCreateForm key={openCount} onClose={onClose} />
}
