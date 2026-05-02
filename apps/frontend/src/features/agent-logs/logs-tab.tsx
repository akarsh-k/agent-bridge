/**
 * Logs tab — single chronological timeline that merges live SSE events
 * with completed-run history into one feed. A row can be an `event`
 * (granular: `run.tool.called`, `repo.index.progress`, etc.) or a
 * `run` (one row per completed agent invocation, with prompt + reply
 * preview). Both share the same toolbar, filters, and search.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  type AgentConfigEventResponse,
  type RunEvent,
  type RunListRow,
} from '@agent-bridge/shared'
import { ApiError, listAgentConfigEvents, listRuns } from '../../lib/rpc'
import { Button } from '../../ui/button'
import { Tooltip } from '../../ui/tooltip'
import { ExportIcon, SearchIcon } from '../../ui/icons'
import { EmptyState } from '../../ui/empty'

type LogLevel = 'info' | 'run' | 'tool' | 'warn' | 'error'

const LEVEL_HINT: Record<LogLevel, string> = {
  info: 'Provider / runtime info — completions, token usage, healthchecks',
  run: 'Run lifecycle — start / finish for one agent invocation',
  tool: 'Tool call — agent invoked a function or MCP method',
  warn: 'Warning — recoverable, often transient',
  error: 'Error — the run or job failed',
}

interface LogRow {
  id: string
  ts: number
  level: LogLevel
  source: string
  msg: string
  detail?: string
}

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'run', label: 'Runs' },
  { value: 'tool', label: 'Tools' },
  { value: 'config', label: 'Config' },
  { value: 'error', label: 'Errors' },
] as const
type Filter = (typeof FILTERS)[number]['value']

const LEVEL_FROM_KIND: Record<string, LogLevel> = {
  'run.started': 'run',
  'run.finished': 'run',
  'run.error': 'error',
  'run.token': 'info',
  'run.token.batch': 'info',
  'run.step.started': 'info',
  'run.step.finished': 'info',
  'run.tool.called': 'tool',
  'run.tool.result': 'tool',
  'run.mcp.log': 'tool',
  'worker.progress': 'info',
  'worker.log': 'info',
  'worker.finished': 'info',
  'worker.error': 'error',
  'repo.clone.started': 'info',
  'repo.clone.progress': 'info',
  'repo.clone.ok': 'info',
  'repo.clone.fail': 'error',
  'repo.index.started': 'info',
  'repo.index.progress': 'info',
  'repo.index.ok': 'info',
  'repo.index.fail': 'error',
  'repo.wiki.started': 'info',
  'repo.wiki.progress': 'info',
  'repo.wiki.ok': 'info',
  'repo.wiki.fail': 'error',
  'agent.config.changed': 'info',
  // Coding-agent toolkit telemetry. bucket under `tool` so the
  // existing Tools filter surfaces them alongside `run.tool.called`
  // / `run.tool.result`. They describe IDE-bridge tool activity, not
  // a separate concept worth a new top-level filter.
  'coding-agent.repo.resolved': 'tool',
  'coding-agent.repo.clarification_requested': 'tool',
  'coding-agent.tool.completed': 'tool',
  ping: 'info',
}

// Discriminated row for the unified timeline. Three sources stitched
// into one chronological feed:
//   - `event` rows from the live SSE stream (granular: tool calls,
//     step starts, repo progress, etc.).
//   - `run` rows from `listRuns` (one per completed agent invocation,
//     with prompt + reply preview).
//   - `config` rows from `listAgentConfigEvents` (persisted history
//     of agent.config.changed: skill added, repo attached, MCP
//     allowlist replaced, etc.). Live SSE config frames get deduped
//     against these by timestamp so we don't show both.
type UnifiedRow =
  | { kind: 'event'; id: string; ts: number; row: LogRow }
  | { kind: 'run'; id: string; ts: number; run: RunListRow }
  | {
      kind: 'config'
      id: string
      ts: number
      event: AgentConfigEventResponse
    }

const ROW_LIMIT_COLLAPSED = 50

export function LogsTab({
  agentId,
  events,
  connected,
}: {
  agentId: string
  events: readonly RunEvent[]
  connected: boolean
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  // Live events from the SSE stream. Drop the noisy ones (per-token,
  // pings) before mapping — they'd dominate the feed and aren't useful
  // at this granularity.
  const eventRows = useMemo<readonly LogRow[]>(
    () =>
      events
        .filter(
          (e) =>
            e.kind !== 'ping' &&
            e.kind !== 'run.token' &&
            e.kind !== 'run.token.batch',
        )
        .map((e) => eventToRow(e)),
    [events],
  )

  // Past runs + persisted config events from the API. Both are fetched
  // newest-first (the run-list endpoint caps at 100, the config-events
  // endpoint at 100 by default). Loading either is independent — a
  // failure on one shouldn't break the other.
  const [runs, setRuns] = useState<readonly RunListRow[]>([])
  const [configEvents, setConfigEvents] = useState<
    readonly AgentConfigEventResponse[]
  >([])
  const [runsErr, setRunsErr] = useState<string | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Reset cached state when the user navigates between agents.
  const [runsAgentId, setRunsAgentId] = useState(agentId)
  if (runsAgentId !== agentId) {
    setRunsAgentId(agentId)
    setRuns([])
    setConfigEvents([])
    setShowAll(false)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!alive) return
      setRunsLoading(true)
      try {
        const [runsRes, configRes] = await Promise.all([
          listRuns({ agentId, limit: 100 }),
          listAgentConfigEvents(agentId, 100),
        ])
        if (!alive) return
        setRuns(runsRes.runs)
        setConfigEvents(configRes)
      } catch (err) {
        if (alive) {
          setRunsErr(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load activity',
          )
        }
      } finally {
        if (alive) setRunsLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId])

  // Merge events + runs + persisted config events into one
  // chronological list.
  //
  // Dedupe rules:
  //   - Live `run.started` / `run.finished` events: drop when the
  //     run's id already appears in the history list (the run row is
  //     the canonical summary).
  //   - Live `agent.config.changed` events: drop when a persisted
  //     config event has the same ts within ±2s (the SSE frame and
  //     the audit row come from the same publishAgentConfig call).
  const unified = useMemo<readonly UnifiedRow[]>(() => {
    const knownRunIds = new Set(runs.map((r) => r.id))
    const persistedConfigTs = configEvents.map((e) => Date.parse(e.ts) || 0)
    const eventEntries: UnifiedRow[] = eventRows
      .filter((row) => {
        if (runRowIdCollidesWithKnownRun(row, knownRunIds)) return false
        if (row.source === 'config') {
          // Within 2s of any persisted config row → dedupe.
          for (const ts of persistedConfigTs) {
            if (Math.abs(ts - row.ts) <= 2000) return false
          }
        }
        return true
      })
      .map((row) => ({ kind: 'event', id: row.id, ts: row.ts, row }))
    const runEntries: UnifiedRow[] = runs.map((run) => ({
      kind: 'run',
      id: `run:${run.id}`,
      ts: Date.parse(run.startedAt) || 0,
      run,
    }))
    const configEntries: UnifiedRow[] = configEvents.map((event) => ({
      kind: 'config',
      id: `cfg:${event.id}`,
      ts: Date.parse(event.ts) || 0,
      event,
    }))
    return [...eventEntries, ...runEntries, ...configEntries].sort(
      (a, b) => b.ts - a.ts,
    )
  }, [eventRows, runs, configEvents])

  const filtered = useMemo(
    () =>
      unified
        .filter((u) => {
          // Filter chips:
          //   - 'run'    : live run.* events + run history rows
          //   - 'tool'   : live tool events only
          //   - 'config' : config rows + live agent.config.changed events
          //   - 'error'  : warn/error events + failed/aborted runs
          if (filter === 'run') {
            if (u.kind === 'run') return true
            if (u.kind === 'event' && u.row.level === 'run') return true
            return false
          }
          if (filter === 'tool') {
            return u.kind === 'event' && u.row.level === 'tool'
          }
          if (filter === 'config') {
            if (u.kind === 'config') return true
            if (u.kind === 'event' && u.row.source === 'config') return true
            return false
          }
          if (filter === 'error') {
            if (u.kind === 'event') {
              return u.row.level === 'error' || u.row.level === 'warn'
            }
            if (u.kind === 'run') {
              return u.run.status === 'error' || u.run.status === 'aborted'
            }
            return false
          }
          return true
        })
        .filter((u) => {
          if (!query) return true
          const q = query.toLowerCase()
          if (u.kind === 'event') {
            const hay =
              `${u.row.source} ${u.row.msg} ${u.row.detail ?? ''}`.toLowerCase()
            return hay.includes(q)
          }
          if (u.kind === 'run') {
            const hay = [
              u.run.source,
              u.run.status,
              u.run.inputPromptPreview,
              u.run.outputSummaryPreview,
              u.run.errorMessage,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
            return hay.includes(q)
          }
          const hay = [
            u.event.action,
            u.event.resource,
            u.event.label,
            u.event.detail,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return hay.includes(q)
        }),
    [unified, filter, query],
  )

  const visible = showAll ? filtered : filtered.slice(0, ROW_LIMIT_COLLAPSED)
  const hiddenCount = filtered.length - visible.length

  return (
    <div>
      <div className="ab-logs-toolbar">
        <div className="ab-search" style={{ maxWidth: 280 }}>
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter activity…"
          />
        </div>
        <div className="ab-filter-chips">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={'ab-chip' + (filter === f.value ? ' is-active' : '')}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span
          className="ab-live-chip"
          style={!connected ? { opacity: 0.55 } : undefined}
        >
          {connected ? <span className="ab-pulse-dot" /> : null}
          {connected ? 'Streaming' : 'Disconnected'}
        </span>
        <Button variant="secondary" size="sm" leading={<ExportIcon />}>
          Export
        </Button>
      </div>

      {runsErr && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)', marginBottom: 8 }}
        >
          Couldn't load past runs: {runsErr}
        </div>
      )}

      {filtered.length === 0 ? (
        filter !== 'all' || query ? (
          <div className="ab-section-sub" style={{ padding: '24px 4px' }}>
            No activity matches this filter.
          </div>
        ) : runsLoading ? (
          <div className="ab-section-sub" style={{ padding: '24px 4px' }}>
            Loading run history…
          </div>
        ) : (
          <EmptyState
            glyph={<SearchIcon />}
            title={
              connected
                ? 'Waiting for activity'
                : 'Connecting to live event stream…'
            }
            body={
              connected
                ? 'Send the agent a chat message, attach a repo, or wait for the next IDE invocation — runs and events stream here in real time.'
                : 'Once the SSE connection comes up, every run, tool call, and config change shows up here.'
            }
          />
        )
      ) : (
        <>
          <div className="ab-logs-table">
            {visible.map((u) => {
              if (u.kind === 'event') return <EventRow key={u.id} row={u.row} />
              if (u.kind === 'run')
                return <RunHistoryRow key={u.id} row={u.run} />
              return <ConfigEventRow key={u.id} event={u.event} />
            })}
          </div>
          {hiddenCount > 0 && (
            <div style={{ marginTop: 8, textAlign: 'center' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
              >
                Show all {filtered.length} entries ({hiddenCount} more)
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Suppress live `run.started` / `run.finished` event rows for runs
 * that are also present in the canonical run-history list — the run
 * row already shows status + duration, and showing both would
 * triple-stack the same event in the timeline.
 */
function runRowIdCollidesWithKnownRun(
  row: LogRow,
  knownRunIds: ReadonlySet<string>,
): boolean {
  if (row.level !== 'run') return false
  // event ids are formatted `${kind}:${ts}:rand`, but the runId itself
  // is embedded in the message. Use a lightweight check on the source
  // text since we don't carry runId on the LogRow shape.
  for (const id of knownRunIds) {
    if (row.msg.includes(id.slice(0, 8))) return true
  }
  return false
}

function ConfigEventRow({ event }: { event: AgentConfigEventResponse }) {
  const ts = Date.parse(event.ts)
  // Mirror the LEVEL_FROM_KIND mapping for live agent.config.changed
  // events ('info') so config history rows visually match the live
  // ones the user already saw stream past in real time.
  return (
    <div className="ab-log-row">
      <span className="ab-log-time">
        {Number.isNaN(ts) ? '' : formatTime(ts)}
      </span>
      <Tooltip label={LEVEL_HINT.info} side="top">
        <span className="ab-log-level is-info">info</span>
      </Tooltip>
      <span className="ab-log-msg">
        <span
          className="ab-log-source"
          style={{ marginRight: 8 }}
          title="config"
        >
          config
        </span>
        {event.action} {event.resource}: {event.label}
        {event.detail && (
          <span
            style={{
              marginLeft: 8,
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
            }}
            title={event.detail}
          >
            ·{' '}
            {event.detail.length > 120
              ? event.detail.slice(0, 120) + '…'
              : event.detail}
          </span>
        )}
      </span>
    </div>
  )
}

function EventRow({ row }: { row: LogRow }) {
  return (
    <div className="ab-log-row">
      <span className="ab-log-time">{formatTime(row.ts)}</span>
      <Tooltip label={LEVEL_HINT[row.level]} side="top">
        <span className={`ab-log-level is-${row.level}`}>{row.level}</span>
      </Tooltip>
      <span className="ab-log-msg">
        <span
          className="ab-log-source"
          style={{ marginRight: 8 }}
          title={row.source}
        >
          {row.source}
        </span>
        {row.msg}
        {row.detail && (
          <span
            style={{
              marginLeft: 8,
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
            }}
            title={row.detail}
          >
            ·{' '}
            {row.detail.length > 120
              ? row.detail.slice(0, 120) + '…'
              : row.detail}
          </span>
        )}
      </span>
    </div>
  )
}

function RunHistoryRow({ row }: { row: RunListRow }) {
  // Map run status onto the same level/color system as live log rows
  // so the visual language stays consistent across the whole page.
  const level: LogLevel =
    row.status === 'error' || row.status === 'aborted' ? 'error' : 'run'
  const startedAt = Date.parse(row.startedAt)
  // Roll input/output tokens into one display string ("12.3k → 187")
  // so the meta line stays compact. Both can be null when the LLM
  // provider didn't echo a usage object (some local servers skip it).
  const tokensLabel =
    row.promptTokens !== null && row.completionTokens !== null
      ? `${formatTokens(row.promptTokens)} → ${formatTokens(row.completionTokens)}`
      : null
  const meta = [
    row.source,
    formatRelative(startedAt),
    row.durationMs !== null ? formatDuration(row.durationMs) : null,
    tokensLabel,
  ]
    .filter(Boolean)
    .join(' · ')
  // Reply / failure detail to surface inline under the prompt. Errors
  // win the slot; otherwise show the agent's outputSummary preview so
  // the user can scan "what was asked" + "what was answered" inline.
  const reply = row.errorMessage ?? row.outputSummaryPreview
  const replyKind: 'error' | 'reply' | null = row.errorMessage
    ? 'error'
    : row.outputSummaryPreview
      ? 'reply'
      : null
  return (
    <div className="ab-log-row">
      <span className="ab-log-time">
        {Number.isNaN(startedAt) ? '' : formatTime(startedAt)}
      </span>
      <span className={`ab-log-level is-${level}`}>{row.status}</span>
      <span className="ab-log-msg">
        <span
          className="ab-log-source"
          style={{ marginRight: 8 }}
          title={row.source}
        >
          {meta}
        </span>
        <span style={{ color: 'var(--text)' }}>
          {row.inputPromptPreview}
        </span>
        {reply && (
          <div
            style={{
              marginTop: 4,
              paddingLeft: 14,
              borderLeft: `2px solid ${
                replyKind === 'error'
                  ? 'var(--danger)'
                  : 'var(--accent-border)'
              }`,
              color:
                replyKind === 'error' ? 'var(--danger)' : 'var(--text-dim)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
              overflow: 'hidden',
            }}
            title={reply}
          >
            {reply}
          </div>
        )}
      </span>
    </div>
  )
}

function eventToRow(e: RunEvent): LogRow {
  const level = LEVEL_FROM_KIND[e.kind] ?? 'info'
  const ts = e.ts
  const id = `${e.kind}:${ts}:${Math.random().toString(36).slice(2, 6)}`
  const source = sourceFor(e)
  const { msg, detail } = bodyFor(e)
  return { id, ts, level, source, msg, detail }
}

function sourceFor(e: RunEvent): string {
  if (e.kind.startsWith('coding-agent.')) return 'bridge'
  if (e.kind.startsWith('run.')) return 'agent'
  if (e.kind.startsWith('worker.')) return 'worker'
  if (e.kind.startsWith('repo.')) return 'repo'
  if (e.kind === 'agent.config.changed') return 'config'
  return e.kind
}

function bodyFor(e: RunEvent): { msg: string; detail?: string } {
  switch (e.kind) {
    case 'run.started':
      return { msg: `Run started · ${shortId((e.data as { runId?: string }).runId ?? '')}` }
    case 'run.finished': {
      const d = e.data as { runId?: string; durationMs?: number }
      return {
        msg: `Run finished · ${shortId(d.runId ?? '')} · ${d.durationMs ?? '?'}ms`,
      }
    }
    case 'run.error': {
      const d = e.data as { message?: string; kind?: string }
      return {
        msg: `Run error: ${d.message ?? 'unknown'}`,
        detail: d.kind,
      }
    }
    case 'run.tool.called': {
      const d = e.data as { toolName?: string; input?: unknown }
      return {
        msg: `Tool called: ${d.toolName ?? '?'}`,
        detail: compactJson(d.input),
      }
    }
    case 'run.tool.result': {
      const d = e.data as { toolName?: string; durationMs?: number }
      return {
        msg: `Tool result: ${d.toolName ?? '?'}${d.durationMs ? ` · ${d.durationMs}ms` : ''}`,
      }
    }
    case 'run.mcp.log': {
      const d = e.data as {
        connectionName?: string
        line?: string
        level?: string
      }
      return {
        msg: `MCP log: ${d.connectionName ?? '?'}`,
        detail: d.line,
      }
    }
    case 'agent.config.changed': {
      const d = e.data as {
        action?: string
        resource?: string
        label?: string
        detail?: string
      }
      const head = `${d.action ?? 'changed'} ${d.resource ?? ''}: ${d.label ?? ''}`
      return { msg: head.trim(), detail: d.detail }
    }
    case 'run.step.started':
    case 'run.step.finished': {
      const d = e.data as { stepIndex?: number; finishReason?: string }
      return {
        msg: `Step ${(d.stepIndex ?? 0) + 1} ${e.kind === 'run.step.started' ? 'started' : 'done'}${d.finishReason ? ` · ${d.finishReason}` : ''}`,
      }
    }
    case 'coding-agent.repo.resolved': {
      const d = e.data as {
        tool?: string
        scope?: 'single' | 'all'
        picked?: { label?: string; matched_signal?: string; confidence?: string } | null
        unresolved_related_count?: number
      }
      if (d.scope === 'all') {
        return { msg: `Coding-agent ${d.tool ?? '?'}: scope=all (every attached repo)` }
      }
      const label = d.picked?.label ?? '?'
      const sig = d.picked?.matched_signal ?? '?'
      const conf = d.picked?.confidence ?? '?'
      const tail = d.unresolved_related_count
        ? ` · ${d.unresolved_related_count} unresolved related`
        : ''
      return {
        msg: `Coding-agent ${d.tool ?? '?'}: resolved → ${label}`,
        detail: `signal=${sig} · confidence=${conf}${tail}`,
      }
    }
    case 'coding-agent.repo.clarification_requested': {
      const d = e.data as {
        tool?: string
        kind?: string
        candidate_count?: number
        allow_all_repos?: boolean
      }
      return {
        msg: `Coding-agent ${d.tool ?? '?'}: clarification requested`,
        detail: `kind=${d.kind ?? '?'} · candidates=${d.candidate_count ?? 0}${d.allow_all_repos ? ' · all_repos allowed' : ''}`,
      }
    }
    case 'coding-agent.tool.completed': {
      const d = e.data as {
        tool?: string
        scope?: string
        confidence?: string
        duration_ms?: number
        groundedness?: { claims: number; grounded: number; ungrounded: number }
        schema_unmatched?: boolean
      }
      const ground = d.groundedness
        ? ` · grounded ${d.groundedness.grounded}/${d.groundedness.claims}`
        : ''
      const schema = d.schema_unmatched ? ' · schema_unmatched' : ''
      return {
        msg: `Coding-agent ${d.tool ?? '?'} completed${d.scope ? ` (${d.scope})` : ''}`,
        detail: `confidence=${d.confidence ?? '?'} · ${d.duration_ms ?? '?'}ms${ground}${schema}`,
      }
    }
    default:
      return {
        msg: e.kind,
        detail: e.data === undefined ? undefined : compactJson(e.data),
      }
  }
}

function shortId(id: string): string {
  return id ? id.slice(0, 8) : ''
}

function compactJson(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  try {
    const s = JSON.stringify(v)
    return s.length > 200 ? s.slice(0, 197) + '…' : s
  } catch {
    return String(v)
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}
function formatRelative(ts: number): string {
  if (Number.isNaN(ts)) return ''
  const delta = Date.now() - ts
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  const m = Math.floor(delta / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function formatTokens(n: number): string {
  if (n < 1_000) return `${n}t`
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`
  return `${Math.round(n / 1_000)}k`
}
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s}s`
}
