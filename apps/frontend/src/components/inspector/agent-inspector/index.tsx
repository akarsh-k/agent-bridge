/**
 * Right-rail inspector for an `AgentNode`.
 *
 * Behaviour:
 *   - Lazy-initialises form state from the agent on mount. The parent
 *     passes `key={agent.id}` so a different agent selection remounts the
 *     component — cleaner than a re-seed effect and avoids the React 19
 *     set-state-in-effect warning.
 *   - Local form state is the source of truth while the user is typing.
 *   - `Save` PATCHes the changed fields only (skips the request if nothing
 *     changed). Validation uses the *same* Zod schema the backend uses,
 *     so errors caught client-side match server-side rules exactly.
 *   - Successful PATCH updates the shared `useAgents` list, which flows
 *     back into the canvas node + sidebar through props without a refetch.
 *   - `Delete` removes the agent and navigates away.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  BRIDGE_TOOL_RESERVED_PREFIX,
  agentUpdateInputSchema,
  defaultMemoryConfig,
  type AgentMemoryConfig,
  type AgentResponse,
  type AgentUpdateInput,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ModelPicker } from '../../common/model-picker'
import { ApiError, exportAgentBundle } from '../../../lib/rpc'
import { navigate } from '../../../lib/router'
import { BridgeToolsSection } from './bridge-tools-section'
import { MemorySection } from './memory-section'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type FieldErrors = Partial<
  Record<'name' | 'slug' | 'description' | 'systemPrompt' | 'model', string>
>

export function AgentInspector({ agent }: { agent: AgentResponse }) {
  const { patchAgent, removeAgent, llmProviders } = useWorkspace()
  // Surface this agent's provider's cached `/v1/models` list so the
  // model field shows autocomplete choices. Falls back to an empty
  // array (free-text input) when the agent has no provider yet OR the
  // provider hasn't been refreshed.
  const providerRow = llmProviders.find((p) => p.id === agent.llmProviderId)
  const providerModels = providerRow?.models?.models ?? []
  const providerHasEmbedder = !!providerRow?.defaultEmbeddingModel

  const [name, setName] = useState(() => agent.name)
  const [slug, setSlug] = useState(() => agent.slug)
  const [description, setDescription] = useState(() => agent.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(() => agent.systemPrompt)
  const [model, setModel] = useState(() => agent.model ?? '')
  const [memoryEnabled, setMemoryEnabled] = useState(() => agent.memoryEnabled)
  const [memoryConfig, setMemoryConfig] = useState<AgentMemoryConfig | null>(
    () => agent.memoryConfig,
  )
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [serverError, setServerError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  // Toggling `memoryEnabled` ON for the first time pre-fills the
  // canonical defaults so the operator sees what's about to be saved.
  // We don't write the defaults to the DB until they save — a no-op
  // toggle followed by Discard leaves the row untouched. The backend
  // also seeds defaults defensively (`apps/backend/src/routes/agents.ts`)
  // so a curl client gets the same behaviour.
  const handleMemoryEnabledToggle = useCallback(
    (next: boolean) => {
      setMemoryEnabled(next)
      if (next && memoryConfig === null && agent.memoryConfig === null) {
        setMemoryConfig(defaultMemoryConfig())
      }
    },
    [memoryConfig, agent.memoryConfig],
  )

  const patch = useMemo<AgentUpdateInput>(() => {
    const out: Record<string, unknown> = {}
    if (name.trim() !== agent.name) out.name = name.trim()
    if (slug.trim() !== agent.slug) out.slug = slug.trim()
    const nextDesc = description.trim()
    const prevDesc = agent.description ?? ''
    if (nextDesc !== prevDesc) out.description = nextDesc.length ? nextDesc : null
    if (systemPrompt !== agent.systemPrompt) out.systemPrompt = systemPrompt
    const prevModel = agent.model ?? ''
    if (model !== prevModel) out.model = model.length ? model : null
    if (memoryEnabled !== agent.memoryEnabled) out.memoryEnabled = memoryEnabled
    if (!shallowEqualMemory(memoryConfig, agent.memoryConfig))
      out.memoryConfig = memoryConfig
    return out as AgentUpdateInput
  }, [
    name,
    slug,
    description,
    systemPrompt,
    model,
    memoryEnabled,
    memoryConfig,
    agent,
  ])

  const dirty = Object.keys(patch).length > 0

  const handleSave = useCallback(async () => {
    if (!dirty) return
    setFieldErrors({})
    setServerError(null)

    // Client-side validation against the shared schema — mirrors the
    // backend so users get instant field-level feedback.
    const parsed = agentUpdateInputSchema.safeParse(patch)
    if (!parsed.success) {
      const next: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]
        if (typeof key !== 'string') continue
        if (key === 'name' && !next.name) next.name = issue.message
        else if (key === 'slug' && !next.slug) next.slug = issue.message
        else if (key === 'description' && !next.description)
          next.description = issue.message
        else if (key === 'systemPrompt' && !next.systemPrompt)
          next.systemPrompt = issue.message
        else if (key === 'model' && !next.model) next.model = issue.message
      }
      setFieldErrors(next)
      return
    }

    setSaveState('saving')
    try {
      await patchAgent(agent.id, parsed.data)
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      if (err instanceof ApiError && err.code === 'conflict') {
        setFieldErrors({ slug: err.message })
      } else if (err instanceof ApiError) {
        setServerError(err.message)
      } else {
        setServerError(
          err instanceof Error ? err.message : 'Failed to save agent',
        )
      }
    }
  }, [dirty, patch, patchAgent, agent.id])

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) {
      return
    }
    try {
      await removeAgent(agent.id)
      navigate('/')
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Failed to delete agent',
      )
    }
  }, [agent.id, agent.name, removeAgent])

  const [exporting, setExporting] = useState(false)
  const handleExport = useCallback(async () => {
    setExporting(true)
    setServerError(null)
    try {
      const bundle = await exportAgentBundle(agent.id)
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agent-${agent.slug}.json`
      a.click()
      // Defer revoke so the download has time to start. URL.revokeObjectURL
      // is sync so no need to await; 1s is comfortable across browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
    } catch (err) {
      setServerError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to export agent',
      )
    } finally {
      setExporting(false)
    }
  }, [agent.id, agent.slug])

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Identity</span>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
          {fieldErrors.name ? (
            <span className="field-error">{fieldErrors.name}</span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">Slug</span>
          <input
            type="text"
            className="field-mono"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={64}
          />
          <span className="field-hint">
            URL-safe ID. Becomes the MCP tool name exposed to coding
            agents:{' '}
            <code className="mono">
              {BRIDGE_TOOL_RESERVED_PREFIX}
              {slug || agent.slug}
            </code>{' '}
            (open the{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => navigate('/bridge')}
            >
              Connect IDE
            </button>{' '}
            page to copy the config).
          </span>
          {fieldErrors.slug ? (
            <span className="field-error">{fieldErrors.slug}</span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1_000}
            rows={3}
          />
          {fieldErrors.description ? (
            <span className="field-error">{fieldErrors.description}</span>
          ) : null}
        </label>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Runtime</span>
        </div>

        <label className="field">
          <span className="field-label">System prompt</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={5}
            placeholder="Instructions the agent sees on every turn…"
          />
          {fieldErrors.systemPrompt ? (
            <span className="field-error">{fieldErrors.systemPrompt}</span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          <ModelPicker
            value={model}
            onChange={setModel}
            models={providerModels}
            placeholder="e.g. gpt-4.1-mini, claude-opus-4, llama3.1-8b"
            className="field-mono"
            ariaLabel="Agent model id"
          />
          <span className="field-hint">
            {providerModels.length > 0
              ? `Pick from ${providerModels.length} model(s) refreshed from this provider, or type a custom id.`
              : "Type a model id. Refresh the provider's model list to get autocomplete."}
          </span>
          {fieldErrors.model ? (
            <span className="field-error">{fieldErrors.model}</span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(e) => handleMemoryEnabledToggle(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Enable agent memory
          </span>
          <span className="field-hint">
            Uses Mastra's working memory + semantic recall against the shared
            Postgres store.
          </span>
        </label>
      </section>

      {memoryEnabled ? (
        <section className="inspector-section">
          <div className="inspector-section-title">
            <span>Memory</span>
          </div>
          <MemorySection
            value={memoryConfig}
            onChange={setMemoryConfig}
            providerHasEmbedder={providerHasEmbedder}
          />
        </section>
      ) : null}

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Bridge tools</span>
        </div>
        <BridgeToolsSection agentId={agent.id} agentSlug={agent.slug} />
      </section>

      {serverError ? (
        <div className="banner banner-error" role="alert">
          <span>{serverError}</span>
        </div>
      ) : null}

      {saveState === 'saving' ? (
        <div className="status-strip saving">Saving…</div>
      ) : null}
      {saveState === 'saved' && !dirty ? (
        <div className="status-strip saved">Saved</div>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void handleExport()}
          disabled={exporting}
          title="Download a JSON snapshot of this agent (no secrets)"
        >
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void handleDelete()}
        >
          Delete
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!dirty || saveState === 'saving'}
          onClick={() => {
            setName(agent.name)
            setSlug(agent.slug)
            setDescription(agent.description ?? '')
            setSystemPrompt(agent.systemPrompt)
            setModel(agent.model ?? '')
            setMemoryEnabled(agent.memoryEnabled)
            setMemoryConfig(agent.memoryConfig)
            setFieldErrors({})
            setServerError(null)
          }}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saveState === 'saving'}
          onClick={() => void handleSave()}
        >
          {saveState === 'saving' ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

/**
 * Cheap structural equality for `AgentMemoryConfig`. JSON.stringify is
 * unstable across key orderings in theory, but every code path that
 * builds the blob (defaultMemoryConfig + memory-section.tsx) uses the
 * same shape, so JSON ordering is deterministic in practice. Returns
 * `true` when the two values are byte-equal so the patch builder can
 * skip emitting `memoryConfig` on no-op edits.
 */
function shallowEqualMemory(
  a: AgentMemoryConfig | null,
  b: AgentMemoryConfig | null,
): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
