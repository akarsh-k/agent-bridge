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
  type AgentResponse,
  type AgentUpdateInput,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ModelPicker } from '../../common/model-picker'
import { ApiError } from '../../../lib/rpc'
import { navigate } from '../../../lib/router'

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
  const providerModels =
    llmProviders.find((p) => p.id === agent.llmProviderId)?.models?.models ?? []

  const [name, setName] = useState(() => agent.name)
  const [slug, setSlug] = useState(() => agent.slug)
  const [description, setDescription] = useState(() => agent.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(() => agent.systemPrompt)
  const [model, setModel] = useState(() => agent.model ?? '')
  const [memoryEnabled, setMemoryEnabled] = useState(() => agent.memoryEnabled)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [serverError, setServerError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

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
    return out as AgentUpdateInput
  }, [
    name,
    slug,
    description,
    systemPrompt,
    model,
    memoryEnabled,
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
              onChange={(e) => setMemoryEnabled(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Enable working memory
          </span>
          <span className="field-hint">
            Uses Mastra's working memory + semantic recall against the shared
            Postgres store.
          </span>
        </label>
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
