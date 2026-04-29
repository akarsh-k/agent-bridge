/**
 * Activity panel — tails the `/api/events/:streamId` SSE stream and renders
 * each event as a stacked card.
 *
 * For now the stream id is the selected agent id. Phases 2/3 will add more
 * producers (worker indexing, mastra run steps) that publish onto the same
 * stream so the panel "just shows" whatever's running for that agent.
 *
 * Rendering rules:
 *   - Ping heartbeats are hidden by default (noise).
 *   - Error-kinds get a red accent so they pop.
 *   - Timestamps are shown as local time, HH:mm:ss.
 *   - Buffer cap is 200 — older events scroll off.
 */

import { useMemo } from 'react'
import type { RunEvent, RunEventKind } from '@agent-bridge/shared'

import './index.css'

const KIND_ICON: Record<RunEventKind, string> = {
  'run.started': '▶',
  'run.token': '·',
  'run.token.batch': '·',
  'run.step.started': '→',
  'run.step.finished': '✓',
  'run.tool.called': '⚙',
  'run.tool.result': '◈',
  'run.mcp.log': 'ⓘ',
  'run.error': '✕',
  'run.finished': '■',
  'worker.progress': '↻',
  'worker.log': '…',
  'worker.finished': '✓',
  'worker.error': '✕',
  'repo.clone.started': '▶',
  'repo.clone.progress': '↻',
  'repo.clone.ok': '✓',
  'repo.clone.fail': '✕',
  'repo.index.started': '▶',
  'repo.index.progress': '↻',
  'repo.index.ok': '✓',
  'repo.index.fail': '✕',
  'repo.wiki.started': '▶',
  'repo.wiki.progress': '↻',
  'repo.wiki.ok': '✓',
  'repo.wiki.fail': '✕',
  ping: '·',
}

function iconClass(kind: RunEventKind): string {
  if (
    kind === 'run.error' ||
    kind === 'worker.error' ||
    kind === 'repo.clone.fail' ||
    kind === 'repo.index.fail' ||
    kind === 'repo.wiki.fail'
  )
    return 'activity-icon err'
  if (
    kind === 'run.finished' ||
    kind === 'worker.finished' ||
    kind === 'run.step.finished' ||
    kind === 'repo.clone.ok' ||
    kind === 'repo.index.ok' ||
    kind === 'repo.wiki.ok'
  )
    return 'activity-icon ok'
  return 'activity-icon'
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false })
}

function formatPayload(event: RunEvent): string | null {
  if (event.data === undefined || event.data === null) return null
  if (typeof event.data === 'string') return event.data
  try {
    const s = JSON.stringify(event.data, null, 2)
    return s.length > 800 ? `${s.slice(0, 800)}…` : s
  } catch {
    return null
  }
}

export function ActivityPanel({
  streamId,
  connected,
  events,
}: {
  streamId: string | null
  connected: boolean
  events: readonly RunEvent[]
}) {
  const visible = useMemo(
    () => events.filter((e) => e.kind !== 'ping').slice().reverse(),
    [events],
  )

  if (!streamId) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-title">No agent selected</div>
        <div className="rail-empty-hint">
          Open an agent to tail its activity stream.
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="activity-stream">
        <span
          className={`activity-stream-dot${connected ? ' live' : ''}`}
          aria-hidden="true"
        />
        <span>
          {connected ? 'Live' : 'Connecting…'}
          <span className="muted"> · stream </span>
          <code style={{ fontSize: 10.5 }}>{streamId.slice(0, 8)}…</code>
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="rail-empty">
          <div className="rail-empty-title">Nothing to show yet</div>
          <div className="rail-empty-hint">
            Activity appears here when the agent or its background jobs
            publish events.
          </div>
        </div>
      ) : (
        <ul className="activity-list" aria-label="Activity stream">
          {visible.map((event, i) => {
            const payload = formatPayload(event)
            return (
              <li
                key={`${event.ts}-${i}`}
                className="activity-item"
                data-kind={event.kind}
              >
                <span className={iconClass(event.kind)} aria-hidden="true">
                  {KIND_ICON[event.kind]}
                </span>
                <div className="activity-body">
                  <div className="activity-row-head">
                    <div className="activity-kind">{event.kind}</div>
                    <time className="activity-ts" dateTime={new Date(event.ts).toISOString()}>
                      {formatTs(event.ts)}
                    </time>
                  </div>
                  {payload ? (
                    <div className="activity-payload mono">{payload}</div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
