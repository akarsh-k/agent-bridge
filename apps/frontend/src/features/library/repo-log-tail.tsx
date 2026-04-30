/**
 * Live SSE log strip for the repo detail page. Subscribes to the
 * repo's per-resource event stream and renders the most recent
 * activity (clone / index / wiki). Only shown when there's
 * something to show.
 */

import { useMemo } from 'react'
import { repoStreamId, type RunEvent } from '@agent-bridge/shared'
import { useSSE } from '../../lib/use-sse'

export function RepoLogTail({ repoId }: { repoId: string }) {
  const streamId = useMemo(() => repoStreamId(repoId), [repoId])
  const { connected, events } = useSSE(streamId, { cap: 200 })

  // Newest first, drop pings.
  const rows = useMemo(
    () => [...events].reverse().filter((e) => e.kind !== 'ping'),
    [events],
  )

  if (rows.length === 0 && !connected) return null

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        className="ab-section-head"
        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <div style={{ flex: 1 }}>
          <div className="ab-section-title">Activity</div>
          <div className="ab-section-sub">
            Live events from clone / index / wiki jobs against this repo.
          </div>
        </div>
        <span
          className="ab-live-chip"
          style={!connected ? { opacity: 0.55 } : undefined}
        >
          {connected ? <span className="ab-pulse-dot" /> : null}
          {connected ? 'Streaming' : 'Disconnected'}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="ab-field-help">
          No events yet — kick off a clone or re-index above.
        </div>
      ) : (
        <div
          className="ab-card ab-list-card"
          style={{ maxHeight: 320, overflowY: 'auto' }}
        >
          {rows.map((e, i) => (
            <LogLine key={`${e.ts}-${i}`} ev={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function LogLine({ ev }: { ev: RunEvent }) {
  const level: 'info' | 'tool' | 'warn' | 'error' = ev.kind.endsWith('.fail')
    ? 'error'
    : ev.kind.endsWith('.ok') || ev.kind.endsWith('.finished')
      ? 'tool'
      : ev.kind.includes('error') || ev.kind.includes('fail')
        ? 'error'
        : ev.kind.includes('warn')
          ? 'warn'
          : 'info'
  return (
    <div className="ab-log-row" style={{ gridTemplateColumns: '90px 86px 1fr' }}>
      <span className="ab-log-time">{formatTime(ev.ts)}</span>
      <span className={`ab-log-level is-${level}`}>{shortKind(ev.kind)}</span>
      <span className="ab-log-msg">
        {summarise(ev)}
      </span>
    </div>
  )
}

function shortKind(k: string): string {
  // "repo.index.progress" → "index"
  const parts = k.split('.')
  return parts[1] ?? k
}

function summarise(ev: RunEvent): string {
  if (typeof ev.data === 'string') return ev.data
  if (ev.data && typeof ev.data === 'object') {
    const d = ev.data as Record<string, unknown>
    if ('message' in d && typeof d.message === 'string') {
      return d.message
    }
    if ('progress' in d || 'percent' in d) {
      return JSON.stringify(d)
    }
  }
  return ev.kind
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}
