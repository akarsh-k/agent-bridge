/**
 * "Bridge tools" panel for the agent inspector (Phase 7c).
 *
 * Lists the agent's `bridge_tools` rows (the outbound MCP tools an IDE
 * sees when it talks to `apps/mcp-bridge`) and lets the operator
 * add / edit / disable / delete each one.
 *
 * Rules surfaced in the UI:
 *   - Names matching `^query_` are rejected client-side with an inline
 *     error so the operator gets feedback before hitting the server.
 *   - JSON-Schema textarea live-parses; an unparseable draft keeps the
 *     local state but blocks Save.
 *   - Adding ≥1 enabled bridge tool flips this agent into 1:N mode for
 *     the bridge — the auto-derived `query_<slug>` default is no
 *     longer exposed (footnote rendered when this is the case).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  bridgeToolCreateInputSchema,
  bridgeToolUpdateInputSchema,
  BRIDGE_TOOL_RESERVED_PREFIX,
  type BridgeToolResponse,
} from '@agent-bridge/shared'
import {
  ApiError,
  createBridgeTool,
  deleteBridgeTool,
  listBridgeTools,
  patchBridgeTool,
} from '../../../lib/rpc'

interface BridgeToolsSectionProps {
  readonly agentId: string
  readonly agentSlug: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; tools: readonly BridgeToolResponse[] }
  | { kind: 'error'; message: string }

export function BridgeToolsSection({
  agentId,
  agentSlug,
}: BridgeToolsSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Bumping this triggers a refetch via the effect below. The "fetch
  // in an effect, set state from the resolved promise" pattern is
  // canonical for React 19 + the react-hooks/set-state-in-effect rule:
  // the effect subscribes to an external system (the API), so the
  // state update is a fan-in from that system rather than cascading
  // logic.
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const tools = await listBridgeTools(agentId)
        if (!active) return
        setState({ kind: 'ready', tools })
      } catch (err) {
        if (!active) return
        setState({
          kind: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load bridge tools',
        })
      }
    })()
    return () => {
      active = false
    }
  }, [agentId, refreshTick])

  const enabledCount = useMemo(() => {
    if (state.kind !== 'ready') return 0
    return state.tools.filter((t) => t.enabled).length
  }, [state])

  if (state.kind === 'loading') {
    return <div className="muted" style={{ fontSize: 12 }}>Loading bridge tools…</div>
  }

  if (state.kind === 'error') {
    return (
      <div className="banner banner-error" role="alert">
        {state.message}
      </div>
    )
  }

  return (
    <div className="bridge-tools-section">
      <p className="field-hint" style={{ marginTop: 0 }}>
        These are the MCP tools your IDE (Cursor, Claude Code) sees for
        this agent. Authoring at least one enabled tool replaces the
        auto-derived default{' '}
        <code className="mono">
          {BRIDGE_TOOL_RESERVED_PREFIX}
          {agentSlug}
        </code>
        . Names starting with{' '}
        <code className="mono">{BRIDGE_TOOL_RESERVED_PREFIX}</code> are
        reserved.
      </p>

      {state.tools.length === 0 ? (
        <div
          className="rail-empty"
          style={{ padding: '14px 12px', textAlign: 'left' }}
        >
          <div className="rail-empty-title" style={{ fontSize: 13 }}>
            No bridge tools yet
          </div>
          <div className="rail-empty-hint" style={{ fontSize: 12 }}>
            The IDE currently exposes only the default{' '}
            <code className="mono">
              {BRIDGE_TOOL_RESERVED_PREFIX}
              {agentSlug}
            </code>
            . Add a tool below to author an explicit name + input schema.
          </div>
        </div>
      ) : (
        <ul className="bridge-tools-list">
          {state.tools.map((tool) =>
            editingId === tool.id ? (
              <li key={tool.id}>
                <BridgeToolEditor
                  agentId={agentId}
                  initial={tool}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null)
                    refresh()
                  }}
                  onDelete={async () => {
                    if (!window.confirm(`Delete bridge tool "${tool.name}"?`)) {
                      return
                    }
                    try {
                      await deleteBridgeTool(agentId, tool.id)
                      setEditingId(null)
                      refresh()
                    } catch {
                      // refresh anyway so the row reappears if delete failed
                      refresh()
                    }
                  }}
                />
              </li>
            ) : (
              <li key={tool.id} className="bridge-tools-row">
                <button
                  type="button"
                  className="bridge-tools-row-header"
                  onClick={() => setEditingId(tool.id)}
                  aria-label={`Edit ${tool.name}`}
                >
                  <code className="mono">{tool.name}</code>
                  <span className="bridge-tools-row-status">
                    {tool.enabled ? 'enabled' : 'disabled'}
                  </span>
                </button>
                {tool.description ? (
                  <div className="bridge-tools-row-desc">
                    {tool.description}
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}

      {enabledCount > 0 && state.tools.length > 0 ? (
        <div className="muted" style={{ fontSize: 11.5 }}>
          1:N mode — IDE will see {enabledCount} explicit tool
          {enabledCount === 1 ? '' : 's'}.
        </div>
      ) : null}

      {adding ? (
        <BridgeToolEditor
          agentId={agentId}
          initial={null}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            refresh()
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setAdding(true)}
        >
          + Add bridge tool
        </button>
      )}
    </div>
  )
}

// ─── Editor ──────────────────────────────────────────────────────────────

interface BridgeToolEditorProps {
  readonly agentId: string
  readonly initial: BridgeToolResponse | null
  readonly onCancel: () => void
  readonly onSaved: () => void
  readonly onDelete?: () => Promise<void>
}

function BridgeToolEditor({
  agentId,
  initial,
  onCancel,
  onSaved,
  onDelete,
}: BridgeToolEditorProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [schemaText, setSchemaText] = useState(() =>
    initial?.inputSchema
      ? JSON.stringify(initial.inputSchema, null, 2)
      : '{\n  "type": "object",\n  "properties": {}\n}',
  )
  const [promptTemplate, setPromptTemplate] = useState(
    initial?.promptTemplate ?? '',
  )
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)

  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  // Live JSON-Schema parse. Empty / invalid drafts surface inline; a
  // valid object is what eventually flows into the request body.
  const schemaParse = useMemo(() => {
    const trimmed = schemaText.trim()
    if (!trimmed) return { ok: true as const, value: {} }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false as const, message: 'Schema must be a JSON object' }
      }
      return { ok: true as const, value: parsed as Record<string, unknown> }
    } catch (err) {
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }, [schemaText])

  const submit = useCallback(async () => {
    setFieldError(null)
    setServerError(null)
    if (!schemaParse.ok) {
      setFieldError(schemaParse.message)
      return
    }
    const body = {
      name: name.trim(),
      description: description.trim(),
      inputSchema: schemaParse.value,
      promptTemplate,
      enabled,
    }

    // Re-validate against the shared Zod so the server-side rule is
    // enforced before any network call. Edit + create share the same
    // base validation; PATCH wraps it in `.refine` for at-least-one
    // field, which is always satisfied since we always send all fields.
    const schema = initial
      ? bridgeToolUpdateInputSchema
      : bridgeToolCreateInputSchema
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Invalid input')
      return
    }

    setSaving(true)
    try {
      if (initial) {
        await patchBridgeTool(agentId, initial.id, body)
      } else {
        await createBridgeTool(agentId, body)
      }
      onSaved()
    } catch (err) {
      setServerError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to save bridge tool',
      )
    } finally {
      setSaving(false)
    }
  }, [
    schemaParse,
    name,
    description,
    promptTemplate,
    enabled,
    initial,
    agentId,
    onSaved,
  ])

  return (
    <div className="bridge-tools-editor">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          type="text"
          className="field-mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ask_architecture"
          maxLength={64}
          disabled={saving}
        />
        <span className="field-hint">
          Letters, digits, underscores. Cannot start with{' '}
          <code className="mono">{BRIDGE_TOOL_RESERVED_PREFIX}</code>.
        </span>
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Answer architecture questions about this codebase"
          maxLength={1_000}
          disabled={saving}
        />
        <span className="field-hint">
          Shown in the IDE's tool picker.
        </span>
      </label>
      <label className="field">
        <span className="field-label">Input schema (JSON Schema draft-07)</span>
        <textarea
          className="field-mono"
          rows={6}
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
          disabled={saving}
        />
        {schemaParse.ok ? (
          <span className="field-hint">
            Saved verbatim — sent to MCP clients on{' '}
            <code className="mono">tools/list</code>.
          </span>
        ) : (
          <span className="field-error">{schemaParse.message}</span>
        )}
      </label>
      <label className="field">
        <span className="field-label">Prompt template</span>
        <textarea
          className="field-mono"
          rows={4}
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          placeholder="Architecture question about this codebase: {{ question }}"
          disabled={saving}
        />
        <span className="field-hint">
          Use <code className="mono">{`{{ argName }}`}</code> placeholders
          for fields from your input schema. The bridge renders the
          prompt at invocation time.
        </span>
      </label>
      <label className="field" style={{ flexDirection: 'row', gap: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={saving}
        />
        <span className="field-label" style={{ marginBottom: 0 }}>
          Enabled
        </span>
      </label>

      {fieldError ? (
        <div className="banner banner-error" role="alert">
          {fieldError}
        </div>
      ) : null}
      {serverError ? (
        <div className="banner banner-error" role="alert">
          {serverError}
        </div>
      ) : null}

      <div className="form-actions">
        {onDelete ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void onDelete()}
            disabled={saving}
          >
            Delete
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={saving || !schemaParse.ok || name.trim().length === 0}
        >
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add tool'}
        </button>
      </div>
    </div>
  )
}
