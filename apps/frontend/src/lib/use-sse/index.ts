/**
 * EventSource subscription hook.
 *
 * Given a stream id, opens an `EventSource` against
 * `VITE_API_URL/api/events/:streamId` (or the default `http://127.0.0.1:3001`
 * for dev) and surfaces:
 *   - `connected`  — boolean; reflects the browser's connection lifecycle
 *   - `events`     — rolling buffer of at most `cap` most-recent events
 *   - `clear()`    — empties the buffer
 *
 * Event payloads come through as `RunEvent`s. The backend sends each event
 * on its own SSE `event:` name (e.g. `run.started`), so we register a
 * listener for every known kind plus a generic `message` fallback for any
 * future kinds that aren't enumerated client-side yet.
 *
 * Heartbeats (`ping`) arrive as empty-data SSE frames; they're kept in the
 * buffer but rendered subtly so they don't drown useful events.
 *
 * Passing `null` as the stream id disables the subscription — handy when
 * no agent is selected.
 *
 * Implementation notes:
 *   - State is keyed by streamId so the "reset on prop change" happens
 *     during render, not inside an effect (avoiding the React 19
 *     `set-state-in-effect` rule).
 *   - `cap` changes don't tear the connection down; the latest cap is
 *     applied from state.
 */

import { useEffect, useState } from 'react'
import {
  runEventKinds,
  runEventSchema,
  type RunEvent,
} from '@agent-bridge/shared'

const DEFAULT_API = 'http://127.0.0.1:3001'

function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_URL?.trim()
  if (!raw) return DEFAULT_API
  try {
    const url = new URL(raw)
    return url.origin + (url.pathname === '/' ? '' : url.pathname)
  } catch {
    return DEFAULT_API
  }
}

export interface UseSSEOptions {
  cap?: number
}

export interface UseSSEResult {
  connected: boolean
  events: readonly RunEvent[]
  clear: () => void
}

interface StreamState {
  streamId: string | null
  connected: boolean
  events: RunEvent[]
}

export function useSSE(
  streamId: string | null,
  options: UseSSEOptions = {},
): UseSSEResult {
  const cap = options.cap ?? 200

  const [state, setState] = useState<StreamState>(() => ({
    streamId,
    connected: false,
    events: [],
  }))

  // Canonical "reset state on prop change" pattern: setState-in-render
  // triggers an immediate restart of the render, no flicker, no effect.
  if (state.streamId !== streamId) {
    setState({ streamId, connected: false, events: [] })
  }

  useEffect(() => {
    if (!streamId) return undefined

    const url = `${resolveApiBase()}/api/events/${encodeURIComponent(streamId)}`
    const source = new EventSource(url)

    const push = (raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      const result = runEventSchema.safeParse(parsed)
      if (!result.success) return
      setState((prev) => {
        // Late frames from a previous subscription could otherwise leak
        // into a new stream's buffer; this guard keeps them isolated.
        if (prev.streamId !== streamId) return prev
        const next = [...prev.events, result.data]
        const trimmed = next.length > cap ? next.slice(next.length - cap) : next
        return { ...prev, events: trimmed }
      })
    }

    const markConnected = (open: boolean) => {
      setState((prev) =>
        prev.streamId === streamId && prev.connected !== open
          ? { ...prev, connected: open }
          : prev,
      )
    }

    source.onopen = () => markConnected(true)
    source.onerror = () => markConnected(false)

    const handlers: Record<string, (ev: MessageEvent) => void> = {}
    for (const kind of runEventKinds) {
      const handler = (ev: MessageEvent) => push(ev.data as string)
      handlers[kind] = handler
      source.addEventListener(kind, handler)
    }
    const onMessage = (ev: MessageEvent) => push(ev.data as string)
    source.addEventListener('message', onMessage)

    return () => {
      for (const [kind, handler] of Object.entries(handlers)) {
        source.removeEventListener(kind, handler)
      }
      source.removeEventListener('message', onMessage)
      source.close()
    }
  }, [streamId, cap])

  const clear = () =>
    setState((prev) => ({ ...prev, events: [] }))

  return {
    connected: state.connected,
    events: state.events,
    clear,
  }
}
