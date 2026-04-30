/**
 * Logs tab — wired to the real SSE stream for live activity AND to
 * `listRuns({ agentId })` for run history. Together they answer
 * "what's this agent doing right now and what has it done lately?".
 */

import { useEffect, useMemo, useState } from 'react'
import { type RunEvent, type RunListRow } from '@agent-bridge/shared'
import { ApiError, listRuns } from '../../lib/rpc'
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
  ping: 'info',
}

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

  // Newest first.
  const logRows = useMemo<readonly LogRow[]>(
    () =>
      [...events]
        .reverse()
        .filter((e) => e.kind !== 'ping' && e.kind !== 'run.token' && e.kind !== 'run.token.batch')
        .map((e) => eventToRow(e)),
    [events],
  )

  // Run history (rolled up at the bottom). The runs API doesn't
  // expose a cursor, so we cap at 100 (server max) and offer a
  // collapsible disclosure beyond the top 25.
  const [runs, setRuns] = useState<readonly RunListRow[]>([])
  const [runsErr, setRunsErr] = useState<string | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Reset stored runs when agent changes — derived state pattern.
  const [runsAgentId, setRunsAgentId] = useState(agentId)
  if (runsAgentId !== agentId) {
    setRunsAgentId(agentId)
    setRuns([])
    setShowAll(false)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!alive) return
      setRunsLoading(true)
      try {
        const res = await listRuns({ agentId, limit: 100 })
        if (!alive) return
        setRuns(res.runs)
      } catch (err) {
        if (alive) {
          setRunsErr(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load runs',
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

  const visibleRuns = showAll ? runs : runs.slice(0, 25)

  const filtered = logRows.filter((row) => {
    if (filter === 'run' && row.level !== 'run') return false
    if (filter === 'tool' && row.level !== 'tool') return false
    if (filter === 'error' && row.level !== 'error' && row.level !== 'warn') {
      return false
    }
    if (query) {
      const hay = `${row.source} ${row.msg} ${row.detail ?? ''}`.toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  })

  return (
    <div>
      <div className="ab-logs-toolbar">
        <div className="ab-search" style={{ maxWidth: 280 }}>
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter logs…"
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

      {filtered.length === 0 ? (
        // Three cases:
        //  (a) An active filter / query yielded no matches — show a
        //      compact "no matches" hint so the user knows the filter
        //      is the cause.
        //  (b) No live events yet, but the run-history card below
        //      already has rows — skip the big empty state entirely;
        //      it would contradict the visible history.
        //  (c) Truly empty agent (no live events, no past runs) — show
        //      the friendly first-time copy.
        filter !== 'all' || query ? (
          <div className="ab-section-sub" style={{ padding: '24px 4px' }}>
            No events match this filter.
          </div>
        ) : runs.length > 0 ? null : (
          <EmptyState
            glyph={<SearchIcon />}
            title={
              connected
                ? 'Waiting for activity'
                : 'Connecting to live event stream…'
            }
            body={
              connected
                ? 'Send the agent a chat message, attach a repo, or wait for the next IDE invocation — events stream here in real time.'
                : 'Once the SSE connection comes up, every run, tool call, and config change shows up here.'
            }
          />
        )
      ) : (
        <div className="ab-logs-table">
          {filtered.map((row) => (
            <div key={row.id} className="ab-log-row">
              <span className="ab-log-time">{formatTime(row.ts)}</span>
              <Tooltip label={LEVEL_HINT[row.level]} side="top">
                <span className={`ab-log-level is-${row.level}`}>
                  {row.level}
                </span>
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
                    · {row.detail.length > 120 ? row.detail.slice(0, 120) + '…' : row.detail}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <RunHistorySection
        runs={visibleRuns}
        totalCount={runs.length}
        err={runsErr}
        loading={runsLoading}
        canExpand={runs.length > 25 && !showAll}
        onExpand={() => setShowAll(true)}
      />
    </div>
  )
}

function RunHistorySection({
  runs,
  totalCount,
  err,
  loading,
  canExpand,
  onExpand,
}: {
  runs: readonly RunListRow[]
  totalCount: number
  err: string | null
  loading: boolean
  canExpand: boolean
  onExpand: () => void
}) {
  return (
    <div style={{ marginTop: 24 }}>
      <div className="ab-logs-section-head">
        <span className="ab-logs-section-title">Run history</span>
        <span className="ab-logs-section-sub">
          {loading
            ? 'Loading…'
            : totalCount === 0
              ? 'No past runs'
              : `${runs.length} of ${totalCount}`}
        </span>
      </div>
      {err && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)', marginBottom: 8 }}
        >
          {err}
        </div>
      )}
      {runs.length > 0 && (
        <div className="ab-logs-table">
          {runs.map((row) => (
            <RunHistoryRow key={row.id} row={row} />
          ))}
        </div>
      )}
      {canExpand && (
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <Button variant="ghost" size="sm" onClick={onExpand}>
            Show all {totalCount} runs
          </Button>
        </div>
      )}
    </div>
  )
}

function RunHistoryRow({ row }: { row: RunListRow }) {
  // Map run status onto the same level/color system as live log rows
  // so the visual language stays consistent across the whole page.
  const level: LogLevel =
    row.status === 'error' || row.status === 'aborted' ? 'error' : 'run'
  const startedAt = Date.parse(row.startedAt)
  const meta = [
    row.source,
    formatRelative(startedAt),
    row.durationMs !== null ? formatDuration(row.durationMs) : null,
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
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s}s`
}
