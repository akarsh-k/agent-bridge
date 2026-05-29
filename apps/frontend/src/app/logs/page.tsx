/**
 * Global runs feed. The parent-level Logs page — every agent, both
 * UI-chat and IDE-bridge runs, in one chronological table.
 *
 * Reads `listRuns({ limit: 100 })` (no `agentId` filter) so all the
 * workspace's runs surface. Click a row to open the RunDetailSheet
 * (full prompt + output + every run_events entry). Deep-link via
 * `/logs/<runId>` opens that run's detail sheet on mount.
 *
 * Filters available:
 *   - Agent (multi-select) — filter to runs for one or more agents.
 *   - Source — UI / Bridge / All.
 *   - Status — running / completed / error / aborted.
 *   - Search — substring match against agent name, prompt preview,
 *     stream id, error message.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentConfigEventResponse,
  RunEvent,
  RunListRow,
  RunSource,
  RunStatus,
  WorkerJobListRow,
} from '@agent-bridge/shared'
import { agentStreamId } from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import {
  ApiError,
  listAgentConfigEvents,
  listRuns,
  listWorkerJobs,
} from '../../lib/rpc'
import { Pill } from '../../ui/pill'
import { Button } from '../../ui/button'
import { SearchIcon } from '../../ui/icons'
import { PageHeader } from '../_chrome/page-header'
import {
  RunDetailSheet,
  type DetailTarget,
} from '../../features/agent-logs/run-detail-sheet'
import { matchLogs } from '../../lib/router'
import { usePathname, navigate } from '../../lib/router'
import { useSSE } from '../../lib/use-sse'

type SourceFilter = 'all' | 'ui' | 'bridge'
type StatusFilter = 'all' | RunStatus
type TypeFilter = 'all' | 'runs' | 'worker' | 'config'

const ROW_LIMIT = 100
const CONFIG_LIMIT = 50
const WORKER_LIMIT = 100

/**
 * Discriminated row shape merged into one chronological feed. Keeps
 * the table renderer dumb (one switch on `kind`) and lets future
 * sources (subprocess.stderr, repo.* events, …) slot in without
 * touching the filter pipeline.
 */
type FeedRow =
  | { kind: 'run'; ts: number; id: string; row: RunListRow }
  | { kind: 'worker'; ts: number; id: string; row: WorkerJobListRow }
  | {
      kind: 'config'
      ts: number
      id: string
      event: AgentConfigEventResponse
      // Cached resolved name so the filter / table don't have to
      // walk `agents` on every render.
      agentName: string
      agentSlug: string
    }

export function LogsPage() {
  const { agents } = useWorkspace()
  const path = usePathname()
  const initialRunId = useMemo(() => {
    const m = matchLogs(path)
    return m?.runId ?? null
  }, [path])
  // The detail sheet now supports both runs and worker jobs via a
  // discriminated `target`. Old shape was a bare runId string.
  const [openTarget, setOpenTarget] = useState<DetailTarget | null>(
    initialRunId ? { kind: 'run', id: initialRunId } : null,
  )
  // Track the path used to seed openRunId so direct path changes
  // (browser back/forward) re-sync the open run instead of being
  // stuck on the first render's value.
  const [seededFor, setSeededFor] = useState(path)
  if (seededFor !== path) {
    setSeededFor(path)
    setOpenTarget(
      initialRunId ? { kind: 'run', id: initialRunId } : null,
    )
  }

  const [runs, setRuns] = useState<readonly RunListRow[]>([])
  const [workerJobs, setWorkerJobs] = useState<readonly WorkerJobListRow[]>([])
  const [configEvents, setConfigEvents] = useState<readonly FeedRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // Aggregate count of currently-open EventSource streams across all
  // agents. Drives the "Streaming" pill in the page header. Each
  // <AgentEventSink/> below reports its own connected state via the
  // `onConnected` callback.
  const [connectedCount, setConnectedCount] = useState(0)

  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set())
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      // All state writes live inside the async block so the effect
      // body itself has no synchronous setState — required by
      // react-hooks/set-state-in-effect under React 19's strict mode.
      if (alive) setLoading(true)
      if (alive) setErr(null)
      try {
        // Runs, worker jobs, and config events fetch in parallel.
        // Config events fan out one HTTP call per agent — fine for
        // typical workspace sizes (< 30 agents); a future global
        // /api/agents/config-events endpoint would collapse it.
        const [runsRes, workerJobsRes, configRes] = await Promise.all([
          listRuns({ limit: ROW_LIMIT }),
          listWorkerJobs({ limit: WORKER_LIMIT }),
          fetchAllConfigEvents(agents),
        ])
        if (!alive) return
        setRuns(runsRes.runs)
        setWorkerJobs(workerJobsRes.jobs)
        setConfigEvents(configRes)
      } catch (e) {
        if (alive) {
          setErr(
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : 'Failed to load activity',
          )
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // `agents` is part of the workspace context and stable across
    // renders unless an agent was added/removed — refetching on
    // changes is correct (new agent → its config history shows up).
  }, [reloadTick, agents])

  // Merged chronological feed. Runs + worker jobs + config events
  // sorted newest-first.
  const feed = useMemo<ReadonlyArray<FeedRow>>(() => {
    const runRows: FeedRow[] = runs.map((r) => ({
      kind: 'run',
      ts: Date.parse(r.startedAt) || 0,
      id: `run:${r.id}`,
      row: r,
    }))
    const workerRows: FeedRow[] = workerJobs.map((j) => ({
      kind: 'worker',
      ts: Date.parse(j.startedAt) || 0,
      id: `worker:${j.id}`,
      row: j,
    }))
    const merged: FeedRow[] = [...runRows, ...workerRows, ...configEvents]
    merged.sort((a, b) => b.ts - a.ts)
    return merged
  }, [runs, workerJobs, configEvents])

  const filtered = useMemo<ReadonlyArray<FeedRow>>(() => {
    const q = query.trim().toLowerCase()
    return feed.filter((row) => {
      // Type pill — runs / worker / config / all.
      if (typeFilter === 'runs' && row.kind !== 'run') return false
      if (typeFilter === 'worker' && row.kind !== 'worker') return false
      if (typeFilter === 'config' && row.kind !== 'config') return false
      if (row.kind === 'run') {
        const r = row.row
        if (agentFilter.size > 0 && !agentFilter.has(r.agentId)) return false
        if (sourceFilter !== 'all' && r.source !== sourceFilter) return false
        if (statusFilter !== 'all' && r.status !== statusFilter) return false
        if (q.length === 0) return true
        const hay = [
          r.agentName,
          r.agentSlug,
          r.streamId,
          r.inputPromptPreview,
          r.outputSummaryPreview ?? '',
          r.errorMessage ?? '',
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      }
      if (row.kind === 'worker') {
        const w = row.row
        // Agent multi-select doesn't apply to worker jobs (they're
        // per-repo, not per-agent). Source pill doesn't apply
        // either. Status pill maps onto worker statuses
        // (running/completed/error/aborted) — those overlap with
        // run statuses so the pill works for both.
        if (agentFilter.size > 0) return false
        if (sourceFilter !== 'all') return false
        if (statusFilter !== 'all' && w.status !== statusFilter) return false
        if (q.length === 0) return true
        const hay = [
          w.repoLabel,
          w.repoRemoteUrl,
          w.jobKind,
          w.errorMessage ?? '',
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      }
      // config row
      if (
        agentFilter.size > 0 &&
        !agentFilter.has(row.event.agentId)
      ) {
        return false
      }
      // Source / Status pills don't apply to config events. When
      // either is narrowed away from 'all', config rows drop out
      // (they aren't a "ui-source" or "completed" type of thing).
      if (sourceFilter !== 'all') return false
      if (statusFilter !== 'all') return false
      if (q.length === 0) return true
      const hay = [
        row.agentName,
        row.agentSlug,
        row.event.action,
        row.event.resource,
        row.event.label,
        row.event.detail ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [feed, agentFilter, sourceFilter, statusFilter, typeFilter, query])

  const openRun = (id: string) => {
    setOpenTarget({ kind: 'run', id })
    // Reflect in the URL so the row is shareable / refreshable.
    // (Worker jobs don't share the URL — same-page navigation only.)
    navigate(`/logs/${id}`, { replace: false })
  }
  const openWorkerJob = (id: string) => {
    setOpenTarget({ kind: 'worker', id })
  }
  const closeDetail = () => {
    setOpenTarget(null)
    if (window.location.pathname !== '/logs') {
      navigate('/logs', { replace: false })
    }
  }

  // Debounced "something changed, refetch" trigger driven by the
  // per-agent SSE fan-out. We don't try to synthesise rows from raw
  // events — the listRuns endpoint is the source of truth — but we
  // do refetch promptly when an event suggests new state (a run
  // started / finished / errored, a config event landed). A small
  // window coalesces bursts (e.g. a tool-heavy run firing 12
  // events in 200ms triggers one refetch, not twelve).
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRefetch = (): void => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => {
      setReloadTick((t) => t + 1)
    }, 500)
  }
  const handleLiveEvent = (event: RunEvent): void => {
    // Only kinds that change the runs / worker / config feed warrant
    // a refetch. Token-stream / heartbeat / per-progress events are
    // dropped silently to avoid refetch storms during long jobs.
    // The terminal events (.ok/.fail) cover what the feed actually
    // shows (lifecycle row status changes).
    if (
      event.kind === 'run.started' ||
      event.kind === 'run.finished' ||
      event.kind === 'run.error' ||
      event.kind === 'agent.config.changed' ||
      event.kind === 'repo.clone.started' ||
      event.kind === 'repo.clone.ok' ||
      event.kind === 'repo.clone.fail' ||
      event.kind === 'repo.index.started' ||
      event.kind === 'repo.index.ok' ||
      event.kind === 'repo.index.fail' ||
      event.kind === 'repo.wiki.started' ||
      event.kind === 'repo.wiki.ok' ||
      event.kind === 'repo.wiki.fail' ||
      event.kind === 'repo.delete.started' ||
      event.kind === 'repo.delete.ok' ||
      event.kind === 'repo.delete.fail' ||
      // V2 Evidence Bridge — embed-repo job lifecycle (Block 4) +
      // IDE-virtual completion (Block 6+). Per-stage `bridge.stage.*`
      // and per-batch `embed.*` events are intentionally NOT in this
      // list — they fire many times per request/job and would
      // refetch-storm. The terminal events below cover what the
      // global feed actually shows.
      event.kind === 'repo.embed.started' ||
      event.kind === 'repo.embed.ok' ||
      event.kind === 'repo.embed.fail'
    ) {
      scheduleRefetch()
    }
  }
  const handleConnectedChange = (delta: number): void => {
    setConnectedCount((n) => Math.max(0, n + delta))
  }
  useEffect(() => {
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
    }
  }, [])

  return (
    <div className="ab-page">
      <PageHeader
        title="Logs"
        subtitle="Every run across the workspace, UI chats and IDE-bridge calls in one feed. Open a row for the full prompt, output, and event timeline."
        actions={
          <>
            <span
              className={`ab-logs-live${connectedCount > 0 ? ' is-on' : ''}`}
              title={
                connectedCount > 0
                  ? `Listening to ${connectedCount} of ${agents.length} agent stream(s). New runs and config events refresh automatically.`
                  : 'No SSE streams connected. Refresh to pull updates.'
              }
            >
              {connectedCount > 0 && <span className="ab-pulse-dot" />}
              {connectedCount > 0
                ? `Streaming · ${connectedCount}/${agents.length}`
                : 'Offline'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadTick((t) => t + 1)}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />
      {agents.map((a) => (
        <AgentEventSink
          key={a.id}
          agentId={a.id}
          onEvent={handleLiveEvent}
          onConnectedChange={handleConnectedChange}
        />
      ))}

      <FilterBar
        agents={agents}
        agentFilter={agentFilter}
        setAgentFilter={setAgentFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        query={query}
        setQuery={setQuery}
      />

      {err && (
        // Persistent advisory until Refresh succeeds — `role="status"`
        // (not `alert`) so screen readers don't re-announce every
        // parent re-render. Uses `ab-alert-danger` tokens instead of
        // raw rgba.
        <div role="status" className="ab-alert ab-alert-danger">
          <span className="ab-alert-dot" aria-hidden="true" />
          <div className="ab-alert-body">
            <div className="ab-alert-title">Failed to load activity</div>
            <div className="ab-alert-sub">{err}</div>
          </div>
        </div>
      )}

      <div className="ab-card" style={{ overflow: 'hidden' }}>
        <RunsTable
          rows={filtered}
          onOpenRun={openRun}
          onOpenWorker={openWorkerJob}
          loading={loading}
        />
      </div>

      <RunDetailSheet target={openTarget} onClose={closeDetail} />
    </div>
  )
}

// ─── Filter bar ─────────────────────────────────────────────────────────

interface FilterBarProps {
  agents: ReturnType<typeof useWorkspace>['agents']
  agentFilter: Set<string>
  setAgentFilter: (s: Set<string>) => void
  sourceFilter: SourceFilter
  setSourceFilter: (s: SourceFilter) => void
  statusFilter: StatusFilter
  setStatusFilter: (s: StatusFilter) => void
  typeFilter: TypeFilter
  setTypeFilter: (t: TypeFilter) => void
  query: string
  setQuery: (s: string) => void
}

function FilterBar(p: FilterBarProps) {
  const TYPES: Array<{ value: TypeFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'runs', label: 'Runs' },
    { value: 'worker', label: 'Worker' },
    { value: 'config', label: 'Config' },
  ]
  const SOURCES: Array<{ value: SourceFilter; label: string }> = [
    { value: 'all', label: 'All sources' },
    { value: 'ui', label: 'UI' },
    { value: 'bridge', label: 'Bridge' },
  ]
  const STATUSES: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: 'All statuses' },
    { value: 'completed', label: 'Completed' },
    { value: 'running', label: 'Running' },
    { value: 'error', label: 'Error' },
    { value: 'aborted', label: 'Aborted' },
  ]
  // Source pill only meaningfully applies to runs (UI vs Bridge).
  // Status pill applies to runs + worker jobs. We DON'T hide the
  // pills when they don't apply — pill rows shifting under your
  // cursor as you switch filters is a worse UX than visibly
  // disabled controls. Instead we disable + dim them so the
  // filter-bar layout stays stable across all four type modes.
  const sourcePillDisabled =
    p.typeFilter === 'config' || p.typeFilter === 'worker'
  const statusPillDisabled = p.typeFilter === 'config'
  return (
    <div className="ab-logs-toolbar">
      <div className="ab-logs-search">
        <SearchIcon strokeWidth={2} />
        <input
          type="search"
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          placeholder="Search prompt, agent, stream id, error, config…"
        />
      </div>

      <PillGroup
        value={p.typeFilter}
        options={TYPES}
        onChange={p.setTypeFilter}
      />
      <PillGroup
        value={p.sourceFilter}
        options={SOURCES}
        onChange={p.setSourceFilter}
        disabled={sourcePillDisabled}
        disabledTitle={
          p.typeFilter === 'worker'
            ? 'Worker jobs don\'t have a UI/Bridge source.'
            : p.typeFilter === 'config'
              ? 'Config events don\'t have a UI/Bridge source.'
              : undefined
        }
      />
      <PillGroup
        value={p.statusFilter}
        options={STATUSES}
        onChange={p.setStatusFilter}
        disabled={statusPillDisabled}
        disabledTitle={
          p.typeFilter === 'config'
            ? 'Config events don\'t have a status.'
            : undefined
        }
      />
      <AgentMultiSelect
        agents={p.agents}
        selected={p.agentFilter}
        setSelected={p.setAgentFilter}
      />
    </div>
  )
}

function PillGroup<V extends string>({
  value,
  options,
  onChange,
  disabled,
  disabledTitle,
}: {
  value: V
  options: ReadonlyArray<{ value: V; label: string }>
  onChange: (v: V) => void
  /** When true, the whole group is dimmed and unclickable. Used so
   *  pills that don't apply to the active type filter stay visible
   *  (no layout shift) without misleading the user about what
   *  they'd filter. */
  disabled?: boolean
  /** Tooltip explaining WHY the group is disabled (e.g.
   *  "Config events don't have a UI/Bridge source."). */
  disabledTitle?: string
}) {
  return (
    <div
      className={`ab-seg${disabled ? ' is-disabled' : ''}`}
      title={disabled ? disabledTitle : undefined}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            aria-pressed={active}
            className={`ab-seg-item${active ? ' is-active' : ''}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function AgentMultiSelect({
  agents,
  selected,
  setSelected,
}: {
  agents: ReturnType<typeof useWorkspace>['agents']
  selected: Set<string>
  setSelected: (s: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const label =
    selected.size === 0
      ? 'All agents'
      : selected.size === 1
        ? agents.find((a) => selected.has(a.id))?.name ?? '1 agent'
        : `${selected.size} agents`
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const clear = () => setSelected(new Set())
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="ab-btn ab-btn-secondary"
        onClick={() => setOpen((o) => !o)}
        style={{ fontSize: 12, padding: '6px 10px' }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 240,
            maxHeight: 320,
            overflow: 'auto',
            padding: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-2)',
            zIndex: 10,
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {agents.length === 0 ? (
            <div className="ab-field-help" style={{ padding: 6 }}>
              No agents yet.
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={clear}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: 12,
                  color: 'var(--accent-300)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-xs)',
                }}
              >
                Clear all
              </button>
              <div
                style={{
                  height: 1,
                  background: 'var(--border)',
                  margin: '4px 0',
                }}
              />
              {agents.map((a) => {
                const checked = selected.has(a.id)
                return (
                  <label
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      fontSize: 12,
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-xs)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(a.id)}
                    />
                    <span>{a.name}</span>
                    <span
                      className="ab-mono"
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--text-muted)',
                        fontSize: 11,
                      }}
                    >
                      {a.slug}
                    </span>
                  </label>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Runs table ─────────────────────────────────────────────────────────

function RunsTable({
  rows,
  onOpenRun,
  onOpenWorker,
  loading,
}: {
  rows: ReadonlyArray<FeedRow>
  onOpenRun: (id: string) => void
  onOpenWorker: (id: string) => void
  loading: boolean
}) {
  if (rows.length === 0 && loading) {
    // First-paint state — table chrome would just be an empty header.
    // Surface a pulsing-dot row so the user knows the fetch is in
    // flight instead of staring at a silent card.
    return (
      <div className="ab-card-pad">
        <div className="ab-loading-row">
          <span className="ab-pulse-dot" />
          Loading activity…
        </div>
      </div>
    )
  }
  if (rows.length === 0 && !loading) {
    return <div className="ab-runs-empty">No activity matches the current filters.</div>
  }
  return (
    <div className="ab-runs-feed">
      {rows.map((r) =>
        r.kind === 'run' ? (
          <RunRow key={r.id} row={r.row} onOpen={onOpenRun} />
        ) : r.kind === 'worker' ? (
          <WorkerRow key={r.id} row={r.row} onOpen={onOpenWorker} />
        ) : (
          <ConfigRow key={r.id} row={r} />
        ),
      )}
    </div>
  )
}

/**
 * One row in the activity feed. A 3-column grid: leading status pill,
 * an identity + prompt main column, and a right-aligned mono/tabular
 * metric stack. `onOpen` makes the row a keyboard-accessible button;
 * omit it for non-navigable rows (config events have no detail view).
 */
function FeedRow({
  status,
  title,
  prompt,
  time,
  timeTitle,
  stats,
  onOpen,
}: {
  status: React.ReactNode
  title: React.ReactNode
  prompt?: React.ReactNode
  time: string
  timeTitle?: string
  stats?: React.ReactNode
  onOpen?: () => void
}) {
  const interactive = onOpen !== undefined
  return (
    <div
      className={`ab-run-row${interactive ? ' is-interactive' : ''}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen?.()
              }
            }
          : undefined
      }
    >
      <div className="ab-run-status">{status}</div>
      <div className="ab-run-main">
        <div className="ab-run-title">{title}</div>
        {prompt}
      </div>
      <div className="ab-run-end">
        <div className="ab-run-metrics">
          <span className="ab-run-time" title={timeTitle}>
            {time}
          </span>
          {stats && <span className="ab-run-stats">{stats}</span>}
        </div>
        {interactive && <RowChevron />}
      </div>
    </div>
  )
}

/** Right-pointing chevron marking a row as openable. */
function RowChevron() {
  return (
    <svg
      className="ab-run-chevron"
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 L10.5 8 L6 12.5" />
    </svg>
  )
}

function RunRow({
  row,
  onOpen,
}: {
  row: RunListRow
  onOpen: (id: string) => void
}) {
  const tokens =
    row.promptTokens !== null || row.completionTokens !== null
      ? `${(row.promptTokens ?? 0).toLocaleString()}/${(row.completionTokens ?? 0).toLocaleString()} tok`
      : null
  const dur =
    row.durationMs !== null ? `${(row.durationMs / 1000).toFixed(2)}s` : null
  const stats = [dur, tokens].filter(Boolean).join(' · ') || undefined
  return (
    <FeedRow
      onOpen={() => onOpen(row.id)}
      status={<StatusPill status={row.status} />}
      title={
        <>
          <span className="ab-run-name">{row.agentName}</span>
          <span className="ab-run-slug">{row.agentSlug}</span>
          <SourcePill source={row.source} />
        </>
      }
      prompt={
        row.errorMessage ? (
          <div className="ab-run-prompt is-error" title={row.errorMessage}>
            {row.errorMessage}
          </div>
        ) : (
          <div className="ab-run-prompt" title={row.inputPromptPreview}>
            {row.inputPromptPreview}
          </div>
        )
      }
      time={formatRelative(row.startedAt)}
      timeTitle={row.startedAt}
      stats={stats}
    />
  )
}

function StatusPill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { kind: 'success' | 'warn' | 'danger' | 'neutral'; label: string }> = {
    pending: { kind: 'neutral', label: 'pending' },
    running: { kind: 'warn', label: 'running' },
    completed: { kind: 'success', label: 'completed' },
    error: { kind: 'danger', label: 'error' },
    aborted: { kind: 'warn', label: 'aborted' },
  }
  const { kind, label } = map[status] ?? { kind: 'neutral', label: status }
  return (
    <Pill kind={kind} dot>
      {label}
    </Pill>
  )
}

function SourcePill({ source }: { source: RunSource }) {
  const label = source === 'ui' ? 'UI' : source === 'bridge' ? 'Bridge' : source
  return <Pill kind="neutral">{label}</Pill>
}

/**
 * Headless SSE subscriber. One per attached agent; opens an
 * EventSource against `agentStreamId(agentId)`, forwards new events
 * via the `onEvent` callback, and reports connection lifecycle
 * (open/close) via `onConnectedChange(±1)` so the parent can show
 * a count without coordinating connection state itself.
 *
 * Caveat: the browser's per-host HTTP/1.1 EventSource limit is
 * around 6. Workspaces with > 6 attached agents will leave some
 * streams disconnected; the streaming pill reflects how many are
 * actually live ("Streaming · 6/12"). When this becomes a problem
 * the right fix is a server-side aggregator stream that fans out
 * every agent's events on one channel — out of scope here.
 */
function AgentEventSink({
  agentId,
  onEvent,
  onConnectedChange,
}: {
  agentId: string
  onEvent: (e: RunEvent) => void
  onConnectedChange: (delta: number) => void
}) {
  const { events, connected } = useSSE(agentStreamId(agentId), { cap: 50 })
  // Track last-pumped index so callbacks fire only on new events.
  // The hook's buffer is rolling (capped) so we use the highest ts
  // seen, not the array length.
  const lastTs = useRef(0)
  // Refs let us call the latest callbacks without re-binding the
  // event-pump effect on every parent render. Without this, the
  // effect's dep array would include onEvent which changes per
  // render, and we'd churn through buffer state.
  const onEventRef = useRef(onEvent)
  const onConnectedChangeRef = useRef(onConnectedChange)
  // Sync the latest callback identities into refs from a layout
  // effect so the read in the pump effect below sees the freshest
  // closure — without violating react-hooks/refs-during-render.
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])
  useEffect(() => {
    onConnectedChangeRef.current = onConnectedChange
  }, [onConnectedChange])

  useEffect(() => {
    for (const e of events) {
      if (e.ts > lastTs.current) {
        lastTs.current = e.ts
        onEventRef.current(e)
      }
    }
  }, [events])

  useEffect(() => {
    if (connected) {
      onConnectedChangeRef.current(+1)
      return () => onConnectedChangeRef.current(-1)
    }
    return undefined
  }, [connected])

  return null
}

function WorkerRow({
  row,
  onOpen,
}: {
  row: WorkerJobListRow
  onOpen: (id: string) => void
}) {
  const dur =
    row.durationMs !== null ? `${(row.durationMs / 1000).toFixed(2)}s` : undefined
  return (
    <FeedRow
      onOpen={() => onOpen(row.id)}
      status={<WorkerStatusPill status={row.status} />}
      title={
        <>
          <span className="ab-run-name">{row.repoLabel}</span>
          <span className="ab-run-slug">{row.repoRemoteUrl}</span>
          <span title={workerJobKindHelp(row.jobKind)}>
            <Pill kind="neutral">{row.jobKind}</Pill>
          </span>
        </>
      }
      prompt={
        row.errorMessage ? (
          <div className="ab-run-prompt is-error" title={row.errorMessage}>
            {row.errorMessage}
          </div>
        ) : undefined
      }
      time={formatRelative(row.startedAt)}
      timeTitle={row.startedAt}
      stats={dur}
    />
  )
}

/** Worker statuses use the same enum as runs minus 'pending' — share
 *  the StatusPill renderer through this thin wrapper for clarity. */
/**
 * Tooltip text for the worker `jobKind` pill. Operators new to
 * the system don't always know what each value covers; surfacing
 * the difference inline is cheaper than a doc page.
 */
function workerJobKindHelp(kind: string): string {
  switch (kind) {
    case 'clone':
      return 'clone — git clone of the remote repository into the local data dir.'
    case 'index':
      return 'index — gitnexus analyze (parses sources, builds the graph, writes meta.json).'
    case 'wiki':
      return 'wiki — gitnexus wiki (LLM-generated module docs, opt-in).'
    case 'embed':
      return 'embed — V2 Evidence Bridge embed-repo (per-symbol vector embeddings into code_chunks; optional repo / module / symbol summaries when an attached agent has indexing_config.generate_summaries enabled).'
    default:
      return `${kind} (worker job)`
  }
}

function WorkerStatusPill({
  status,
}: {
  status: WorkerJobListRow['status']
}) {
  const map: Record<
    WorkerJobListRow['status'],
    { kind: 'success' | 'warn' | 'danger' | 'neutral'; label: string }
  > = {
    running: { kind: 'warn', label: 'running' },
    completed: { kind: 'success', label: 'completed' },
    error: { kind: 'danger', label: 'error' },
    aborted: { kind: 'warn', label: 'aborted' },
  }
  const { kind, label } = map[status] ?? { kind: 'neutral', label: status }
  return (
    <Pill kind={kind} dot>
      {label}
    </Pill>
  )
}

function ConfigRow({
  row,
}: {
  row: Extract<FeedRow, { kind: 'config' }>
}) {
  const { event } = row
  const detail = event.detail?.trim()
  return (
    <FeedRow
      status={
        <Pill kind="neutral" dot>
          config
        </Pill>
      }
      title={
        <>
          <span className="ab-run-name">{row.agentName}</span>
          <span className="ab-run-slug">{row.agentSlug}</span>
          <Pill kind="neutral">{event.action}</Pill>
        </>
      }
      prompt={
        <div
          className="ab-run-prompt"
          title={detail ? `${event.label} — ${detail}` : event.label}
        >
          <span className="ab-run-slug">{event.resource}</span> {event.label}
          {detail ? ` · ${detail}` : ''}
        </div>
      }
      time={formatRelative(event.ts)}
      timeTitle={event.ts}
    />
  )
}

/**
 * Parallel-fetch every attached agent's config-event history. Each
 * call is independent — a 404 / network blip on one agent shouldn't
 * starve the others. Failures resolve to an empty array so the
 * merged feed degrades to "missing one agent's history" instead of
 * the whole page erroring.
 */
async function fetchAllConfigEvents(
  agents: ReturnType<typeof useWorkspace>['agents'],
): Promise<ReadonlyArray<FeedRow>> {
  const results = await Promise.allSettled(
    agents.map(async (a) => {
      const events = await listAgentConfigEvents(a.id, CONFIG_LIMIT)
      return events.map<FeedRow>((event) => ({
        kind: 'config',
        ts: Date.parse(event.ts) || 0,
        id: `cfg:${event.id}`,
        event,
        agentName: a.name,
        agentSlug: a.slug,
      }))
    }),
  )
  const out: FeedRow[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(...r.value)
    // rejected → silently drop. The page surfaces a top-level
    // error toast only if EVERYTHING failed (Promise.all on the
    // outer fetch); per-agent misses are non-fatal.
  }
  return out
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const delta = Date.now() - ts
  if (delta < 60_000) return `${Math.max(0, Math.floor(delta / 1000))}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
