/**
 * Per-assistant-message expandable run timeline for the chat tab.
 *
 * Each completed assistant turn carries a `runId`. When the operator
 * wants to peek under the hood ("why did this take 8s?", "what
 * arguments did the tool actually receive?"), they click "Show run
 * timeline" and we lazy-fetch `/api/runs/:id` then render the same
 * `EventTimeline` the `/logs` sheet uses.
 *
 * "Show infrastructure events" toggle controls a chat-tab-specific
 * filter — chat operators don't usually want `run.started` /
 * `run.finished` / token-batch rows polluting the view (they already
 * see the streamed text and lifecycle in the chat bubble itself).
 * Default OFF; flip ON for full debug parity with `/logs`.
 *
 * Step boundary events (`run.step.started` / `run.step.finished`)
 * stay visible regardless of the toggle — they drive the timeline's
 * section headers, so hiding them would collapse the visual grouping.
 *
 * Live-tail is intentionally NOT enabled here. The chat bubble itself
 * already streams text + tool calls live; the timeline is the
 * after-the-fact debug surface. If the operator expands during a
 * streaming run, we refetch when `status` flips to `done` so they see
 * the complete picture without having to collapse + re-expand.
 */

import { useEffect, useState } from 'react'
import type {
  ChatMessageStatus,
} from '../../lib/use-chat'
import { ApiError, fetchRun } from '../../lib/rpc'
import {
  EventTimeline,
  type TimelineEvent,
} from '../agent-logs/event-timeline'

/**
 * Event kinds suppressed when the "Show infrastructure events" toggle
 * is OFF (the default for chat-tab). Step boundaries are intentionally
 * NOT in this list — they're needed for the timeline's section
 * grouping and aren't really noise.
 */
const INFRASTRUCTURE_KINDS: ReadonlySet<string> = new Set([
  'run.started',
  'run.finished',
  'run.token',
  'run.token.batch',
  'ping',
])

interface ChatRunTimelineProps {
  runId: string
  /** Used to trigger a refetch when a run we expanded mid-stream
   *  completes — so the operator sees the final timeline without
   *  needing to collapse + re-expand. */
  status: ChatMessageStatus
}

export function ChatRunTimeline({
  runId,
  status,
}: ChatRunTimelineProps) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<ReadonlyArray<TimelineEvent> | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showInfrastructure, setShowInfrastructure] = useState(false)

  // Lazy fetch: only hit `/api/runs/:id` when the operator actually
  // expands. Refetches when the run transitions out of `streaming` so
  // a mid-stream expansion picks up the completed event log without
  // user intervention.
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      // All state writes are kept inside the async block so the
      // effect body has no synchronous setState (required by
      // react-hooks/set-state-in-effect under React 19).
      if (alive) setLoading(true)
      if (alive) setError(null)
      try {
        const res = await fetchRun(runId)
        if (alive) setEvents(res.events)
      } catch (err) {
        if (alive) {
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load run timeline',
          )
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, runId, status])

  const filtered =
    events === null
      ? null
      : showInfrastructure
        ? events
        : events.filter((e) => !INFRASTRUCTURE_KINDS.has(e.kind))

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="ab-inline-action"
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        {open ? '▾' : '▸'} {open ? 'Hide' : 'Show'} run timeline
        {events !== null && (
          <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>
            · {events.length}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            borderTop: '1px solid var(--border)',
            paddingTop: 10,
          }}
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
          {loading && events === null && (
            <div className="ab-field-help">Loading run timeline…</div>
          )}
          {filtered !== null && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 8,
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                }}
              >
                <input
                  id={`infra-${runId}`}
                  type="checkbox"
                  checked={showInfrastructure}
                  onChange={(e) => setShowInfrastructure(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <label
                  htmlFor={`infra-${runId}`}
                  style={{ cursor: 'pointer' }}
                  title={
                    'Includes run.started, run.finished, token batches, and ' +
                    'ping frames — useful for debugging cadence, noisy in ' +
                    'normal use.'
                  }
                >
                  Show infrastructure events
                </label>
                {!showInfrastructure && events && events.length !== filtered.length && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    · {events.length - filtered.length} hidden
                  </span>
                )}
              </div>
              <EventTimeline
                events={filtered}
                source="run_events"
                liveStreamId={null}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
