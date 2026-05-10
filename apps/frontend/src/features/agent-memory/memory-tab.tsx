/**
 * Memory tab — Mastra-backed agent memory configuration. Toggles
 * the memory engine on/off, then surfaces the three sub-systems:
 * `lastMessages` window, working-memory template, and
 * semantic-recall via embeddings.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  memoryScopes,
  type AgentThreadSummary,
  type MemoryScope,
  type WorkingMemoryResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import {
  ApiError,
  getAgentWorkingMemory,
  listAgentThreads,
} from '../../lib/rpc'
import { Link } from '../../lib/link'
import { RefreshIcon } from '../../ui/icons'

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
      <br />
      <br />
      <strong>Switching scope is non-destructive:</strong> content from
      the previous scope stays in storage, just hidden from the agent
      until you switch back. So flipping per-agent → per-thread doesn't
      delete your accumulated agent-level notes — it just makes new
      conversations start fresh.
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

  // Semantic recall depends on the workspace embedding provider — the
  // singleton row with `role='embedding'`. Configure one in the
  // provider library to enable recall.
  const embeddingDefault = useMemo(
    () =>
      llmProviders.find(
        (p) => p.role === 'embedding' && !!p.defaultModel,
      ) ?? null,
    [llmProviders],
  )
  const semanticPossible = !!embeddingDefault

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
            <div
              className="ab-field-help"
              style={{ marginTop: 6, color: 'var(--warn)' }}
            >
              Heads up: working memory injects a system message on every
              turn. Cloud frontier models (OpenAI, Anthropic, Gemini)
              accept this fine. Some local-model chat templates
              (Qwen, certain Mistral variants) reject any system
              message past position 0 with a Jinja error — disable
              this on those agents and lean on <em>Recent messages</em>{' '}
              for continuity.
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
            <div className="ab-field ab-field-col" style={{ gridColumn: '1 / -1' }}>
              <CurrentScratchpad agentId={agentId} scope={wmScope} />
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
              window. Uses the workspace embedding default — set it
              once in Library and every agent shares the same vector
              space.
            </div>
          </div>
          {!semanticPossible && (
            <Pill kind="warn" dot>
              No workspace embedding default
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
        {semanticPossible && embeddingDefault && (
          <div
            className="ab-field-help"
            style={{ marginTop: 8 }}
          >
            Workspace embedder:{' '}
            <strong>{embeddingDefault.label}</strong> ·{' '}
            <code className="ab-mono">
              {embeddingDefault.defaultModel}
            </code>
          </div>
        )}
        {!semanticPossible && (
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
            No embedding provider is configured. Add one in the{' '}
            <Link
              to="/library/providers"
              style={{ color: 'var(--accent-300)' }}
            >
              provider library →
            </Link>{' '}
            (create a provider with role <code className="ab-mono">embedding</code>{' '}
            and pick a model). One embedding provider serves the whole
            workspace.
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

/**
 * Read-only viewer for the live working-memory scratchpad. Sits below
 * the template field so the operator can see what the LLM has
 * actually written into the notebook over time. For per-thread
 * scope, surfaces a thread picker since each thread has its own.
 */
function CurrentScratchpad({
  agentId,
  scope,
}: {
  agentId: string
  scope: MemoryScope
}) {
  const [data, setData] = useState<WorkingMemoryResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [threads, setThreads] = useState<readonly AgentThreadSummary[]>([])
  const [pickedThreadId, setPickedThreadId] = useState<string | null>(null)

  // Reset thread picker when agent changes — derived-state pattern.
  const [seededFor, setSeededFor] = useState<string>(agentId)
  if (seededFor !== agentId) {
    setSeededFor(agentId)
    setPickedThreadId(null)
    setThreads([])
    setData(null)
  }

  // Per-thread scope: load the thread list so the user can pick which
  // one's scratchpad to view. Per-agent scope: skip the picker entirely.
  useEffect(() => {
    if (scope !== 'thread') return
    let alive = true
    void (async () => {
      try {
        const list = await listAgentThreads(agentId)
        if (!alive) return
        setThreads(list)
        // Auto-pick the most recent thread so the user sees something
        // by default instead of an empty dropdown.
        if (list.length > 0 && pickedThreadId === null) {
          setPickedThreadId(list[0]!.threadId)
        }
      } catch {
        // List failures are non-critical — the panel just shows the
        // "pick a thread" empty state.
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, scope, pickedThreadId])

  // Fetch the scratchpad whenever the agent, scope, picked thread, or
  // refresh-key changes.
  useEffect(() => {
    let alive = true
    void (async () => {
      if (alive) setLoading(true)
      setErr(null)
      try {
        const res = await getAgentWorkingMemory(
          agentId,
          scope === 'thread' ? (pickedThreadId ?? undefined) : undefined,
        )
        if (alive) setData(res)
      } catch (e) {
        if (!alive) return
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to load',
        )
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, scope, pickedThreadId, refreshKey])

  const threadOpts: DropdownOption[] = useMemo(
    () =>
      threads.map((t) => ({
        value: t.threadId,
        label: t.title ?? t.threadId.slice(0, 8) + '…',
        sub: `${t.messageCount} message${t.messageCount === 1 ? '' : 's'}`,
      })),
    [threads],
  )

  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 14,
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
            Current scratchpad
          </div>
          <div className="ab-field-help" style={{ marginTop: 2 }}>
            What the agent has actually written into the notebook.
            {scope === 'thread' && ' One per conversation.'}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          leading={<RefreshIcon />}
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {scope === 'thread' && (
        <div style={{ marginBottom: 10 }}>
          {threads.length === 0 ? (
            <div className="ab-field-help">
              No conversations yet. Start one in the Chat tab to see
              this thread's scratchpad here.
            </div>
          ) : (
            <Dropdown
              value={pickedThreadId}
              onChange={setPickedThreadId}
              options={threadOpts}
              placeholder="Pick a conversation"
            />
          )}
        </div>
      )}

      {err && (
        <div className="ab-field-help" style={{ color: 'var(--danger)' }}>
          {err}
        </div>
      )}

      {!err && data?.disabled && (
        <div className="ab-field-help">
          Working memory isn't enabled. Toggle it on above to start
          recording.
        </div>
      )}

      {!err && !data?.disabled && data !== null && (
        <>
          {data.content === null ? (
            <div className="ab-field-help">
              No scratchpad recorded yet for this scope.
            </div>
          ) : data.content.trim() === '' ? (
            <div className="ab-field-help">
              The agent hasn't written anything to the scratchpad yet.
              On capable models this fills in as the conversation
              progresses; on smaller models the scratchpad may stay
              blank.
            </div>
          ) : (
            <pre
              style={{
                margin: 0,
                padding: '12px 14px',
                background: 'var(--surface-hi)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--text)',
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {data.content}
            </pre>
          )}
        </>
      )}

      {loading && data === null && (
        <div className="ab-field-help">Loading…</div>
      )}
    </div>
  )
}
