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
import { formatDurationMs } from './event-labels'
import { EventTimeline } from './event-timeline'

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
  // instead of stale content. Capture the discriminator fields once so
  // the effect depends only on primitives — parents construct `target`
  // as a fresh object literal each render, so depending on `target`
  // itself would re-fire the effect every parent render and infinite-
  // loop with the setState calls below.
  const targetKind = target?.kind
  const targetId = target?.id
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!targetKind || !targetId) {
        if (alive) setData(null)
        if (alive) setError(null)
        return
      }
      if (alive) setLoading(true)
      if (alive) setError(null)
      try {
        if (targetKind === 'run') {
          const res = await fetchRun(targetId)
          if (alive) setData({ kind: 'run', run: res })
        } else {
          // The repo activity panel uses a 500-event hydration cap
          // (in `RepoLogTail`) to keep its mount cheap. This detail
          // sheet is the operator's debug view, so we lift the cap
          // to the endpoint's maximum (5000) — full history is
          // exactly what someone clicking a worker job here wants.
          const res = await fetchWorkerJob(targetId, 5000)
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
  }, [targetKind, targetId])

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
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <Pill kind={status.kind} dot>
        {status.label}
      </Pill>
      <Pill kind="neutral">{run.source}</Pill>
      <span className="ab-mono" style={{ fontSize: 11 }}>
        {run.agentSlug}
      </span>
      {run.callsite && <CallsiteBadge callsite={run.callsite} />}
    </span>
  )
}

/**
 * Compact provenance badge surfaced on the run-detail header. Reads
 * left-to-right: client → tool → repo. Omits any segment that has no
 * data so web-chat runs render as a small chip and bridge runs grow
 * naturally with whatever metadata they carried. Stays platform-
 * agnostic — no special-casing for any specific MCP client.
 */
function CallsiteBadge({
  callsite,
}: {
  callsite: NonNullable<RunDetailResponse['run']['callsite']>
}) {
  const clientLabel = callsite.client.version
    ? `${callsite.client.name} v${callsite.client.version}`
    : callsite.client.name
  const repoLabel =
    callsite.repo?.label ||
    (callsite.repo?.remote_url
      ? callsite.repo.remote_url.replace(/^https?:\/\/[^/]+\//, '')
      : null) ||
    callsite.repo?.local_folder ||
    null

  const tooltipParts: string[] = [
    `client: ${clientLabel}`,
    `tool: ${callsite.tool.name}`,
  ]
  if (repoLabel) tooltipParts.push(`repo: ${repoLabel}`)

  return (
    <span
      title={tooltipParts.join(' · ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--accent-bg)',
        border: '1px solid var(--accent-border)',
        color: 'var(--accent-300)',
        fontSize: 11,
        fontWeight: 500,
        maxWidth: 420,
      }}
    >
      <span
        className="ab-mono"
        style={{
          fontSize: 11,
          color: 'var(--accent-300)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {clientLabel}
      </span>
      <span
        className="ab-mono"
        style={{
          fontSize: 11,
          color: 'var(--text-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        · {callsite.tool.name}
      </span>
      {repoLabel && (
        <span
          className="ab-mono"
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          · {repoLabel}
        </span>
      )}
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
      <EventTimeline
        events={events}
        source="run_events"
        liveStreamId={run.status === 'running' ? run.streamId : null}
      />
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
      <EventTimeline
        events={events}
        source="worker_events"
        liveStreamId={null}
      />
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
  const [showDebug, setShowDebug] = useState(false)
  const metrics: Array<{ label: string; value: string }> = [
    {
      label: 'Duration',
      value:
        run.durationMs !== null
          ? formatDurationMs(run.durationMs)
          : run.status === 'running'
            ? 'running…'
            : '—',
    },
    {
      label: 'Prompt',
      value:
        run.promptTokens !== null
          ? `${run.promptTokens.toLocaleString()} tok`
          : '—',
    },
    {
      label: 'Completion',
      value:
        run.completionTokens !== null
          ? `${run.completionTokens.toLocaleString()} tok`
          : '—',
    },
  ]
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 24px',
          alignItems: 'baseline',
        }}
      >
        {metrics.map((m) => (
          <Metric key={m.label} label={m.label} value={m.value} />
        ))}
        <button
          type="button"
          onClick={() => setShowDebug((s) => !s)}
          className="ab-inline-action"
          style={{ marginLeft: 'auto' }}
        >
          {showDebug ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {showDebug && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px 16px',
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          <DebugCell label="Started" value={formatTs(run.startedAt)} />
          <DebugCell
            label="Finished"
            value={run.finishedAt ? formatTs(run.finishedAt) : '—'}
          />
          <DebugCell label="Stream id" value={run.streamId} />
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        className="ab-mono"
        style={{ fontSize: 14, color: 'var(--text)' }}
      >
        {value}
      </div>
    </div>
  )
}

function DebugCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        className="ab-mono"
        style={{
          fontSize: 12,
          color: 'var(--text-dim)',
          wordBreak: 'break-all',
        }}
      >
        {value}
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

function looksLikeJson(s: string): boolean {
  const t = s.trim()
  return t.startsWith('{') || t.startsWith('[')
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}
