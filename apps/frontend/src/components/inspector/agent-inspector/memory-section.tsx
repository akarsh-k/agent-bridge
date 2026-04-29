/**
 * Memory section for the agent inspector (Phase 6c).
 *
 * Surfaces every option in `AgentMemoryConfig` so an operator can configure
 * Mastra's memory subsystem without dropping into raw JSON. Rules:
 *   - Working memory uses a strict template-OR-schema XOR. The DB column
 *     can hold both fields simultaneously (Mastra resolves precedence at
 *     runtime), but the UI never authors that ambiguity — picking one
 *     mode clears the other (Phase 6 design decision "Working-memory
 *     shape: template OR schema, never both").
 *   - When the agent's provider lacks `defaultEmbeddingModel`, semantic
 *     recall is rendered with a warning banner and the operator can still
 *     toggle it on, but the run will fail loudly at the first vector
 *     write — that's the tradeoff for not silently swapping vector spaces.
 *   - The token-cost block is a static copy hint. We don't try to estimate
 *     per-agent because the shape is too variable and a wrong estimate is
 *     worse than no estimate (Phase 6 design decision).
 *
 * `value`/`onChange` form — the parent inspector owns persistence; this
 * component only renders + emits a fresh `AgentMemoryConfig` blob on every
 * change. `null` means "operator hasn't authored a config yet"; the UI
 * shows defaults and only materialises a real config once a control is
 * touched (so a no-op toggle doesn't bloat the patch payload).
 */

import { useMemo, useState } from 'react'
import {
  defaultMemoryConfig,
  memoryScopes,
  type AgentMemoryConfig,
  type MemoryScope,
} from '@agent-bridge/shared'

interface MemorySectionProps {
  readonly value: AgentMemoryConfig | null
  readonly onChange: (next: AgentMemoryConfig) => void
  /**
   * `true` iff the linked LLM provider has `defaultEmbeddingModel` set.
   * Drives the "semantic recall unavailable" warning when off.
   */
  readonly providerHasEmbedder: boolean
}

const TOPK_MAX = 20
const LAST_MESSAGES_MAX = 50

export function MemorySection({
  value,
  onChange,
  providerHasEmbedder,
}: MemorySectionProps) {
  const config = useMemo<AgentMemoryConfig>(
    () => value ?? defaultMemoryConfig(),
    [value],
  )

  // ─── lastMessages ──────────────────────────────────────────────────────
  const lastMessagesDisabled = config.lastMessages === false
  const lastMessages =
    typeof config.lastMessages === 'number'
      ? config.lastMessages
      : lastMessagesDisabled
        ? 0
        : 10

  const setLastMessagesDisabled = (disabled: boolean) => {
    onChange({ ...config, lastMessages: disabled ? false : 10 })
  }
  const setLastMessages = (n: number) => {
    onChange({ ...config, lastMessages: n })
  }

  // ─── workingMemory ─────────────────────────────────────────────────────
  const workingEnabled = config.workingMemory?.enabled ?? false
  const wmTemplate = config.workingMemory?.template ?? ''
  const persistedSchemaText = config.workingMemory?.schema
    ? JSON.stringify(config.workingMemory.schema, null, 2)
    : ''
  // Schema text is uncontrolled: keeping it in component state lets the
  // operator type invalid JSON without the field clearing on every
  // keystroke. We only commit to `onChange` when the parse succeeds.
  const [schemaDraft, setSchemaDraft] = useState<string>(persistedSchemaText)
  // Track the active mode locally too. Initial value reflects what's on
  // disk: schema if a schema is persisted, template otherwise. Once the
  // operator picks a mode the choice sticks until they pick again — even
  // if the persisted schema gets cleared mid-edit.
  const [wmMode, setWmMode] = useState<'template' | 'schema'>(
    config.workingMemory?.schema ? 'schema' : 'template',
  )
  const wmScope: MemoryScope = config.workingMemory?.scope ?? 'resource'
  const schemaParseError = useMemo(() => {
    if (!schemaDraft.trim()) return null
    try {
      const parsed: unknown = JSON.parse(schemaDraft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Schema must be a JSON object'
      }
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid JSON'
    }
  }, [schemaDraft])

  const setWorkingEnabled = (enabled: boolean) => {
    if (!enabled) {
      // Clear the whole subobject so the saved blob doesn't carry stale
      // template/schema strings the operator can't see in disabled state.
      const { workingMemory: _wm, ...rest } = config
      void _wm
      onChange(rest)
      return
    }
    onChange({
      ...config,
      workingMemory: {
        enabled: true,
        scope: wmScope,
        ...(wmMode === 'template'
          ? { template: wmTemplate }
          : tryParseSchema(schemaDraft)),
      },
    })
  }

  const setWorkingMode = (mode: 'template' | 'schema') => {
    setWmMode(mode)
    if (!workingEnabled) return
    if (mode === 'template') {
      // Switching to template mode clears the persisted schema. The
      // textarea text in `schemaDraft` stays so the user can flip back
      // without losing in-progress work.
      onChange({
        ...config,
        workingMemory: {
          enabled: true,
          scope: wmScope,
          template: wmTemplate,
        },
      })
    } else {
      onChange({
        ...config,
        workingMemory: {
          enabled: true,
          scope: wmScope,
          ...tryParseSchema(schemaDraft),
        },
      })
    }
  }

  const setWorkingTemplate = (template: string) => {
    onChange({
      ...config,
      workingMemory: { enabled: true, scope: wmScope, template },
    })
  }

  const setWorkingSchemaText = (text: string) => {
    setSchemaDraft(text)
    // Only commit valid JSON to the saved config — the draft stays in
    // local state so the textarea shows what the operator typed even
    // when it doesn't parse yet.
    const parsed = tryParseSchema(text)
    if (parsed.schema) {
      onChange({
        ...config,
        workingMemory: {
          enabled: true,
          scope: wmScope,
          schema: parsed.schema,
        },
      })
    } else if (config.workingMemory?.schema) {
      // Text became invalid; drop the persisted schema so the agent
      // doesn't run with a stale shape.
      onChange({
        ...config,
        workingMemory: { enabled: true, scope: wmScope },
      })
    }
  }

  const setWorkingScope = (scope: MemoryScope) => {
    onChange({
      ...config,
      workingMemory: {
        enabled: workingEnabled,
        scope,
        ...(wmMode === 'template'
          ? { template: wmTemplate }
          : tryParseSchema(schemaDraft)),
      },
    })
  }

  // ─── semanticRecall ────────────────────────────────────────────────────
  const recallEnabled = !!config.semanticRecall
  const topK = config.semanticRecall?.topK ?? 4
  const range = config.semanticRecall?.messageRange
  const before =
    typeof range === 'number' ? range : (range?.before ?? 1)
  const after = typeof range === 'number' ? range : (range?.after ?? 1)
  const recallScope: MemoryScope = config.semanticRecall?.scope ?? 'resource'

  const setRecallEnabled = (enabled: boolean) => {
    if (!enabled) {
      const { semanticRecall: _r, ...rest } = config
      void _r
      onChange(rest)
      return
    }
    onChange({
      ...config,
      semanticRecall: {
        topK,
        messageRange: { before, after },
        scope: recallScope,
      },
    })
  }

  const setTopK = (n: number) => {
    onChange({
      ...config,
      semanticRecall: {
        topK: n,
        messageRange: { before, after },
        scope: recallScope,
      },
    })
  }

  const setRange = (next: { before: number; after: number }) => {
    onChange({
      ...config,
      semanticRecall: {
        topK,
        messageRange: next,
        scope: recallScope,
      },
    })
  }

  const setRecallScope = (scope: MemoryScope) => {
    onChange({
      ...config,
      semanticRecall: {
        topK,
        messageRange: { before, after },
        scope,
      },
    })
  }

  // ─── generateTitle ─────────────────────────────────────────────────────
  const generateTitle = config.generateTitle ?? false
  const setGenerateTitle = (v: boolean) => {
    onChange({ ...config, generateTitle: v })
  }

  return (
    <div className="memory-section">
      <p className="field-hint" style={{ marginTop: 0 }}>
        Working memory injects roughly 200–2000 tokens of state into every
        turn; semantic recall pulls roughly{' '}
        <code className="mono">topK × (1 + before + after)</code> prior
        messages. Both compound — keep an eye on context-window pressure.
      </p>

      {/* ─── Recent history ────────────────────────────────────── */}
      <div className="inspector-subcard">
        <div className="inspector-subcard-title">Recent history</div>
        <label className="field" style={{ flexDirection: 'row', gap: 6 }}>
          <input
            type="checkbox"
            checked={lastMessagesDisabled}
            onChange={(e) => setLastMessagesDisabled(e.target.checked)}
          />
          <span className="field-label" style={{ marginBottom: 0 }}>
            Disable recency-based history
          </span>
        </label>
        {!lastMessagesDisabled ? (
          <label className="field">
            <span className="field-label">
              Last messages: <code className="mono">{lastMessages}</code>
            </span>
            <input
              type="range"
              min={0}
              max={LAST_MESSAGES_MAX}
              value={lastMessages}
              onChange={(e) => setLastMessages(Number(e.target.value))}
            />
            <span className="field-hint">
              How many recent messages Mastra injects. Higher = more
              context, more tokens.
            </span>
          </label>
        ) : null}
      </div>

      {/* ─── Working memory ────────────────────────────────────── */}
      <div className="inspector-subcard">
        <div className="inspector-subcard-title">Working memory</div>
        <label className="field" style={{ flexDirection: 'row', gap: 6 }}>
          <input
            type="checkbox"
            checked={workingEnabled}
            onChange={(e) => setWorkingEnabled(e.target.checked)}
          />
          <span className="field-label" style={{ marginBottom: 0 }}>
            Enabled
          </span>
        </label>
        {workingEnabled ? (
          <>
            <div className="field">
              <span className="field-label">Mode</span>
              <div className="radio-row">
                <label className="radio-pill">
                  <input
                    type="radio"
                    name="wm-mode"
                    checked={wmMode === 'template'}
                    onChange={() => setWorkingMode('template')}
                  />
                  <span>Markdown template</span>
                </label>
                <label className="radio-pill">
                  <input
                    type="radio"
                    name="wm-mode"
                    checked={wmMode === 'schema'}
                    onChange={() => setWorkingMode('schema')}
                  />
                  <span>JSON Schema</span>
                </label>
              </div>
              <span className="field-hint">
                Template OR schema, never both. Picking one clears the
                other.
              </span>
            </div>
            {wmMode === 'template' ? (
              <label className="field">
                <span className="field-label">Template</span>
                <textarea
                  value={wmTemplate}
                  onChange={(e) => setWorkingTemplate(e.target.value)}
                  rows={5}
                  maxLength={10_000}
                  placeholder="# User profile&#10;- Name: ?&#10;- Goals: ?"
                />
              </label>
            ) : (
              <label className="field">
                <span className="field-label">JSON Schema</span>
                <textarea
                  value={schemaDraft}
                  onChange={(e) => setWorkingSchemaText(e.target.value)}
                  rows={6}
                  className="field-mono"
                  placeholder='{"type":"object","properties":{"name":{"type":"string"}}}'
                />
                {schemaParseError ? (
                  <span className="field-error">{schemaParseError}</span>
                ) : (
                  <span className="field-hint">
                    Saved when the JSON parses to an object. Mastra validates
                    the shape at runtime.
                  </span>
                )}
              </label>
            )}
            <label className="field">
              <span className="field-label">Scope</span>
              <select
                value={wmScope}
                onChange={(e) => setWorkingScope(e.target.value as MemoryScope)}
              >
                {memoryScopes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                <code className="mono">resource</code> persists across all
                threads for the same user;{' '}
                <code className="mono">thread</code> stays inside one
                conversation.
              </span>
            </label>
          </>
        ) : null}
      </div>

      {/* ─── Semantic recall ────────────────────────────────────── */}
      <div className="inspector-subcard">
        <div className="inspector-subcard-title">Semantic recall</div>
        <label className="field" style={{ flexDirection: 'row', gap: 6 }}>
          <input
            type="checkbox"
            checked={recallEnabled}
            onChange={(e) => setRecallEnabled(e.target.checked)}
          />
          <span className="field-label" style={{ marginBottom: 0 }}>
            Enabled
          </span>
        </label>
        {recallEnabled && !providerHasEmbedder ? (
          <div
            className="banner banner-warn"
            role="alert"
            style={{ fontSize: 11.5, marginTop: 4 }}
          >
            This agent's LLM provider has no <code>defaultEmbeddingModel</code>{' '}
            configured. Semantic recall will fail at runtime — set an
            embedding model on the provider, or disable this option.
          </div>
        ) : null}
        {recallEnabled ? (
          <>
            <label className="field">
              <span className="field-label">
                topK: <code className="mono">{topK}</code>
              </span>
              <input
                type="range"
                min={1}
                max={TOPK_MAX}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
              />
              <span className="field-hint">
                Number of semantically-similar messages to retrieve.
              </span>
            </label>
            <div className="field">
              <span className="field-label">Message range</span>
              <div className="range-row">
                <label className="range-leg">
                  <span>before</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={before}
                    onChange={(e) =>
                      setRange({ before: Number(e.target.value), after })
                    }
                  />
                </label>
                <label className="range-leg">
                  <span>after</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={after}
                    onChange={(e) =>
                      setRange({ before, after: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <span className="field-hint">
                Neighbour messages included on either side of each hit, for
                context.
              </span>
            </div>
            <label className="field">
              <span className="field-label">Scope</span>
              <select
                value={recallScope}
                onChange={(e) =>
                  setRecallScope(e.target.value as MemoryScope)
                }
              >
                {memoryScopes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </div>

      {/* ─── Generate title ────────────────────────────────────── */}
      <label className="field" style={{ flexDirection: 'row', gap: 6 }}>
        <input
          type="checkbox"
          checked={generateTitle}
          onChange={(e) => setGenerateTitle(e.target.checked)}
        />
        <span className="field-label" style={{ marginBottom: 0 }}>
          Auto-generate thread titles
        </span>
      </label>
    </div>
  )
}

/**
 * Parse JSON Schema text. Empty or invalid → omit the schema field
 * (Mastra would reject anyway). We only return a `schema` key when
 * parsing succeeds.
 */
function tryParseSchema(text: string): { schema?: Record<string, unknown> } {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { schema: parsed as Record<string, unknown> }
    }
  } catch {
    // Fall through to "no schema yet" — the draft state preserves the
    // textarea text so the operator's edit isn't lost.
  }
  return {}
}
