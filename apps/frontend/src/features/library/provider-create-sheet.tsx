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
  llmProviderRoles,
  type LlmProviderKind,
  type LlmProviderRole,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError, refreshLlmProviderModels } from '../../lib/rpc'
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

const ROLE_LABEL: Record<LlmProviderRole, string> = {
  chat: 'Chat',
  embedding: 'Embedding (workspace-wide)',
}
const ROLE_SUB: Record<LlmProviderRole, string> = {
  chat: 'Answers chat completions for any agent that picks it.',
  embedding:
    'Powers semantic recall and (later) repo indexing. One per workspace.',
}

function ProviderCreateForm({
  defaultRole,
  onClose,
}: {
  defaultRole: LlmProviderRole
  onClose: () => void
}) {
  const { createLlmProvider, patchLlmProviderModels, llmProviders } =
    useWorkspace()
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<LlmProviderRole>(defaultRole)
  const [kind, setKind] = useState<LlmProviderKind>('openai')
  const [baseUrl, setBaseUrl] = useState('')
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
  const embeddingExists = useMemo(
    () => llmProviders.some((p) => p.role === 'embedding'),
    [llmProviders],
  )
  const roleOpts: DropdownOption<LlmProviderRole>[] = useMemo(
    () =>
      llmProviderRoles.map((r) => ({
        value: r,
        label: ROLE_LABEL[r],
        sub: ROLE_SUB[r],
        disabled: r === 'embedding' && embeddingExists,
        disabledReason:
          r === 'embedding' && embeddingExists
            ? 'An embedding provider already exists. Delete it first.'
            : undefined,
      })),
    [embeddingExists],
  )
  const local = isLocal(kind)

  const dirty = label.length > 0 || baseUrl.length > 0 || apiKey.length > 0
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    setErr(null)
    const parsed = llmProviderCreateInputSchema.safeParse({
      kind,
      role,
      label: label.trim(),
      baseUrl: local ? baseUrl.trim() || undefined : undefined,
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
      const created = await createLlmProvider(parsed.data)
      toast.success(`Provider "${label.trim()}" added`)
      onClose()
      // Kick off model refresh in the background. Don't block the close
      // — the user has moved on; we just want the cache populated by the
      // time they pick this provider in agent-builder. Local providers
      // without a key are still worth probing (no auth needed for
      // ollama / llama.cpp /v1/models). Errors only surface as toasts.
      void (async () => {
        try {
          const res = await refreshLlmProviderModels(created.id)
          if (res.ok) {
            patchLlmProviderModels(created.id, res.models)
            toast.success(
              `${created.label} · ${res.models.models.length} model${res.models.models.length === 1 ? '' : 's'} cached`,
            )
          } else {
            // Soft failures (no key, host unreachable) — silent here so
            // we don't double-toast on a brand-new local provider that
            // the user hasn't started yet. The provider detail page
            // surfaces the same error explicitly when they get there.
          }
        } catch {
          /* network hiccup; provider detail page can retry */
        }
      })()
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
        <span className="ab-field-label">Role</span>
        <Dropdown<LlmProviderRole>
          value={role}
          onChange={setRole}
          options={roleOpts}
        />
        <span className="ab-field-help">
          Chat providers serve{' '}
          <code className="ab-mono">/v1/chat/completions</code>. The embedding
          provider is a workspace singleton — its model embeds every vector
          consumer.
        </span>
      </div>
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
      {role === 'chat' && !embeddingExists && (
        <div className="ab-hint-note">
          <span aria-hidden="true">·</span>
          <span>
            Coding-helper agents also need an embedding provider for code
            search. Add one (one per workspace) after you finish this.
          </span>
        </div>
      )}
      {err && (
        <div className="ab-field-help ab-field-help--danger" role="alert">
          {err}
        </div>
      )}
    </Sheet>
  )
}

export function ProviderCreateSheet({
  open,
  defaultRole = 'chat',
  onClose,
}: {
  open: boolean
  /** Pre-selects the role dropdown. Useful for "Add embedder" CTAs. */
  defaultRole?: LlmProviderRole
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
  return (
    <ProviderCreateForm
      key={openCount}
      defaultRole={defaultRole}
      onClose={onClose}
    />
  )
}
