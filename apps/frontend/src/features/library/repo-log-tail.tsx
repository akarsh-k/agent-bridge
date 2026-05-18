/**
 * Activity panel for the repo detail page. Combines:
 *
 *   - **Phase chips** (Clone → Index → Embed → Wiki) at the top,
 *     each with status (waiting / running / ok / fail) and a finished
 *     duration. The chips connect with a hairline that fills as phases
 *     complete, so the operator can glance at the panel and tell
 *     "we're three quarters of the way through embedding."
 *
 *   - **Log feed** below, where:
 *       * consecutive identical messages collapse into one row with
 *         a `×N` counter and a soft pulse (so a long phase that
 *         emits the same line many times feels alive instead of
 *         frozen),
 *       * lines that contain extractable progress (gitnexus / git
 *         "Receiving objects: 42% (210/500)") render with an inline
 *         progress bar painted across the row,
 *       * phase boundaries get a thin divider with the phase name so
 *         the timeline reads top-to-bottom as a story.
 *
 *   - **Persistence** — on mount we hydrate from
 *     `GET /api/worker-jobs?repoId=...&limit=1` (the most recent job)
 *     plus its event timeline. Live SSE frames layer on top, deduped
 *     by ts+kind+payloadHash so reload-then-stream doesn't double up.
 *     Result: navigate away + back never shows "No events" when the
 *     repo actually has activity.
 *
 * Props are unchanged: `<RepoLogTail repoId={string} />`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  repoStreamId,
  type RunEvent,
  type WorkerJobDetailEvent,
  type WorkerJobListRow,
  type WorkerJobStatus,
} from '@agent-bridge/shared'
import { Pill, type PillKind } from '../../ui/pill'
import { useSSE } from '../../lib/use-sse'
import { fetchWorkerJob, listWorkerJobs } from '../../lib/rpc'

// ─── Phase model ─────────────────────────────────────────────────────────

type PhaseId = 'clone' | 'index' | 'embed' | 'wiki'
type PhaseStatus = 'waiting' | 'running' | 'ok' | 'fail'

interface PhaseState {
  readonly id: PhaseId
  readonly label: string
  status: PhaseStatus
  /** Most recent transition timestamp (ms). drives "running for 3.4s" math. */
  startedAt: number | null
  durationMs: number | null
  /** Last fail message — surfaced inline beneath the chips. */
  failMessage: string | null
}

const PHASE_ORDER: readonly PhaseId[] = ['clone', 'index', 'embed', 'wiki']
const PHASE_LABEL: Record<PhaseId, string> = {
  clone: 'Clone',
  index: 'Index',
  embed: 'Embed',
  wiki: 'Wiki',
}

function emptyPhases(): PhaseState[] {
  return PHASE_ORDER.map((id) => ({
    id,
    label: PHASE_LABEL[id],
    status: 'waiting',
    startedAt: null,
    durationMs: null,
    failMessage: null,
  }))
}

function phaseFromKind(kind: string): PhaseId | null {
  if (kind.startsWith('repo.clone.')) return 'clone'
  // Pull occupies the same lifecycle slot as clone (the "get the source
  // tree current" phase). Folding it into the `clone` chip keeps the
  // 4-chip layout stable across both refresh modes; the log feed below
  // still labels the rows as Pull/Clone correctly via event-labels.ts.
  if (kind.startsWith('repo.pull.')) return 'clone'
  if (kind.startsWith('repo.index.')) return 'index'
  if (kind.startsWith('repo.embed.')) return 'embed'
  if (kind.startsWith('repo.wiki.')) return 'wiki'
  return null
}

// ─── Log row model ───────────────────────────────────────────────────────

interface LogRow {
  /** Stable key. ts of the first event in the run, plus a slot suffix. */
  key: string
  phase: PhaseId | null
  /** ms — first event in the group. */
  ts: number
  level: 'info' | 'ok' | 'warn' | 'error'
  message: string
  /** Original event kind for the type pill. e.g. `repo.index.progress`. */
  kindShort: string
  /** Times this message repeated consecutively. ≥ 1. */
  count: number
  /** Most recent ts. drives "running" pulse on the head row. */
  lastTs: number
  /** When the message embedded a progress reading, the latest one. */
  progress: ProgressReading | null
}

interface ProgressReading {
  readonly percent: number
  readonly current: number | null
  readonly total: number | null
  /** The label part before the percentage ("Receiving objects"). */
  readonly label: string
}

// ─── Public surface ──────────────────────────────────────────────────────

export function RepoLogTail({ repoId }: { repoId: string }) {
  const streamId = useMemo(() => repoStreamId(repoId), [repoId])
  const { connected, events: liveEvents } = useSSE(streamId, { cap: 400 })
  const [history, setHistory] = useState<HistorySnapshot | null>(null)
  const [historyLoading, setHistoryLoading] = useState<boolean>(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(false)

  // Reset & re-hydrate when the repo changes. Strict-mode-safe: the
  // cancel ref is checked before every set so the second mount of a
  // dev-mode double-render doesn't write stale state into the new one.
  useEffect(() => {
    const cancelToken = { cancelled: false }
    // All state writes (including the initial loading/clear) live
    // inside the promise chain so the effect body has no synchronous
    // setState — required by react-hooks/set-state-in-effect under
    // React 19. The loading-spinner flash still happens; it just
    // arrives on the next microtask instead of synchronously.
    void Promise.resolve().then(() => {
      if (cancelToken.cancelled) return
      setHistory(null)
      setHistoryError(null)
      setHistoryLoading(true)
      return hydrateHistory(repoId).then(
        (snap) => {
          if (cancelToken.cancelled) return
          setHistory(snap)
          setHistoryLoading(false)
        },
        (err: unknown) => {
          if (cancelToken.cancelled) return
          const msg =
            err instanceof Error ? err.message : 'Failed to load history'
          setHistoryError(msg)
          setHistoryLoading(false)
        },
      )
    })
    return () => {
      cancelToken.cancelled = true
    }
  }, [repoId])

  // Merge: history first (oldest → newest), then live (oldest → newest),
  // deduped by a stable signature so events that arrive over SSE during
  // hydration AND show up in the fetched history don't double-count.
  const mergedEvents = useMemo(() => {
    return mergeEventStreams(history?.events ?? [], liveEvents)
  }, [history, liveEvents])

  // Derive phase states + collapsed log rows from the merged stream.
  const { phases, rows } = useMemo(
    () => derive(mergedEvents, history?.job ?? null),
    [mergedEvents, history?.job],
  )

  const liveStatus = useMemo<LiveBadge>(
    () => deriveLiveBadge(connected, history?.job, mergedEvents),
    [connected, history?.job, mergedEvents],
  )

  const empty =
    !historyLoading &&
    historyError === null &&
    mergedEvents.length === 0 &&
    history?.job == null

  // Don't render at all on cold load with no history — preserves the
  // previous behaviour (page renders without an empty Activity card
  // for repos that have never run anything).
  if (empty && !connected) return null

  return (
    <section className="ab-card ab-card-pad ab-form-section ab-repo-activity">
      <header className="ab-repo-activity-head">
        <div className="ab-repo-activity-titles">
          <div className="ab-section-title">Activity</div>
          <div className="ab-section-sub">
            Live events from clone / index / embed / wiki jobs against this repo.
          </div>
        </div>
        <div className="ab-repo-activity-chip-group">
          {liveStatus.kind === 'live' && (
            <span className="ab-live-chip">
              <span className="ab-pulse-dot" />
              Streaming
            </span>
          )}
          {liveStatus.kind === 'idle' && (
            <span className="ab-live-chip ab-live-chip-idle">
              <span className="ab-live-chip-dot" />
              Idle
            </span>
          )}
          {liveStatus.kind === 'reconnecting' && (
            <span className="ab-live-chip ab-live-chip-warn">
              <span className="ab-live-chip-dot" />
              Reconnecting
            </span>
          )}
          {history?.job?.startedAt && (
            <span
              className="ab-repo-activity-runts"
              title={`Job started ${new Date(history.job.startedAt).toLocaleString()}`}
            >
              {liveStatus.kind === 'live' ? 'started ' : 'last run '}
              {formatRelative(new Date(history.job.startedAt).getTime())}
            </span>
          )}
        </div>
      </header>

      {historyError && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)', marginTop: 4 }}
        >
          Couldn't load history: {historyError}. Live events still work.
        </div>
      )}

      <LongRunHint phases={phases} />

      <PhaseTrack
        phases={phases}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />

      {!collapsed && (
        <LogFeed
          rows={rows}
          loading={historyLoading && rows.length === 0}
          empty={!historyLoading && rows.length === 0 && !historyError}
        />
      )}
    </section>
  )
}

// ─── PhaseTrack ──────────────────────────────────────────────────────────

function PhaseTrack({
  phases,
  collapsed,
  onToggle,
}: {
  phases: readonly PhaseState[]
  collapsed: boolean
  onToggle: () => void
}) {
  // Visible chips: drop wiki when it never started AND no other phase
  // is running into it. Keeps the panel focused on the canonical
  // clone+index+embed flow most repos take.
  const visible = phases.filter(
    (p) => p.id !== 'wiki' || p.status !== 'waiting',
  )
  return (
    <div className="ab-phase-track">
      <ol className="ab-phase-list" aria-label="Job phases">
        {visible.map((phase, i) => {
          const next = visible[i + 1]
          const connectorActive =
            phase.status === 'ok' &&
            next !== undefined &&
            next.status !== 'waiting'
          return (
            <li key={phase.id} className="ab-phase-item">
              <PhaseChip phase={phase} />
              {next && (
                <span
                  className={[
                    'ab-phase-connector',
                    connectorActive ? 'is-active' : '',
                    next.status === 'running' ? 'is-flowing' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden="true"
                />
              )}
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        className="ab-phase-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show log lines' : 'Hide log lines'}
      >
        {collapsed ? (
          <>
            <ChevronIcon dir="down" /> Show log
          </>
        ) : (
          <>
            <ChevronIcon dir="up" /> Hide log
          </>
        )}
      </button>
    </div>
  )
}

function PhaseChip({ phase }: { phase: PhaseState }) {
  const pillKind: PillKind =
    phase.status === 'fail'
      ? 'danger'
      : phase.status === 'running'
        ? 'accent'
        : phase.status === 'ok'
          ? 'success'
          : 'neutral'
  const showRunningTimer = phase.status === 'running' && phase.startedAt
  return (
    <div className={`ab-phase-chip is-${phase.status}`}>
      <Pill kind={pillKind} dot={phase.status === 'running'}>
        {phase.label}
      </Pill>
      <span className="ab-phase-meta">
        {phase.status === 'running' && showRunningTimer && (
          <RunningTimer startedAt={phase.startedAt!} />
        )}
        {phase.status === 'ok' && phase.durationMs != null && (
          <span title="Phase duration">{formatDuration(phase.durationMs)}</span>
        )}
        {phase.status === 'fail' && phase.failMessage && (
          <span
            className="ab-phase-fail-reason"
            title={phase.failMessage}
          >
            {truncateInline(phase.failMessage, 60)}
          </span>
        )}
        {phase.status === 'waiting' && <span>—</span>}
      </span>
    </div>
  )
}

/**
 * Soft inline hint that appears while the index / embed phase is in
 * flight. Sets expectations for the long quiet stretches gitnexus has
 * during the embed pipeline (one stderr line, then tens of seconds of
 * silence while it batches nodes and calls the embedder) so the
 * operator doesn't read "no new events" as "stuck". Hidden in every
 * other state — including a passive `cloning` (which is fast and
 * chatty enough not to need a hint) and any terminal phase.
 */
function LongRunHint({ phases }: { phases: readonly PhaseState[] }) {
  const indexRunning =
    phases.find((p) => p.id === 'index')?.status === 'running'
  const embedRunning =
    phases.find((p) => p.id === 'embed')?.status === 'running'
  if (!indexRunning && !embedRunning) return null
  return (
    <div className="ab-field-help" style={{ marginTop: 4 }}>
      Large repos can take several minutes. Gitnexus may go quiet for
      stretches during the embed pipeline — that's normal.
    </div>
  )
}

function RunningTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span className="ab-phase-timer">{formatDuration(now - startedAt)}</span>
  )
}

// ─── LogFeed ─────────────────────────────────────────────────────────────

function LogFeed({
  rows,
  loading,
  empty,
}: {
  rows: readonly LogRow[]
  loading: boolean
  empty: boolean
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef<boolean>(true)

  // Stick-to-bottom on new rows, but only when the user is already
  // near the bottom — otherwise leave them where they were reading.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [rows])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 24
  }

  if (loading) {
    return (
      <div className="ab-repo-activity-skeleton" aria-hidden="true">
        <div className="ab-skel-row" />
        <div className="ab-skel-row" />
        <div className="ab-skel-row" />
      </div>
    )
  }
  if (empty) {
    return (
      <div className="ab-field-help" style={{ marginTop: 12 }}>
        No events yet — kick off a clone or re-index above.
      </div>
    )
  }

  // Insert phase divider rows whenever the phase changes between
  // consecutive rows. Renders inline so the scroll body stays one
  // contiguous element.
  const items: Array<
    { kind: 'divider'; phase: PhaseId | null; key: string } | { kind: 'row'; row: LogRow }
  > = []
  let lastPhase: PhaseId | null | undefined = undefined
  for (const row of rows) {
    if (lastPhase !== row.phase) {
      items.push({
        kind: 'divider',
        phase: row.phase,
        key: `div-${row.phase ?? 'misc'}-${row.ts}`,
      })
      lastPhase = row.phase
    }
    items.push({ kind: 'row', row })
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="ab-repo-activity-feed"
      role="log"
      aria-live="polite"
    >
      {items.map((it) =>
        it.kind === 'divider' ? (
          <PhaseDivider key={it.key} phase={it.phase} />
        ) : (
          <LogRowView key={it.row.key} row={it.row} />
        ),
      )}
    </div>
  )
}

function PhaseDivider({ phase }: { phase: PhaseId | null }) {
  const label = phase ? PHASE_LABEL[phase].toUpperCase() : 'OTHER'
  return (
    <div className={`ab-phase-divider is-${phase ?? 'other'}`}>
      <span className="ab-phase-divider-label">{label}</span>
      <span className="ab-phase-divider-rule" />
    </div>
  )
}

function LogRowView({ row }: { row: LogRow }) {
  const isProgress = row.progress !== null
  const isRunning = isProgress && row.progress!.percent < 100
  return (
    <div
      className={[
        'ab-repo-log-row',
        `is-${row.level}`,
        isProgress ? 'has-progress' : '',
        isRunning ? 'is-running' : '',
        row.count > 1 ? 'is-batched' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isProgress && (
        <div
          className="ab-repo-log-progress"
          style={{ width: `${Math.min(100, row.progress!.percent)}%` }}
          aria-hidden="true"
        />
      )}
      <span className="ab-repo-log-time">{formatTime(row.ts)}</span>
      <span className={`ab-log-level is-${row.level}`}>{row.kindShort}</span>
      <span className="ab-repo-log-msg">
        {row.message}
        {isProgress && row.progress!.total != null && (
          <span className="ab-repo-log-progress-meta">
            {' '}
            <span className="ab-mono">
              {row.progress!.current?.toLocaleString() ?? '—'}/
              {row.progress!.total.toLocaleString()}
            </span>
            <span className="ab-repo-log-progress-pct">
              {' · '}
              {row.progress!.percent}%
            </span>
          </span>
        )}
      </span>
      {row.count > 1 && (
        <span
          className="ab-repo-log-count"
          title={`${row.count} consecutive identical messages`}
        >
          ×{row.count}
        </span>
      )}
    </div>
  )
}

// ─── Derivation: events → phases + rows ──────────────────────────────────

function derive(
  events: readonly RunEvent[],
  job: WorkerJobListRow | null,
): { phases: PhaseState[]; rows: LogRow[] } {
  const phases = emptyPhases()
  const rows: LogRow[] = []

  // Seed the phase that the latest historical job was about — so an
  // operator opening a repo with a finished job in their DB sees the
  // chip lit up correctly even before any live event arrives.
  if (job) seedPhaseFromJob(phases, job)

  for (const ev of events) {
    if (ev.kind === 'ping') continue
    const phaseId = phaseFromKind(ev.kind)

    // Phase transitions
    if (phaseId !== null) {
      const phase = phases.find((p) => p.id === phaseId)
      if (phase) {
        if (ev.kind.endsWith('.started')) {
          phase.status = 'running'
          phase.startedAt = ev.ts
          phase.durationMs = null
          phase.failMessage = null
        } else if (ev.kind.endsWith('.ok') || ev.kind.endsWith('.finished')) {
          phase.status = 'ok'
          if (phase.startedAt != null && ev.ts >= phase.startedAt) {
            phase.durationMs = ev.ts - phase.startedAt
          } else if (
            ev.data &&
            typeof ev.data === 'object' &&
            'durationMs' in (ev.data as Record<string, unknown>)
          ) {
            const d = (ev.data as Record<string, unknown>).durationMs
            if (typeof d === 'number') phase.durationMs = d
          }
        } else if (ev.kind.endsWith('.fail')) {
          phase.status = 'fail'
          if (phase.startedAt != null && ev.ts >= phase.startedAt) {
            phase.durationMs = ev.ts - phase.startedAt
          }
          const m =
            ev.data && typeof ev.data === 'object'
              ? ((ev.data as Record<string, unknown>).message as
                  | string
                  | undefined)
              : undefined
          phase.failMessage = m ?? null
        }
      }
    }

    // Log row collapse: when the rendered message + phase + level
    // matches the immediately previous row, bump its count.
    const message = renderEventMessage(ev)
    if (message === null) continue
    const level = levelFor(ev.kind)
    const progress = extractProgress(message)
    const last = rows[rows.length - 1]
    if (
      last &&
      last.phase === phaseId &&
      last.level === level &&
      last.kindShort === shortKind(ev.kind) &&
      stripProgressFromMessage(last.message, last.progress) ===
        stripProgressFromMessage(message, progress)
    ) {
      last.count += 1
      last.lastTs = ev.ts
      // For progress rows, prefer the latest reading (it's monotonic).
      if (progress) {
        last.progress = progress
        last.message = message
      }
    } else {
      rows.push({
        key: `${ev.ts}-${rows.length}`,
        phase: phaseId,
        ts: ev.ts,
        level,
        message,
        kindShort: shortKind(ev.kind),
        count: 1,
        lastTs: ev.ts,
        progress,
      })
    }
  }

  // If the live SSE has gone quiet AND a phase reads "running" but the
  // latest event was a `.ok`/`.fail` for THAT phase, the seedPhaseFromJob
  // call already handled it. Nothing else to reconcile.

  return { phases, rows }
}

function seedPhaseFromJob(phases: PhaseState[], job: WorkerJobListRow): void {
  // Map worker_jobs.jobKind → our phase id.
  const phaseId: PhaseId | null =
    job.jobKind === 'clone'
      ? 'clone'
      : job.jobKind === 'index'
        ? 'index'
        : job.jobKind === 'wiki'
          ? 'wiki'
          : null
  if (phaseId === null) return
  const phase = phases.find((p) => p.id === phaseId)
  if (!phase) return
  const startedTs = new Date(job.startedAt).getTime()
  const status: PhaseStatus = mapJobStatus(job.status)
  phase.status = status
  phase.startedAt = startedTs
  phase.durationMs = job.durationMs ?? null
  phase.failMessage = job.errorMessage
}

function mapJobStatus(s: WorkerJobStatus): PhaseStatus {
  if (s === 'running') return 'running'
  if (s === 'completed') return 'ok'
  if (s === 'error') return 'fail'
  return 'waiting'
}

// ─── Event → display helpers ─────────────────────────────────────────────

function renderEventMessage(ev: RunEvent): string | null {
  // Prefer the per-line `line` payload that the worker forwards from
  // gitnexus stderr. Fall back to a structured `message` field
  // (used by *.fail / *.ok). Skip anything we don't recognise.
  if (!ev.data || typeof ev.data !== 'object') {
    if (typeof ev.data === 'string' && ev.data.length > 0) return ev.data
    return prettyKindFallback(ev.kind)
  }
  const d = ev.data as Record<string, unknown>
  if (typeof d.line === 'string' && d.line.trim().length > 0) {
    return cleanLine(d.line)
  }
  if (typeof d.message === 'string') {
    return d.message
  }
  // Specific structured events without a free-text body — synthesise
  // a useful summary so they show up in the feed.
  if (ev.kind === 'repo.embed.started') {
    const provider =
      typeof d.providerKind === 'string' ? d.providerKind : 'embedder'
    const model = typeof d.model === 'string' ? d.model : ''
    return `Embedding via ${provider}${model ? ` · ${model}` : ''}`
  }
  if (ev.kind === 'repo.embed.ok') {
    const dur =
      typeof d.durationMs === 'number'
        ? ` in ${formatDuration(d.durationMs)}`
        : ''
    return `Embeddings finished${dur}`
  }
  if (ev.kind === 'repo.clone.started') {
    const url = typeof d.remoteUrl === 'string' ? ` ${d.remoteUrl}` : ''
    return `Cloning${url}`
  }
  if (ev.kind === 'repo.index.started') {
    return d.mode === 'reindex' ? 'Re-indexing repo' : 'Indexing repo'
  }
  if (ev.kind === 'repo.wiki.started') {
    return 'Generating wiki'
  }
  return prettyKindFallback(ev.kind)
}

function prettyKindFallback(kind: string): string {
  // "repo.index.progress" → "Index · progress"
  const parts = kind.split('.')
  if (parts.length < 2) return kind
  return `${capitalise(parts[1] ?? '')} · ${parts.slice(2).join('·')}`
}

function capitalise(s: string): string {
  if (s.length === 0) return s
  return s[0]!.toUpperCase() + s.slice(1)
}

function cleanLine(line: string): string {
  // Strip ANSI escapes + carriage returns; collapse runs of whitespace.
  // Keep any leading icon (gitnexus uses ✓ ❌ ⚠) verbatim.
  // The \x1b control char is REQUIRED — ANSI escape sequences begin
  // with ESC (0x1B), so the rule's complaint is a false positive here.
  // eslint-disable-next-line no-control-regex
  const noAnsi = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  const stripped = noAnsi
    .replace(/[\r]+/g, '')
    .replace(/[\t ]{2,}/g, ' ')
    .trim()
  // gitnexus' embedding pipeline emits pino JSON to stderr (one object
  // per line) — the worker forwards them verbatim, so without this
  // unwrap the user sees lines like `{"level":30,"time":...,"msg":"🔍
  // Querying embeddable nodes..."}`. Pull out `.msg` when it parses;
  // fall back to the raw text on anything that isn't valid JSON or
  // doesn't carry a usable `msg` field.
  return unwrapPinoJson(stripped) ?? stripped
}

/**
 * Detect a pino-style JSON log line and return the `msg` payload.
 * Returns `null` for anything that doesn't look like pino — bare text,
 * malformed JSON, or JSON without `msg`.
 *
 * Cheap rejection: skip without parsing unless the line starts with `{`
 * and contains `"msg"` somewhere. Saves a JSON.parse on the common case
 * of a free-text progress line.
 */
function unwrapPinoJson(line: string): string | null {
  if (!line.startsWith('{') || !line.includes('"msg"')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const msg = obj['msg']
  if (typeof msg !== 'string' || msg.length === 0) return null
  return msg.trim()
}

function shortKind(k: string): string {
  // "repo.index.progress" → "progress"; "repo.embed.ok" → "ok"
  const parts = k.split('.')
  return parts[parts.length - 1] ?? k
}

function levelFor(kind: string): LogRow['level'] {
  if (kind.endsWith('.fail')) return 'error'
  if (kind.endsWith('.ok') || kind.endsWith('.finished')) return 'ok'
  if (kind.includes('warn')) return 'warn'
  return 'info'
}

// Match "Receiving objects: 42% (210/500)" or "Resolving deltas: 100%
// (500/500)" or even bare "12%". Returns the latest progress reading
// in the line (some lines pile up multiple counters separated by `,`).
const PROGRESS_RE = /([A-Za-z][\w .,'-]{0,60}?):?\s*(\d{1,3})%\s*(?:\(([\d,]+)\s*\/\s*([\d,]+)\))?/g

function extractProgress(message: string): ProgressReading | null {
  PROGRESS_RE.lastIndex = 0
  let last: ProgressReading | null = null
  let m: RegExpExecArray | null
  while ((m = PROGRESS_RE.exec(message)) !== null) {
    const pct = Number.parseInt(m[2] ?? '', 10)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue
    const current = m[3] ? Number.parseInt(m[3].replace(/,/g, ''), 10) : null
    const total = m[4] ? Number.parseInt(m[4].replace(/,/g, ''), 10) : null
    last = {
      percent: pct,
      current: Number.isFinite(current ?? NaN) ? (current as number) : null,
      total: Number.isFinite(total ?? NaN) ? (total as number) : null,
      label: (m[1] ?? '').trim(),
    }
  }
  return last
}

/**
 * Given a message with extracted progress numbers, strip the volatile
 * digits so consecutive progress lines from the same phase can be
 * recognised as "same" and collapse into one row.
 *
 * "Receiving objects: 42% (210/500)" and "Receiving objects: 53%
 * (270/500)" both reduce to "Receiving objects" → one row.
 */
function stripProgressFromMessage(
  message: string,
  progress: ProgressReading | null,
): string {
  if (!progress) return message
  // Replace the entire progress-bearing fragment with the static label.
  return message.replace(PROGRESS_RE, (_match, label) => String(label ?? '').trim())
}

// ─── History fetch ───────────────────────────────────────────────────────

interface HistorySnapshot {
  job: WorkerJobListRow | null
  events: RunEvent[]
  /** Total events in `worker_events` for this job. When this is
   *  greater than `events.length`, the panel renders a "showing last
   *  N of M" hint. Null when no job is found yet. */
  totalEvents: number | null
}

/** How many events to pull on initial hydration. Bigger repos can
 *  emit 10k+ progress rows; without a cap, mounting the repo detail
 *  page on a sqlalchemy-scale index becomes laggy because every
 *  re-render walks the full array. The live SSE stream keeps adding
 *  on top of this slice — its own cap (in the useSSE call) bounds
 *  the in-memory total at ~800 events. */
const HISTORY_EVENT_LIMIT = 500

async function hydrateHistory(repoId: string): Promise<HistorySnapshot> {
  // Most-recent job for this repo. We deliberately fetch only one
  // because the Activity panel is "what happened most recently" —
  // older jobs live on the /logs page where the operator can drill
  // through history with full filtering.
  const list = await listWorkerJobs({ repoId, limit: 1 })
  const job = list.jobs[0] ?? null
  if (!job) return { job: null, events: [], totalEvents: null }
  const detail = await fetchWorkerJob(job.id, HISTORY_EVENT_LIMIT)
  return {
    job: detail.job,
    events: detail.events.map(detailEventToRunEvent),
    totalEvents: detail.totalEvents,
  }
}

function detailEventToRunEvent(e: WorkerJobDetailEvent): RunEvent {
  return {
    kind: e.kind as RunEvent['kind'],
    ts: new Date(e.ts).getTime(),
    streamId: '',
    data: (e.payload ?? undefined) as RunEvent['data'],
  }
}

function mergeEventStreams(
  history: readonly RunEvent[],
  live: readonly RunEvent[],
): RunEvent[] {
  // Dedupe by a stable signature: (kind, ts, message-or-empty). Worker
  // appends to `worker_events` AFTER publishing on the SSE channel, so
  // a frame that arrived live before history loaded would otherwise
  // double-count when history hydrates around it.
  const seen = new Set<string>()
  const out: RunEvent[] = []
  for (const ev of [...history, ...live]) {
    if (ev.kind === 'ping') continue
    const sig = signatureOf(ev)
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(ev)
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

function signatureOf(ev: RunEvent): string {
  const body =
    ev.data && typeof ev.data === 'object'
      ? ((ev.data as Record<string, unknown>).line as string | undefined) ??
        ((ev.data as Record<string, unknown>).message as string | undefined) ??
        ''
      : typeof ev.data === 'string'
        ? ev.data
        : ''
  return `${ev.kind}|${ev.ts}|${body}`
}

// ─── Live badge ──────────────────────────────────────────────────────────

interface LiveBadge {
  kind: 'live' | 'idle' | 'reconnecting'
}

function deriveLiveBadge(
  connected: boolean,
  job: WorkerJobListRow | null | undefined,
  events: readonly RunEvent[],
): LiveBadge {
  // SSE socket open + a job is currently `running` OR a recent event
  // arrived in the last 4s → "live". SSE open but everything quiet →
  // "idle". SSE not open at all → "reconnecting".
  if (!connected) return { kind: 'reconnecting' }
  const lastTs = events.length > 0 ? events[events.length - 1]!.ts : 0
  const recent = Date.now() - lastTs < 4000
  if (job?.status === 'running' || recent) return { kind: 'live' }
  return { kind: 'idle' }
}

// ─── Formatters ──────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const s = Math.round(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function truncateInline(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ─── Inline icon ─────────────────────────────────────────────────────────

function ChevronIcon({ dir }: { dir: 'up' | 'down' }) {
  // 12×12 stroke-only chevron. currentColor so the toggle inherits the
  // surrounding muted text color.
  const d = dir === 'down' ? 'M3 5l3 3 3-3' : 'M3 7l3-3 3 3'
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}
