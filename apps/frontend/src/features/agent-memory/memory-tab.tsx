/**
 * Memory tab — Mastra-backed agent memory configuration. Toggles
 * the memory engine on/off, then surfaces the three sub-systems:
 * `lastMessages` window, working-memory template, and
 * semantic-recall via embeddings.
 */

import { useMemo, useState } from 'react'
import { memoryScopes, type MemoryScope } from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Link } from '../../lib/link'

// Two scopes Mastra exposes — `thread` and `resource` — translated to
// the two surfaces a user actually interacts with:
//   - The Chat tab (this app's built-in chat pane)
//   - From your IDE (Cursor / Claude Code calling the agent over MCP)
//
// `thread`   = one Mastra thread. In the Chat tab that's one of the
//              conversations from the conversation switcher. From the
//              IDE every tool call is its own thread (the bridge does
//              not chain calls), so per-thread memory effectively
//              means "no memory" for IDE-only agents.
// `resource` = the agent itself, across every Chat-tab conversation
//              AND every IDE tool call. The only useful scope for
//              agents that primarily get called from an IDE.
const SCOPE_OPTS: DropdownOption<MemoryScope>[] = memoryScopes.map((s) => ({
  value: s,
  label: s === 'thread' ? 'Per thread' : 'Per agent',
  sub:
    s === 'thread'
      ? 'one Chat-tab conversation, or one IDE call'
      : 'every Chat-tab conversation + every IDE call',
}))

function ScopeHelp({ agentId }: { agentId: string }) {
  return (
    <>
      In the{' '}
      <Link to={`/agents/${agentId}/chat`} className="ab-text-link">
        Chat tab
      </Link>{' '}
      a "thread" is one of the conversations you start from the
      conversation switcher. From your IDE every tool call is its own
      thread — the bridge does not chain calls — so per-thread memory
      effectively resets every IDE invocation. If this agent is mostly
      called from an IDE, pick per-agent so memory survives between
      calls.
    </>
  )
}

type LastMessagesMode = 'off' | 'count'

export function MemoryTab({ agentId }: { agentId: string }) {
  const { agents, llmProviders, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)

  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [lastMode, setLastMode] = useState<LastMessagesMode>('count')
  const [lastN, setLastN] = useState(20)
  const [generateTitle, setGenerateTitle] = useState(false)

  // working memory
  const [wmEnabled, setWmEnabled] = useState(false)
  const [wmTemplate, setWmTemplate] = useState('')
  const [wmScope, setWmScope] = useState<MemoryScope>('thread')

  // semantic recall
  const [srEnabled, setSrEnabled] = useState(false)
  const [srTopK, setSrTopK] = useState(5)
  const [srMessageRange, setSrMessageRange] = useState(2)
  const [srScope, setSrScope] = useState<MemoryScope>('thread')

  const [busy, setBusy] = useState(false)

  if (agent && seededFor !== agent.id) {
    setSeededFor(agent.id)
    setEnabled(agent.memoryEnabled)
    const cfg = agent.memoryConfig ?? null
    if (cfg?.lastMessages === false) {
      setLastMode('off')
      setLastN(20)
    } else if (typeof cfg?.lastMessages === 'number') {
      setLastMode('count')
      setLastN(cfg.lastMessages)
    } else {
      setLastMode('count')
      setLastN(20)
    }
    setGenerateTitle(cfg?.generateTitle ?? false)
    setWmEnabled(cfg?.workingMemory?.enabled ?? false)
    setWmTemplate(cfg?.workingMemory?.template ?? '')
    setWmScope(cfg?.workingMemory?.scope ?? 'thread')
    setSrEnabled(cfg?.semanticRecall !== undefined)
    setSrTopK(cfg?.semanticRecall?.topK ?? 5)
    const range = cfg?.semanticRecall?.messageRange
    setSrMessageRange(typeof range === 'number' ? range : 2)
    setSrScope(cfg?.semanticRecall?.scope ?? 'thread')
  }

  const provider = useMemo(
    () =>
      agent?.llmProviderId
        ? llmProviders.find((p) => p.id === agent.llmProviderId)
        : null,
    [llmProviders, agent],
  )
  const semanticPossible = !!provider?.defaultEmbeddingModel

  if (!agent) return null

  const save = async () => {
    setBusy(true)
    try {
      const config: Record<string, unknown> = {}
      if (lastMode === 'off') config.lastMessages = false
      else config.lastMessages = lastN
      if (generateTitle) config.generateTitle = true
      if (wmEnabled) {
        const wm: Record<string, unknown> = { enabled: true, scope: wmScope }
        if (wmTemplate.trim()) wm.template = wmTemplate.trim()
        config.workingMemory = wm
      }
      if (srEnabled) {
        config.semanticRecall = {
          topK: srTopK,
          messageRange: srMessageRange,
          scope: srScope,
        }
      }

      await patchAgent(agent.id, {
        memoryEnabled: enabled,
        memoryConfig:
          enabled && Object.keys(config).length > 0
            ? (config as never)
            : null,
      })
      toast.success('Memory settings saved')
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

  return (
    <div>
      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">Memory</div>
            <div className="ab-section-sub">
              Master switch for {agent.name}'s memory subsystem. Turn this
              on to enable any of the three strategies below — recent
              messages, working memory, semantic recall. They're
              independent; mix and match as needed.
            </div>
          </div>
          <Pill kind={enabled ? 'success' : 'neutral'} dot>
            {enabled ? 'Enabled' : 'Disabled'}
          </Pill>
          <Button
            variant={enabled ? 'secondary' : 'primary'}
            onClick={() => setEnabled((v) => !v)}
          >
            {enabled ? 'Disable' : 'Enable memory'}
          </Button>
        </div>
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
      >
        <div className="ab-section-head">
          <div className="ab-eyebrow ab-mono">Strategy · sliding window</div>
          <div className="ab-section-title">Recent messages</div>
          <div className="ab-section-sub">
            Replay the last N turns of the active thread before each
            request. Higher N = better continuity, larger context window.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <span className="ab-field-label">Mode</span>
            <Dropdown<LastMessagesMode>
              value={lastMode}
              onChange={setLastMode}
              options={[
                { value: 'count', label: 'Replay last N messages' },
                { value: 'off', label: 'Off (cold start every turn)' },
              ]}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="mt-lastn">
              N
            </label>
            <input
              id="mt-lastn"
              className="ab-input ab-mono"
              type="number"
              min={0}
              max={1000}
              value={lastN}
              onChange={(e) => setLastN(Math.max(0, Number(e.target.value)))}
              disabled={lastMode === 'off'}
            />
          </div>
          <div className="ab-field ab-field-col">
            <label
              className="ab-field-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <input
                type="checkbox"
                checked={generateTitle}
                onChange={(e) => setGenerateTitle(e.target.checked)}
              />
              Auto-generate thread titles
            </label>
            <span className="ab-field-help">
              Mastra summarises the thread into a short title once enough
              messages accumulate.
            </span>
          </div>
        </div>
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
      >
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-eyebrow ab-mono">Strategy · scratchpad</div>
            <div className="ab-section-title">Working memory</div>
            <div className="ab-section-sub">
              A markdown notebook the agent reads and writes to across
              turns — user preferences, names, project facts, anything
              the agent should remember beyond the current message
              window.
            </div>
          </div>
          <Button
            variant={wmEnabled ? 'secondary' : 'ghost'}
            onClick={() => setWmEnabled((v) => !v)}
          >
            {wmEnabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {wmEnabled && (
          <div className="ab-field-grid">
            <div className="ab-field ab-field-col">
              <span className="ab-field-label">Scope</span>
              <Dropdown<MemoryScope>
                value={wmScope}
                onChange={setWmScope}
                options={SCOPE_OPTS}
              />
              <span className="ab-field-help">
                <ScopeHelp agentId={agentId} />
              </span>
            </div>
            <div className="ab-field ab-field-col">
              <label className="ab-field-label" htmlFor="mt-tmpl">
                Template (markdown)
              </label>
              <textarea
                id="mt-tmpl"
                className="ab-textarea ab-mono"
                rows={6}
                value={wmTemplate}
                onChange={(e) => setWmTemplate(e.target.value)}
                placeholder="# User context&#10;- Name:&#10;- Role:&#10;# Project facts&#10;- "
              />
              <span className="ab-field-help">
                Optional starter shape. The agent fills these in over time.
              </span>
            </div>
          </div>
        )}
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={
          enabled && semanticPossible
            ? undefined
            : { opacity: 0.5, pointerEvents: 'none' }
        }
      >
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-eyebrow ab-mono">Strategy · vector retrieval</div>
            <div className="ab-section-title">Semantic recall</div>
            <div className="ab-section-sub">
              Embed every assistant turn and pull the top-K most-similar
              chunks back into context before answering. Useful when
              relevant prior turns sit outside the recent-messages
              window. Requires an embedding model on the LLM provider.
            </div>
          </div>
          {!semanticPossible && (
            <Pill kind="warn" dot>
              Embedding model not set
            </Pill>
          )}
          <Button
            variant={srEnabled ? 'secondary' : 'ghost'}
            onClick={() => setSrEnabled((v) => !v)}
            disabled={!semanticPossible}
          >
            {srEnabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {!semanticPossible && provider && (
          <div
            className="ab-field-help"
            style={{
              marginTop: 8,
              padding: '10px 12px',
              background: 'var(--surface-hi)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
            }}
          >
            Your provider <strong>{provider.label}</strong> doesn't have a
            default embedding model selected yet. Embedding models live on
            the LLM provider row so you choose deliberately — switching
            them later invalidates any vectors already stored.{' '}
            <Link
              to={`/library/providers/${provider.id}`}
              style={{ color: 'var(--accent-300)' }}
            >
              Pick one in the provider settings →
            </Link>
          </div>
        )}
        {!semanticPossible && !provider && (
          <div
            className="ab-field-help"
            style={{ marginTop: 8, color: 'var(--warn)' }}
          >
            Attach an LLM provider to this agent first — semantic recall
            uses the provider's embedding model.
          </div>
        )}
        {srEnabled && (
          <div className="ab-field-grid">
            <div className="ab-field">
              <label className="ab-field-label" htmlFor="mt-topk">
                Top K
              </label>
              <input
                id="mt-topk"
                className="ab-input ab-mono"
                type="number"
                min={1}
                max={100}
                value={srTopK}
                onChange={(e) => setSrTopK(Math.max(1, Number(e.target.value)))}
              />
            </div>
            <div className="ab-field">
              <label className="ab-field-label" htmlFor="mt-range">
                Message range
              </label>
              <input
                id="mt-range"
                className="ab-input ab-mono"
                type="number"
                min={0}
                value={srMessageRange}
                onChange={(e) =>
                  setSrMessageRange(Math.max(0, Number(e.target.value)))
                }
              />
            </div>
            <div className="ab-field ab-field-col">
              <span className="ab-field-label">Scope</span>
              <Dropdown<MemoryScope>
                value={srScope}
                onChange={setSrScope}
                options={SCOPE_OPTS}
              />
              <span className="ab-field-help">
                <ScopeHelp agentId={agentId} />
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save memory settings'}
        </Button>
      </div>
    </div>
  )
}
