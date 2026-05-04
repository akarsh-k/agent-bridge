/**
 * Right-slide detail surface for one entry in the global /logs feed.
 * Two flavours, one component:
 *
 *   - `kind: 'run'` → agent invocation. Fetches `/api/runs/:id`,
 *     renders prompt + output + run-event timeline.
 *   - `kind: 'worker'` → background worker job (clone / index / wiki).
 *     Fetches `/api/worker-jobs/:id`, renders job-meta header +
 *     event timeline. No prompt/output (worker jobs don't have one).
 *
 * Both flavours share the same EventTimeline / Header card / error
 * card primitives so the visual language is identical from the
 * operator's perspective. Mounting: opens with `target` non-null;
 * close clears the prop and the sheet hides.
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  RunDetailResponse,
  WorkerJobDetailResponse,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Pill } from '../../ui/pill'
import { ApiError, fetchRun, fetchWorkerJob } from '../../lib/rpc'

/** Discriminated union — what the parent wants the sheet to fetch. */
export type DetailTarget =
  | { kind: 'run'; id: string }
  | { kind: 'worker'; id: string }

interface RunDetailSheetProps {
  /** When non-null, sheet is open and loads detail for that target. */
  target: DetailTarget | null
  onClose: () => void
}

interface FetchedDetail {
  kind: 'run' | 'worker'
  run?: RunDetailResponse
  worker?: WorkerJobDetailResponse
}

export function RunDetailSheet({ target, onClose }: RunDetailSheetProps) {
  const [data, setData] = useState<FetchedDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch on open. Cleared on close so the next open shows a spinner
  // instead of stale content. The dependency array uses `target?.kind`
  // and `target?.id` so changing target while the sheet is open
  // re-fetches correctly.
  useEffect(() => {
    if (!target) {
      setData(null)
      setError(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        if (target.kind === 'run') {
          const res = await fetchRun(target.id)
          if (alive) setData({ kind: 'run', run: res })
        } else {
          const res = await fetchWorkerJob(target.id)
          if (alive) setData({ kind: 'worker', worker: res })
        }
      } catch (err) {
        if (alive) {
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load detail',
          )
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [target?.kind, target?.id])

  const open = target !== null

  const title = (() => {
    if (data?.kind === 'run' && data.run) {
      return `Run · ${data.run.run.agentName}`
    }
    if (data?.kind === 'worker' && data.worker) {
      return `${capitalise(data.worker.job.jobKind)} · ${data.worker.job.repoLabel}`
    }
    return loading ? 'Loading…' : 'Detail'
  })()

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={
        data?.kind === 'run' && data.run ? (
          <RunSubtitle run={data.run.run} />
        ) : data?.kind === 'worker' && data.worker ? (
          <WorkerJobSubtitle job={data.worker.job} />
        ) : undefined
      }
    >
      {error && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)' }}
          role="alert"
        >
          {error}
        </div>
      )}
      {!error && !data && loading && (
        <div className="ab-field-help">Fetching detail…</div>
      )}
      {data?.kind === 'run' && data.run && (
        <RunDetailBody data={data.run} />
      )}
      {data?.kind === 'worker' && data.worker && (
        <WorkerJobDetailBody data={data.worker} />
      )}
    </Sheet>
  )
}

function RunSubtitle({ run }: { run: RunDetailResponse['run'] }) {
  const status = statusPill(run.status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Pill kind={status.kind} dot>
        {status.label}
      </Pill>
      <Pill kind="neutral">{run.source}</Pill>
      <span className="ab-mono" style={{ fontSize: 11 }}>
        {run.agentSlug}
      </span>
    </span>
  )
}

function RunDetailBody({ data }: { data: RunDetailResponse }) {
  const { run, events } = data
  return (
    <>
      <RunHeader run={run} />
      {run.errorMessage && <RunErrorCard message={run.errorMessage} />}
      <CollapsibleBody title="Input prompt" body={run.inputPrompt} />
      {run.outputSummary !== null && (
        <CollapsibleBody title="Output summary" body={run.outputSummary} />
      )}
      <EventTimeline events={events} source="run_events" />
    </>
  )
}

function WorkerJobSubtitle({
  job,
}: {
  job: WorkerJobDetailResponse['job']
}) {
  const status = workerStatusPill(job.status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Pill kind={status.kind} dot>
        {status.label}
      </Pill>
      <Pill kind="neutral">{job.jobKind}</Pill>
      <span className="ab-mono" style={{ fontSize: 11 }}>
        {job.repoLabel}
      </span>
    </span>
  )
}

function WorkerJobDetailBody({
  data,
}: {
  data: WorkerJobDetailResponse
}) {
  const { job, events } = data
  return (
    <>
      <WorkerJobHeader job={job} />
      {job.errorMessage && <RunErrorCard message={job.errorMessage} />}
      <EventTimeline events={events} source="worker_events" />
    </>
  )
}

function WorkerJobHeader({
  job,
}: {
  job: WorkerJobDetailResponse['job']
}) {
  const items: Array<{ label: string; value: string }> = [
    { label: 'Repo', value: job.repoRemoteUrl },
    { label: 'Job kind', value: job.jobKind },
    { label: 'Started', value: formatTs(job.startedAt) },
    {
      label: 'Finished',
      value: job.finishedAt ? formatTs(job.finishedAt) : '—',
    },
    {
      label: 'Duration',
      value:
        job.durationMs !== null
          ? `${(job.durationMs / 1000).toFixed(2)}s`
          : '—',
    },
    { label: 'Job id', value: job.id },
  ]
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '8px 16px',
        }}
      >
        {items.map((it) => (
          <div key={it.label}>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 2,
              }}
            >
              {it.label}
            </div>
            <div className="ab-mono" style={{ fontSize: 12 }}>
              {it.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function workerStatusPill(
  status: WorkerJobDetailResponse['job']['status'],
): {
  kind: 'success' | 'warn' | 'danger' | 'neutral'
  label: string
} {
  switch (status) {
    case 'completed':
      return { kind: 'success', label: 'completed' }
    case 'running':
      return { kind: 'warn', label: 'running' }
    case 'error':
      return { kind: 'danger', label: 'error' }
    case 'aborted':
      return { kind: 'warn', label: 'aborted' }
    default:
      return { kind: 'neutral', label: status }
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function RunHeader({ run }: { run: RunDetailResponse['run'] }) {
  const items: Array<{ label: string; value: string }> = [
    { label: 'Started', value: formatTs(run.startedAt) },
    {
      label: 'Finished',
      value: run.finishedAt ? formatTs(run.finishedAt) : '—',
    },
    {
      label: 'Duration',
      value:
        run.durationMs !== null
          ? `${(run.durationMs / 1000).toFixed(2)}s`
          : '—',
    },
    {
      label: 'Prompt tokens',
      value:
        run.promptTokens !== null ? run.promptTokens.toLocaleString() : '—',
    },
    {
      label: 'Completion tokens',
      value:
        run.completionTokens !== null
          ? run.completionTokens.toLocaleString()
          : '—',
    },
    { label: 'Stream id', value: run.streamId },
  ]
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '8px 16px',
        }}
      >
        {items.map((it) => (
          <div key={it.label}>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 2,
              }}
            >
              {it.label}
            </div>
            <div className="ab-mono" style={{ fontSize: 12 }}>
              {it.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function RunErrorCard({ message }: { message: string }) {
  return (
    <div
      className="ab-card ab-card-pad ab-form-section"
      style={{
        background: 'var(--danger-bg)',
        border: '1px solid rgba(251, 113, 133, 0.24)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--danger)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 6,
        }}
      >
        Error
      </div>
      <pre
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {message}
      </pre>
    </div>
  )
}

function CollapsibleBody({
  title,
  body,
}: {
  title: string
  body: string
}) {
  const isJson = useMemo(() => looksLikeJson(body), [body])
  const pretty = useMemo(() => {
    if (!isJson) return null
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return null
    }
  }, [body, isJson])
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard.writeText(body).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-field-label-row" style={{ marginBottom: 8 }}>
        <span className="ab-field-label">{title}</span>
        <button
          type="button"
          className="ab-inline-action"
          onClick={onCopy}
          title="Copy raw text"
        >
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'var(--surface-hi)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 480,
          overflow: 'auto',
        }}
      >
        {pretty ?? body}
      </pre>
    </div>
  )
}

/** Shape both RunDetailEvent and WorkerJobDetailEvent satisfy. */
type TimelineEvent = {
  id: string
  ts: string
  kind: string
  payload: unknown
}

function EventTimeline({
  events,
  source,
}: {
  events: ReadonlyArray<TimelineEvent>
  /** Table of origin (for the section's sub-line — purely cosmetic). */
  source: 'run_events' | 'worker_events'
}) {
  // Roll consecutive token-batch / token events into one summary row.
  // Otherwise a 30-step run dumps 200+ rows that drown out tool calls.
  const rolled = useMemo(() => rollTokenEvents(events), [events])
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-head">
        <div className="ab-section-title">
          Event timeline{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
            ({events.length} event{events.length === 1 ? '' : 's'})
          </span>
        </div>
        <div className="ab-section-sub">
          Every entry from <code className="ab-mono">{source}</code>, oldest
          first. Click a row to see its raw payload.
        </div>
      </div>
      {rolled.length === 0 ? (
        <div className="ab-field-help">No events recorded.</div>
      ) : (
        <ol
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {rolled.map((row) => (
            <EventRow key={row.id} row={row} />
          ))}
        </ol>
      )}
    </div>
  )
}

interface RolledRow {
  id: string
  ts: string
  kind: string
  payload: unknown
  /** When > 1, the row represents N rolled-up token events. */
  count: number
}

function rollTokenEvents(
  events: ReadonlyArray<TimelineEvent>,
): ReadonlyArray<RolledRow> {
  const out: RolledRow[] = []
  for (const e of events) {
    const isToken = e.kind === 'run.token' || e.kind === 'run.token.batch'
    const last = out[out.length - 1]
    if (isToken && last && (last.kind === 'run.token' || last.kind === 'run.token.batch')) {
      last.count += 1
      // Keep the FIRST event's payload as the representative (or merge
      // text if you want — leaving the row representative for now).
      continue
    }
    out.push({
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      payload: e.payload,
      count: 1,
    })
  }
  return out
}

function EventRow({ row }: { row: RolledRow }) {
  const [open, setOpen] = useState(false)
  const tone = toneForKind(row.kind)
  return (
    <li
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
        }}
        title="Toggle payload"
      >
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
            minWidth: 88,
          }}
        >
          {formatClock(row.ts)}
        </span>
        <Pill kind={tone}>{row.kind}</Pill>
        {row.count > 1 && (
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: 11,
            }}
          >
            ×{row.count}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
          }}
          aria-hidden
        >
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && row.payload !== null && (
        <pre
          style={{
            margin: 0,
            padding: '8px 12px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-hi)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {safeStringify(row.payload)}
        </pre>
      )}
    </li>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function statusPill(status: RunDetailResponse['run']['status']): {
  kind: 'success' | 'warn' | 'danger' | 'neutral'
  label: string
} {
  switch (status) {
    case 'completed':
      return { kind: 'success', label: 'completed' }
    case 'running':
      return { kind: 'warn', label: 'running' }
    case 'error':
      return { kind: 'danger', label: 'error' }
    case 'aborted':
      return { kind: 'warn', label: 'aborted' }
    case 'pending':
      return { kind: 'neutral', label: 'pending' }
    default:
      return { kind: 'neutral', label: status }
  }
}

function toneForKind(
  kind: string,
): 'success' | 'warn' | 'danger' | 'neutral' {
  if (kind.endsWith('.error') || kind.endsWith('.fail')) return 'danger'
  if (kind.endsWith('.ok') || kind === 'run.finished') return 'success'
  if (kind === 'run.started') return 'neutral'
  if (kind.startsWith('run.tool') || kind.startsWith('coding-agent.'))
    return 'neutral'
  if (kind.endsWith('.progress') || kind.startsWith('run.step.'))
    return 'neutral'
  return 'neutral'
}

function looksLikeJson(s: string): boolean {
  const t = s.trim()
  return t.startsWith('{') || t.startsWith('[')
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
