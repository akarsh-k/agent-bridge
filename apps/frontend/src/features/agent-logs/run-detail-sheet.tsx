/**
 * Centered detail modal for one entry in the global /logs feed.
 * Two flavours, one component:
 *
 *   - `kind: 'run'` → agent invocation. Fetches `/api/runs/:id`,
 *     renders a metadata rail (status, metrics, timing, ids) beside the
 *     prompt + output + run-event timeline.
 *   - `kind: 'worker'` → background worker job (clone / index / wiki).
 *     Fetches `/api/worker-jobs/:id`, renders the job-meta rail beside
 *     the event timeline. No prompt/output (worker jobs don't have one).
 *
 * A wide two-pane modal (not the right sheet) so the dense event
 * timeline + JSON payloads get room to breathe. Mounting: renders only
 * when `target` is non-null; close clears the prop.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  RunDetailResponse,
  RunListRow,
  WorkerJobDetailResponse,
} from '@agent-bridge/shared'
import { stripPromptEnrichments } from '@agent-bridge/shared'
import { Pill } from '../../ui/pill'
import { ChatIcon, CheckIcon, CloseIcon, CopyIcon } from '../../ui/icons'
import { Markdown } from '../../ui/markdown'
import {
  ApiError,
  fetchRun,
  fetchRunEventPayload,
  fetchWorkerJob,
  listRuns,
} from '../../lib/rpc'
import { formatDurationMs } from './event-labels'
import { EventTimeline } from './event-timeline'

/** Discriminated union — what the parent wants the modal to fetch. */
export type DetailTarget =
  | { kind: 'run'; id: string }
  | { kind: 'worker'; id: string }

interface RunDetailSheetProps {
  /** When non-null, modal is open and loads detail for that target. */
  target: DetailTarget | null
  onClose: () => void
  /** Open another run in place. Drives the thread turn-nav (prev/next). */
  onNavigate?: (runId: string) => void
}

interface FetchedDetail {
  kind: 'run' | 'worker'
  run?: RunDetailResponse
  worker?: WorkerJobDetailResponse
}

/** Compact chevron for the turn-nav prev/next buttons. */
function TurnChevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
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
      <path
        d={
          dir === 'left' ? 'M10 3.5 L5.5 8 L10 12.5' : 'M6 3.5 L10.5 8 L6 12.5'
        }
      />
    </svg>
  )
}

export function RunDetailSheet({
  target,
  onClose,
  onNavigate,
}: RunDetailSheetProps) {
  const [data, setData] = useState<FetchedDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The sibling runs of this run's thread (its conversation's turns), oldest
  // first, so the header can show "Turn N of M" and step prev/next.
  const [threadRuns, setThreadRuns] = useState<readonly RunListRow[]>([])

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
          // modal is the operator's debug view, so we lift the cap
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

  // Load the thread's turns once the run detail resolves, for the turn-nav.
  const runThreadId =
    data?.kind === 'run' ? (data.run?.run.mastraThreadId ?? null) : null
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!runThreadId) {
        if (alive) setThreadRuns([])
        return
      }
      try {
        const res = await listRuns({ mastraThreadId: runThreadId, limit: 100 })
        if (!alive) return
        // listRuns is newest-first; a conversation reads oldest-first.
        setThreadRuns([...res.runs].reverse())
      } catch {
        if (alive) setThreadRuns([])
      }
    })()
    return () => {
      alive = false
    }
  }, [runThreadId])

  // Esc to close while open.
  useEffect(() => {
    if (target === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, onClose])

  if (target === null) return null

  // Turn-nav: where this run sits among its thread's turns (oldest = 1).
  const currentRunId = data?.kind === 'run' ? (data.run?.run.id ?? null) : null
  const turnIdx = currentRunId
    ? threadRuns.findIndex((r) => r.id === currentRunId)
    : -1
  const turnTotal = threadRuns.length
  const prevRun = turnIdx > 0 ? threadRuns[turnIdx - 1] : null
  const nextRun =
    turnIdx >= 0 && turnIdx < turnTotal - 1 ? threadRuns[turnIdx + 1] : null
  const showTurnNav = Boolean(onNavigate) && turnIdx >= 0 && turnTotal > 1

  const title = (() => {
    if (data?.kind === 'run' && data.run) {
      return `Run · ${data.run.run.agentName}`
    }
    if (data?.kind === 'worker' && data.worker) {
      return `${capitalise(data.worker.job.jobKind)} · ${data.worker.job.repoLabel}`
    }
    return loading ? 'Loading…' : 'Detail'
  })()

  const subtitle =
    data?.kind === 'run' && data.run ? (
      <RunSubtitle run={data.run.run} />
    ) : data?.kind === 'worker' && data.worker ? (
      <WorkerJobSubtitle job={data.worker.job} />
    ) : null

  return (
    <div className="ab-detail-overlay" onClick={onClose}>
      <div
        className="ab-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Detail'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ab-detail-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="ab-detail-modal-title">{title}</div>
            {subtitle && <div className="ab-detail-modal-sub">{subtitle}</div>}
          </div>
          <button
            type="button"
            className="ab-icon-btn ab-detail-modal-close"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </div>

        {showTurnNav && (
          <div
            className="ab-detail-convbar"
            role="group"
            aria-label="Conversation turns"
          >
            <span className="ab-detail-convbar-label">
              <ChatIcon />
              <span>
                Turn{' '}
                <span className="ab-detail-convbar-turn">{turnIdx + 1}</span> of{' '}
                {turnTotal} in this conversation
              </span>
            </span>
            <div className="ab-turnnav">
              <button
                type="button"
                className="ab-turnnav-btn"
                disabled={!prevRun}
                onClick={() => prevRun && onNavigate?.(prevRun.id)}
                title="Previous turn (older)"
              >
                <TurnChevron dir="left" />
                Previous
              </button>
              <button
                type="button"
                className="ab-turnnav-btn"
                disabled={!nextRun}
                onClick={() => nextRun && onNavigate?.(nextRun.id)}
                title="Next turn (newer)"
              >
                Next
                <TurnChevron dir="right" />
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="ab-detail-modal-state" role="alert">
            <span
              style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}
            >
              {error}
            </span>
          </div>
        )}
        {!error && !data && loading && (
          <div className="ab-detail-modal-state">
            <span className="ab-loading-row">
              <span className="ab-pulse-dot" />
              Fetching detail…
            </span>
          </div>
        )}
        {data?.kind === 'run' && data.run && <RunDetailBody data={data.run} />}
        {data?.kind === 'worker' && data.worker && (
          <WorkerJobDetailBody data={data.worker} />
        )}
      </div>
    </div>
  )
}

function RunSubtitle({ run }: { run: RunDetailResponse['run'] }) {
  const status = statusPill(run.status)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
      }}
    >
      <Pill kind={status.kind} dot>
        {status.label}
      </Pill>
      <Pill kind="neutral">{run.source}</Pill>
      <span className="ab-mono" style={{ fontSize: 'var(--text-2xs)' }}>
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
type RunCallsite = NonNullable<RunDetailResponse['run']['callsite']>

/** `web-chat v1.2` style label for the calling client. */
function callsiteClientLabel(callsite: RunCallsite): string {
  return callsite.client.version
    ? `${callsite.client.name} v${callsite.client.version}`
    : callsite.client.name
}

/** Best human-readable repo label from whatever the callsite carried,
 *  or null when the run supplied no repo hint (e.g. web-chat). */
function callsiteRepoLabel(callsite: RunCallsite): string | null {
  return (
    callsite.repo?.label ||
    (callsite.repo?.remote_url
      ? callsite.repo.remote_url.replace(/^https?:\/\/[^/]+\//, '')
      : null) ||
    callsite.repo?.local_folder ||
    null
  )
}

function CallsiteBadge({ callsite }: { callsite: RunCallsite }) {
  const clientLabel = callsiteClientLabel(callsite)
  const repoLabel = callsiteRepoLabel(callsite)

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
        gap: 'var(--space-1_5)',
        padding: 'var(--space-0_5) var(--space-2_5)',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--accent-bg)',
        border: '1px solid var(--accent-border)',
        color: 'var(--accent-300)',
        fontSize: 'var(--text-2xs)',
        fontWeight: 'var(--fw-medium)',
        maxWidth: 420,
      }}
    >
      <span
        className="ab-mono"
        style={{
          fontSize: 'var(--text-2xs)',
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
          fontSize: 'var(--text-2xs)',
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
            fontSize: 'var(--text-2xs)',
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
  // Pull the cap-exhausted signal off the most recent run.finished event
  // so the rail can render "Steps N/M" and the main can show the
  // truncation notice without a schema round-trip onto the `runs` table.
  const stepLimit = extractStepLimit(events)
  // Stable identity so the timeline's lazy-payload effect doesn't re-fetch
  // on every re-render (the SSE tail re-renders a live run constantly).
  const loadEventPayload = useCallback(
    (eventId: string) => fetchRunEventPayload(run.id, eventId),
    [run.id],
  )
  return (
    <div className="ab-detail-modal-body">
      <aside className="ab-detail-rail">
        <RunMetaRail run={run} stepLimit={stepLimit} />
      </aside>
      <div className="ab-detail-main">
        {run.errorMessage && <RunErrorCard message={run.errorMessage} />}
        {stepLimit?.exhausted && <StepLimitNotice stepLimit={stepLimit} />}
        <CollapsibleBody
          title="Input prompt"
          body={stripPromptEnrichments(run.inputPrompt)}
        />
        {run.outputSummary !== null && (
          <CollapsibleBody
            title="Output summary"
            body={run.outputSummary}
            render="markdown"
          />
        )}
        <EventTimeline
          events={events}
          source="run_events"
          liveStreamId={run.status === 'running' ? run.streamId : null}
          loadEventPayload={loadEventPayload}
        />
      </div>
    </div>
  )
}

function RunMetaRail({
  run,
  stepLimit,
}: {
  run: RunDetailResponse['run']
  stepLimit: StepLimitSummary | null
}) {
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
  ]
  if (stepLimit) {
    metrics.push({
      label: 'Steps',
      value: `${stepLimit.stepCount} / ${stepLimit.maxSteps}`,
    })
  }
  return (
    <>
      <div className="ab-detail-rail-group">
        <div className="ab-detail-rail-label">Metrics</div>
        {metrics.map((m) => (
          <Metric key={m.label} label={m.label} value={m.value} />
        ))}
      </div>
      {run.callsite && (
        <div className="ab-detail-rail-group">
          <div className="ab-detail-rail-label">Origin</div>
          <DebugCell label="Client" value={callsiteClientLabel(run.callsite)} />
          <DebugCell label="Agent" value={run.callsite.agent.slug} />
          <DebugCell label="Tool" value={run.callsite.tool.name} />
          {callsiteRepoLabel(run.callsite) && (
            <DebugCell
              label="Repo"
              value={callsiteRepoLabel(run.callsite) as string}
            />
          )}
        </div>
      )}
      <div className="ab-detail-rail-group">
        <div className="ab-detail-rail-label">Timing</div>
        <DebugCell label="Started" value={formatTs(run.startedAt)} />
        <DebugCell
          label="Finished"
          value={run.finishedAt ? formatTs(run.finishedAt) : '—'}
        />
      </div>
      <div className="ab-detail-rail-group">
        <div className="ab-detail-rail-label">Stream</div>
        <DebugCell label="Stream id" value={run.streamId} />
      </div>
    </>
  )
}

function WorkerJobSubtitle({ job }: { job: WorkerJobDetailResponse['job'] }) {
  const status = workerStatusPill(job.status)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <Pill kind={status.kind} dot>
        {status.label}
      </Pill>
      <Pill kind="neutral">{job.jobKind}</Pill>
      <span className="ab-mono" style={{ fontSize: 'var(--text-2xs)' }}>
        {job.repoLabel}
      </span>
    </span>
  )
}

function WorkerJobDetailBody({ data }: { data: WorkerJobDetailResponse }) {
  const { job, events } = data
  return (
    <div className="ab-detail-modal-body">
      <aside className="ab-detail-rail">
        <WorkerMetaRail job={job} />
      </aside>
      <div className="ab-detail-main">
        {job.errorMessage && <RunErrorCard message={job.errorMessage} />}
        <EventTimeline
          events={events}
          source="worker_events"
          liveStreamId={null}
        />
      </div>
    </div>
  )
}

function WorkerMetaRail({ job }: { job: WorkerJobDetailResponse['job'] }) {
  return (
    <>
      <div className="ab-detail-rail-group">
        <div className="ab-detail-rail-label">Job</div>
        <DebugCell label="Repo" value={job.repoRemoteUrl} />
        <DebugCell label="Job kind" value={job.jobKind} />
        <DebugCell label="Job id" value={job.id} />
      </div>
      <div className="ab-detail-rail-group">
        <div className="ab-detail-rail-label">Timing</div>
        <DebugCell label="Started" value={formatTs(job.startedAt)} />
        <DebugCell
          label="Finished"
          value={job.finishedAt ? formatTs(job.finishedAt) : '—'}
        />
        <DebugCell
          label="Duration"
          value={
            job.durationMs !== null
              ? `${(job.durationMs / 1000).toFixed(2)}s`
              : '—'
          }
        />
      </div>
    </>
  )
}

function workerStatusPill(status: WorkerJobDetailResponse['job']['status']): {
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

interface StepLimitSummary {
  readonly exhausted: boolean
  readonly stepCount: number
  readonly maxSteps: number
}

function extractStepLimit(
  events: RunDetailResponse['events'],
): StepLimitSummary | null {
  // Walk newest-first; pick the first run.finished. Multiple shouldn't
  // happen (dispatcher emits one) but the timeline is robust to
  // duplicates so we are too.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.kind !== 'run.finished') continue
    const p = e.payload
    if (!p || typeof p !== 'object') return null
    const rec = p as Record<string, unknown>
    const exhausted = rec['stepsExhausted']
    const stepCount = rec['stepCount']
    const maxSteps = rec['maxSteps']
    if (
      typeof exhausted !== 'boolean' ||
      typeof stepCount !== 'number' ||
      typeof maxSteps !== 'number' ||
      maxSteps <= 0
    ) {
      return null
    }
    return { exhausted, stepCount, maxSteps }
  }
  return null
}

function StepLimitNotice({ stepLimit }: { stepLimit: StepLimitSummary }) {
  return (
    <div
      role="status"
      className="ab-card ab-card-pad ab-form-section"
      style={{
        background: 'var(--warn-bg)',
        border: '1px solid var(--warn-border)',
      }}
    >
      <div
        style={{
          fontWeight: 'var(--fw-semibold)',
          marginBottom: 'var(--space-0_5)',
          color: 'var(--text)',
        }}
      >
        Hit step limit ({stepLimit.stepCount}/{stepLimit.maxSteps})
      </div>
      <div
        style={{
          color: 'var(--text-dim)',
          fontSize: 'var(--text-sm)',
          lineHeight: 1.5,
        }}
      >
        The agent loop ran out of steps before the model could write its final
        answer. The output below is likely missing the synthesis turn. Raise the
        agent's Step limit on its Configure tab if this is a deep-research
        workload.
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-0_5)',
        }}
      >
        {label}
      </div>
      <div
        className="ab-mono"
        style={{ fontSize: 'var(--text-base)', color: 'var(--text)' }}
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
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-0_5)',
        }}
      >
        {label}
      </div>
      <div
        className="ab-mono"
        style={{
          fontSize: 'var(--text-xs)',
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
        border: '1px solid var(--danger-border)',
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 'var(--fw-semibold)',
          color: 'var(--danger)',
          marginBottom: 'var(--space-1_5)',
        }}
      >
        Error
      </div>
      <pre
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
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
  render = 'raw',
}: {
  title: string
  body: string
  /** `raw` shows literal preformatted text (prompts, JSON); `markdown`
   * parses the body so headings and prose read as written. */
  render?: 'raw' | 'markdown'
}) {
  const isJson = useMemo(
    () => render === 'raw' && looksLikeJson(body),
    [body, render],
  )
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
      <div
        className="ab-field-label-row"
        style={{ alignItems: 'center', marginBottom: 'var(--space-2)' }}
      >
        <span className="ab-field-label">{title}</span>
        <button
          type="button"
          className="ab-tool-chip"
          onClick={onCopy}
          title="Copy raw text"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div
        style={{
          background: 'var(--code-well)',
          border: '1px solid var(--code-well-border)',
          borderRadius: 'var(--radius)',
          maxHeight: 480,
          overflow: 'auto',
          // Markdown carries its own block margins, so it needs less vertical
          // padding; both modes share 16px horizontal so column-0 lines don't
          // hug the border and the two stacked wells align their left edge.
          padding:
            render === 'markdown'
              ? 'var(--space-0_5) var(--space-4)'
              : 'var(--space-2_5) var(--space-4)',
        }}
      >
        {render === 'markdown' ? (
          <Markdown source={body} />
        ) : (
          <pre
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {pretty ?? body}
          </pre>
        )}
      </div>
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
