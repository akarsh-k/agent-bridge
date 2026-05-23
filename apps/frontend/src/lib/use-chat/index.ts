/**
 * Chat state machine for one agent.
 *
 * Owns:
 *   - The list of rendered messages (user bubbles + streaming assistant bubbles).
 *   - The current `threadId` / `resourceId` passed to every POST
 *     /api/agents/:id/runs. Regenerating the thread (via `resetThread`)
 *     starts a new conversation; memory-enabled agents will stop seeing
 *     previous turns in their context.
 *   - The SSE subscription for the currently-streaming run. At most one
 *     run is active at a time — the composer is disabled until the run
 *     reaches a terminal state (`run.finished` or `run.error`).
 *
 * Does NOT own:
 *   - Rendering (that's `<ChatPanel />` and friends).
 *   - Persistence. Messages are in-memory per agent. When the user
 *     switches agents we swap the whole state; nothing is pushed to
 *     localStorage in this phase. DB-backed replay will be added once
 *     `runs.mastra_thread_id` columns exist.
 *
 * SSE plumbing notes:
 *   - We reuse the shared `useSSE` hook: setting `activeRunId` causes
 *     it to subscribe to `run:<runId>`. That stream only carries events
 *     for this run, so we don't need to filter by `runId` inside the
 *     reducer — the stream id itself is the filter.
 *   - Terminal events (`run.finished`, `run.error`) are NOT awaited on
 *     the HTTP side; they arrive via SSE only. The reducer flips the
 *     assistant message to its final state and clears `activeRunId` so
 *     the user can send the next turn.
 *   - Token dedupe is a high-water mark: on `run.token` append if
 *     `index > lastIndex`; on `run.token.batch` fill in the tail if the
 *     batch covers indices past `lastIndex`. In the common case (we
 *     subscribed before the run started) we see every `run.token`
 *     individually and ignore every batch — the batch path only ever
 *     kicks in on a reconnect, which isn't wired in this phase.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RunErrorPayload,
  RunEvent,
  RunFinishedPayload,
  RunMcpLogPayload,
  RunStartedPayload,
  RunStepFinishedPayload,
  RunStepStartedPayload,
  RunTokenBatchPayload,
  RunTokenPayload,
  RunToolCalledPayload,
  RunToolResultPayload,
} from '@agent-bridge/shared'
import { runStreamId, stripCallsiteBlock } from '@agent-bridge/shared'
import {
  ApiError,
  apiBaseUrl,
  callApi,
  deleteAgentThread as rpcDeleteAgentThread,
  getActiveRunForThread as rpcGetActiveRunForThread,
  getAgentThreadMessages as rpcGetAgentThreadMessages,
  listAgentThreads as rpcListAgentThreads,
} from '../rpc'
import { useSSE } from '../use-sse'
import { navigate } from '../router'

// ─── Public types ────────────────────────────────────────────────────────

export interface ChatStepInfo {
  readonly stepIndex: number
  readonly messageId: string
  readonly status: 'streaming' | 'done'
  readonly finishReason?: string | null
  readonly usage?: TokenUsage
}

export interface TokenUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

export interface ChatToolInvocation {
  readonly toolCallId: string
  readonly toolName: string
  readonly stepIndex: number
  readonly input: unknown
  readonly output?: unknown
  readonly error?: string
  readonly status: 'pending' | 'done' | 'error'
  readonly startedAt: number
  readonly finishedAt?: number
}

/**
 * One scrubbed stderr line from a mounted stdio external MCP. Collected
 * per-assistant-message so the UI can group them under the matching
 * tool card. `connectionName` is the user-visible name (NOT the slug);
 * we join against the tool call's auto-prefix to decide which card to
 * anchor the line under — see `splitLogsByConnection` below.
 */
export interface ChatMcpLog {
  readonly ts: number
  readonly connectionId: string
  readonly connectionName: string
  readonly level: 'info' | 'warn' | 'error'
  readonly line: string
}

export type ChatMessageStatus = 'streaming' | 'done' | 'error'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly createdAt: number
  readonly text: string
  readonly runId?: string
  readonly providerKind?: string
  readonly modelId?: string
  readonly agentName?: string
  readonly toolCount?: number
  readonly gitnexusMounted?: boolean
  readonly status: ChatMessageStatus
  readonly errorKind?: RunErrorPayload['kind']
  readonly errorMessage?: string
  readonly toolCalls: ChatToolInvocation[]
  readonly steps: ChatStepInfo[]
  /**
   * Scrubbed stderr lines from any mounted external MCP. Appended in
   * arrival order; there is NO per-tool-call correlation upstream
   * (stdio stderr is a single stream per subprocess) so the UI
   * groups them by `connectionName` and renders each group under the
   * MOST RECENT tool card whose prefix matches the connection slug.
   * If no such tool card exists yet, the group renders as a standalone
   * block at the bottom of the message.
   */
  readonly mcpLogs: ChatMcpLog[]
  readonly finishReason?: string | null
  readonly durationMs?: number
  readonly usage?: TokenUsage
  /**
   * Index of the highest `RunTokenPayload.index` already applied. Used
   * for dedupe against `run.token.batch` frames on reconnect.
   */
  readonly lastTokenIndex: number
}

/** Thread metadata as surfaced to the chat UI's switcher. */
export interface ChatThreadMeta {
  readonly threadId: string
  readonly title: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
}

export interface UseChatResult {
  readonly messages: readonly ChatMessage[]
  readonly threadId: string
  readonly resourceId: string
  readonly activeRunId: string | null
  readonly sending: boolean
  readonly sendError: string | null
  readonly sseConnected: boolean
  /** All past threads for the agent — newest-first. */
  readonly threads: readonly ChatThreadMeta[]
  /** True while fetching messages on a thread switch. */
  readonly loadingMessages: boolean
  /** True while a thread fetch failed (so the UI can show a retry). */
  readonly threadsError: string | null
  send(prompt: string): Promise<void>
  /** Mint a new thread + switch to it; the old thread stays on the server. */
  newThread(): void
  /** Switch to an existing thread and replay its messages. */
  switchThread(threadId: string): Promise<void>
  /** Delete a thread + every message in it; switches to next thread if active. */
  deleteThread(threadId: string): Promise<void>
  /** Force a re-fetch of the threads list (e.g. after a run finishes). */
  refreshThreads(): Promise<void>
}

interface UseChatInput {
  readonly agentId: string | null
  /**
   * Thread id captured from the URL (`/agents/:id/chat/:threadId`). When
   * present, takes precedence over localStorage so a user landing via
   * a bookmark / share link / browser-back jumps directly to that
   * conversation. When absent, the hook falls back to its prior
   * behaviour: the persisted "last active" thread id, or a fresh UUID.
   * Thread switches inside the hook still update both: the URL via
   * `navigate(... { replace: false })` so the back button walks the
   * thread history, and localStorage so a tab close + reopen lands on
   * the same conversation.
   */
  readonly urlThreadId?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Short title used as a sidebar placeholder for a brand-new thread
 * before Mastra's LLM-generated title lands. Mirrors the backend's
 * `derivePreviewTitle` (60 chars, ellipsis) so the placeholder doesn't
 * visibly jump in length when the real title arrives.
 */
function derivePlaceholderTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return 'New conversation'
  return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useChat(input: UseChatInput): UseChatResult {
  const { agentId, urlThreadId } = input

  // Per-agent persistence. Mastra owns the message + thread storage
  // server-side; we only persist the *active* thread id locally so the
  // user lands on the same conversation after a reload. Messages
  // themselves are fetched from the backend on switch / mount.
  const [agentKey, setAgentKey] = useState<string | null>(agentId)
  // Source-of-truth precedence for the active thread:
  //   1. URL segment (`/agents/:id/chat/:threadId`) — passed in as
  //      `urlThreadId`. Wins so bookmarks / shared links / browser-back
  //      all land on the exact conversation.
  //   2. localStorage persisted "last active" — for cold mounts on the
  //      bare `/agents/:id/chat` URL.
  //   3. Fresh UUID — first-time visitors or wiped storage.
  const [threadId, setThreadId] = useState(
    () => urlThreadId ?? loadActiveThreadId(agentId) ?? crypto.randomUUID(),
  )
  // Track which URL we've already synced against so the "URL → state"
  // sync below can detect a genuine prop change (back/forward) without
  // looping with the state→URL push we do on user-triggered switches.
  const [urlSyncedFor, setUrlSyncedFor] = useState<string | undefined>(
    urlThreadId,
  )
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // `pendingNewThread` is true between clicking "New conversation"
  // and the first message of that conversation actually getting sent.
  // We mint a `threadId` immediately (everything downstream assumes
  // it's non-null) but defer the URL push: an unused thread id has no
  // server-side existence, so promoting it to a shareable URL is
  // misleading. `send()` flips this off and pushes the URL on the
  // first message.
  const [pendingNewThread, setPendingNewThread] = useState(false)
  const [threads, setThreads] = useState<ChatThreadMeta[]>([])
  // `threadsLoaded` flips true once `listAgentThreads` has resolved at
  // least once for this agent. The load-messages effect MUST wait on
  // this before deciding "no meta = empty thread" — without it, the
  // first render after a tab-switch remount sees `threads === []` (the
  // load-threads effect hasn't run yet), short-circuits, marks the
  // thread as "loaded," and never re-fetches when the real list arrives.
  // Symptom: sidebar shows the conversation highlighted but the
  // message area stays empty until the user manually re-selects.
  const [threadsLoaded, setThreadsLoaded] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [threadsError, setThreadsError] = useState<string | null>(null)
  // Tracks "we've loaded messages for this threadId" — see the
  // load-messages effect for why this is state instead of a ref. The
  // resume-on-mount probe runs INSIDE the same load effect (single
  // round-trip pair, single setState commit), so we don't need a
  // separate "resume checked for" pointer; this one gates both.
  const [messagesLoadedFor, setMessagesLoadedFor] = useState<string | null>(
    null,
  )

  // Sync state to the current agent using the canonical
  // setState-in-render "reset-on-prop-change" pattern: avoids the
  // single-frame flash you get if you reset inside an effect.
  if (agentKey !== agentId) {
    setAgentKey(agentId)
    setThreadId(urlThreadId ?? loadActiveThreadId(agentId) ?? crypto.randomUUID())
    setUrlSyncedFor(urlThreadId)
    setMessages([])
    setActiveRunId(null)
    setSending(false)
    setSendError(null)
    setThreads([])
    setThreadsLoaded(false)
    setLoadingMessages(false)
    setThreadsError(null)
    setMessagesLoadedFor(null)
    setPendingNewThread(false)
  } else if (urlThreadId !== urlSyncedFor) {
    // URL-driven thread switch: back / forward button changed the
    // `:threadId` segment without unmounting us. The same setState-in-
    // render pattern keeps us aligned. We don't push the URL again
    // here — the URL already IS the new value.
    setUrlSyncedFor(urlThreadId)
    if (urlThreadId && urlThreadId !== threadId) {
      setThreadId(urlThreadId)
      // Same hygiene as switchThread: drop the streaming state for the
      // previous thread so SSE re-subscribes against the new one.
      setMessages([])
      setActiveRunId(null)
      setSendError(null)
      // Force the load-messages effect to re-run for the new thread
      // (it gates on `messagesLoadedFor === threadId`).
      setMessagesLoadedFor(null)
    }
  }

  // Persist active thread id whenever it changes. Tiny key (no
  // message data), so this is cheap — no need to gate on `activeRunId`.
  // Skipped while `pendingNewThread` is true so we don't save a
  // freshly-minted id the user hasn't actually used: that would
  // resurface on the next visit and the URL-backfill effect would push
  // a self-describing URL for a thread that doesn't exist server-side.
  // `send()` flips `pendingNewThread` off before issuing the POST, and
  // because `pendingNewThread` is in the dep array this effect then
  // re-fires and persists.
  useEffect(() => {
    if (!agentId) return
    if (pendingNewThread) return
    persistActiveThreadId(agentId, threadId)
  }, [agentId, threadId, pendingNewThread])

  // Backfill the URL with the active thread id when the user landed on
  // the bare `/agents/:id/chat` path (no threadId in URL). Uses
  // `replace` so the bare URL doesn't pollute browser history — the
  // user didn't explicitly navigate to a threadless URL, they just
  // opened the chat tab. Skipped when `pendingNewThread` is true: the
  // user just clicked "New conversation" and the thread hasn't been
  // used yet — backfilling would publish a shareable URL for a thread
  // that doesn't exist server-side.
  //
  // Note: we deliberately do NOT setUrlSyncedFor here. After navigate
  // fires, the router emits a popstate-like change; the layout re-
  // renders with the new `urlThreadId` prop; the render-body
  // URL-driven sync block detects `urlThreadId !== urlSyncedFor` and
  // pulls the new value into state on the same render cycle. Doing
  // it inside this effect would be a synchronous setState-in-effect
  // (caught by the React 19 lint rule) AND would be redundant with
  // the render-body path.
  useEffect(() => {
    if (!agentId) return
    if (urlThreadId) return
    if (pendingNewThread) return
    if (typeof window === 'undefined') return
    const expected = `/agents/${agentId}/chat/${threadId}`
    if (window.location.pathname === expected) return
    if (!window.location.pathname.startsWith(`/agents/${agentId}/chat`)) return
    navigate(expected, { replace: true })
  }, [agentId, urlThreadId, threadId, pendingNewThread])

  const streamId = activeRunId ? runStreamId(activeRunId) : null
  const { connected, events, seqOffset } = useSSE(streamId, { cap: 4000 })

  // Track which events we've already folded into message state via
  // SEQUENCE (not array index). `lastSeqRef` is the highest event seq
  // we've processed; the next render finds unprocessed events by
  // sequence math against `seqOffset` from useSSE. Index-based tracking
  // (the prior implementation) silently dropped events whenever the
  // SSE buffer trimmed: the ref was pinned to a stale length and the
  // shifted-down array contents read as already-processed. The seq
  // pointer survives buffer trims because `seqOffset` advances in
  // lock-step with the eviction.
  //
  // Initial value -1 means "nothing processed yet" — the first frame
  // is seq 0, and `events[i].seq === seqOffset + i >= 0 > -1`, so it
  // gets picked up on first render.
  const lastSeqRef = useRef(-1)

  // Reset the processed pointer whenever the active run id changes —
  // the SSE hook resets its buffer (and its seqOffset) on streamId
  // change, so our tracking pointer also restarts.
  useEffect(() => {
    lastSeqRef.current = -1
  }, [activeRunId])

  useEffect(() => {
    if (!activeRunId) return
    // Find the first event index that's past our last-processed seq.
    // For events[i], seq = seqOffset + i, so unprocessed events live at
    // i >= lastSeq - seqOffset + 1. Clamp to 0 for the cold-start /
    // post-eviction case where lastSeq is below the current seqOffset
    // (we accept the eviction loss — that's the only sane signal we
    // can give for "you fell too far behind").
    const startIdx = Math.max(0, lastSeqRef.current - seqOffset + 1)
    if (startIdx >= events.length) return
    const slice = events.slice(startIdx)
    // Update the tracking pointer BEFORE the reducer runs so any
    // re-entrancy from the reducer doesn't double-process.
    lastSeqRef.current = seqOffset + events.length - 1

    setMessages((prev) => {
      let next = prev
      for (const ev of slice) {
        next = reduceEvent(next, ev, activeRunId)
      }
      return next === prev ? prev : next
    })

    // Inspect the slice for terminal events AFTER the state update so
    // the UI gets to render the final payload before the input unlocks.
    for (const ev of slice) {
      if (ev.kind === 'run.finished' || ev.kind === 'run.error') {
        // Give React one tick to flush the reducer, then release.
        // Using a microtask keeps this in the same event loop turn
        // for snappy UX but after the current render commits.
        queueMicrotask(() => setActiveRunId(null))
      }
    }
  }, [events, seqOffset, activeRunId])

  // Stuck-run watchdog. The SSE bus has no replay, and the dispatcher
  // flips `status='completed'` BEFORE publishing `run.finished` — so a
  // run that terminates between our `findActiveForThread` query and
  // the EventSource subscribe leaves `activeRunId` set on a drained
  // stream. UI gates (send / switch / newThread) freeze. Same shape
  // when a worker crashes and leaves `status='running'` orphaned.
  //
  // Poll `getActiveRunForThread` while `activeRunId` is set: 2s
  // initial catches the race, 8s recurring catches orphans. The
  // normal SSE clear cancels both via effect cleanup.
  useEffect(() => {
    if (!agentId) return
    if (!activeRunId) return
    let cancelled = false

    const recover = async () => {
      if (cancelled) return
      let active: { runId: string } | null
      try {
        active = await rpcGetActiveRunForThread(agentId, threadId)
      } catch {
        // Network blip; let the next tick retry.
        return
      }
      if (cancelled) return
      // Watched run is no longer active — clear the gates so the UI unfreezes.
      if (active && active.runId === activeRunId) return
      setActiveRunId(null)
      setMessages((prev) =>
        prev.map((m) =>
          m.runId === activeRunId && m.status === 'streaming'
            ? { ...m, status: 'done' }
            : m,
        ),
      )
    }

    const initial = window.setTimeout(recover, 2_000)
    const interval = window.setInterval(recover, 8_000)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [agentId, threadId, activeRunId])

  const resourceId = useMemo(
    () => (agentId ? `agent:${agentId}` : ''),
    [agentId],
  )

  const send = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim()
      if (!prompt) return
      if (!agentId) {
        setSendError('No agent focused')
        return
      }
      if (activeRunId || sending) return

      setSending(true)
      setSendError(null)

      // First message of a New conversation: promote the deferred
      // threadId to a real URL location now that it has a reason to
      // exist server-side. Push (not replace) so back returns to the
      // previous conversation. We do this BEFORE the POST so the URL
      // is consistent if the user reloads mid-send.
      //
      // Also seed an optimistic sidebar entry so the new thread shows
      // up immediately with a truncated-prompt placeholder. The real
      // entry (with the LLM-generated title) replaces it when
      // `refreshThreads()` fires after the run terminates. If the POST
      // fails, the catch block removes the optimistic entry so the
      // sidebar doesn't keep a ghost row.
      const isNewThread = pendingNewThread
      if (pendingNewThread) {
        setPendingNewThread(false)
        setUrlSyncedFor(threadId)
        navigate(`/agents/${agentId}/chat/${threadId}`)
        const now = Date.now()
        const optimistic: ChatThreadMeta = {
          threadId,
          title: derivePlaceholderTitle(prompt),
          createdAt: now,
          updatedAt: now,
          messageCount: 1,
        }
        setThreads((prev) => [
          optimistic,
          ...prev.filter((t) => t.threadId !== threadId),
        ])
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: Date.now(),
        text: prompt,
        status: 'done',
        toolCalls: [],
        steps: [],
        mcpLogs: [],
        lastTokenIndex: -1,
      }
      setMessages((prev) => [...prev, userMessage])

      try {
        const res = await callApi<{
          ok: true
          runId: string
          streamId: string
        }>(
          fetch(
            `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/runs`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt,
                threadId,
                resourceId,
              }),
            },
          ),
        )

        // Seed the placeholder assistant message — SSE frames fill it in.
        const assistant: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          createdAt: Date.now(),
          text: '',
          runId: res.runId,
          status: 'streaming',
          toolCalls: [],
          steps: [],
          mcpLogs: [],
          lastTokenIndex: -1,
        }
        setMessages((prev) => [...prev, assistant])
        setActiveRunId(res.runId)
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to start run'
        setSendError(message)
        // Surface the failure on the user message so the bubble isn't
        // orphaned without an assistant reply.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMessage.id
              ? { ...m, status: 'error', errorMessage: message }
              : m,
          ),
        )
        // Drop the optimistic sidebar entry — the backend never
        // accepted the run, so no Mastra thread row will exist on the
        // next refresh and a stray entry would be confusing.
        if (isNewThread) {
          setThreads((prev) => prev.filter((t) => t.threadId !== threadId))
        }
      } finally {
        setSending(false)
      }
    },
    [agentId, activeRunId, resourceId, sending, threadId, pendingNewThread],
  )

  // ─── Thread management ──────────────────────────────────────────

  const refreshThreads = useCallback(async () => {
    if (!agentId) return
    try {
      const list = await rpcListAgentThreads(agentId)
      setThreads(
        list.map((t) => ({
          threadId: t.threadId,
          title: t.title,
          createdAt: Date.parse(t.createdAt),
          updatedAt: Date.parse(t.updatedAt),
          messageCount: t.messageCount,
        })),
      )
      setThreadsLoaded(true)
      setThreadsError(null)
    } catch (err) {
      setThreadsError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load conversations',
      )
    }
  }, [agentId])

  // On mount / agent switch: load the thread list, then resolve which
  // thread to land on (saved active id if it still exists, else most
  // recent, else fresh new). Messages for that thread are loaded by
  // the next effect.
  //
  // No "did we initialise for this agentId yet" guard ref — that
  // pattern races against React 18 Strict Mode's double-mount in dev:
  // the first mount's cleanup sets `alive = false`, the second mount
  // skips because the ref is already set, and we end up with no
  // population. Instead we rely on the `[agentId]` dep + the `alive`
  // flag — Strict Mode's second pass refetches and wins. In prod
  // (single mount) it's a single fetch.
  useEffect(() => {
    if (!agentId) return
    let alive = true
    void (async () => {
      try {
        const list = await rpcListAgentThreads(agentId)
        if (!alive) return
        const mapped: ChatThreadMeta[] = list.map((t) => ({
          threadId: t.threadId,
          title: t.title,
          createdAt: Date.parse(t.createdAt),
          updatedAt: Date.parse(t.updatedAt),
          messageCount: t.messageCount,
        }))
        setThreads(mapped)
        setThreadsLoaded(true)
        // If the URL pinned a specific threadId, honour it absolutely
        // — bookmarks / shared links must land on what they say. Only
        // fall back to "saved or most recent" when the URL is bare.
        if (!urlThreadId) {
          const saved = loadActiveThreadId(agentId)
          const exists = saved && mapped.some((t) => t.threadId === saved)
          const nextActive = exists
            ? saved
            : mapped[0]?.threadId ?? threadId // keep current if list empty
          if (nextActive !== threadId) setThreadId(nextActive)
        }
      } catch (err) {
        if (alive) {
          setThreadsError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load conversations',
          )
        }
      }
    })()
    return () => {
      alive = false
    }
    // threadId is intentionally NOT in deps — we only want this to
    // run once per agent change. Re-fetches happen via refreshThreads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // Load messages for the active thread. Skipped while a run is
  // streaming (it's already filling `messages`) and when the thread
  // is brand-new with no backend record yet (no entry in `threads`).
  //
  // Tracks "last loaded for" via STATE (`messagesLoadedFor`, declared
  // with the other state at the top) not a ref — refs don't survive
  // React 18 Strict Mode's double-mount cycle.
  useEffect(() => {
    if (!agentId) return
    if (activeRunId) return
    if (messagesLoadedFor === threadId) return
    // CRITICAL: must wait for the threads list to resolve before
    // deciding "no meta = empty thread." Otherwise the first render
    // after a tab-switch remount sees `threads === []` (its loader
    // hasn't run yet), short-circuits, and never re-loads when the
    // real list arrives. Bug symptom: thread highlighted in sidebar
    // but message area stays empty until manual re-select.
    if (!threadsLoaded) return
    const meta = threads.find((t) => t.threadId === threadId)
    let alive = true
    void (async () => {
      if (alive) setLoadingMessages(true)
      try {
        // Probe both endpoints. When `meta` is missing we skip the
        // Mastra read (would 404 / return empty), saving a round trip;
        // the active-run probe carries `inputPrompt` so we can rebuild
        // the user bubble locally.
        const [list, active] = await Promise.all([
          meta ? rpcGetAgentThreadMessages(agentId, threadId) : Promise.resolve([] as const),
          rpcGetActiveRunForThread(agentId, threadId).catch(() => null),
        ])
        if (!alive) return
        // If neither side has anything (no Mastra row, no in-flight
        // run), the thread is genuinely empty — could be a fresh id
        // we minted but never sent on. Mark loaded and exit.
        if (!meta && !active) {
          setMessages([])
          setMessagesLoadedFor(threadId)
          return
        }
        const mapped: ChatMessage[] = list.map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          createdAt: Date.parse(m.createdAt),
          text: m.text,
          status: 'done',
          toolCalls: [],
          steps: [],
          mcpLogs: [],
          lastTokenIndex: -1,
        }))
        if (active) {
          // If Mastra hasn't persisted the user message yet (the
          // `!meta` path, or `meta` exists but `mapped` doesn't
          // contain the current run's prompt), synthesize the user
          // bubble from `runs.input_prompt`. Strip the callsite block
          // the dispatcher may have prepended so the bubble reads
          // cleanly.
          const cleanPrompt = stripCallsiteBlock(active.inputPrompt)
          const hasUserMsgForThisRun = mapped.some(
            (m) => m.role === 'user' && m.text.trim() === cleanPrompt.trim(),
          )
          if (!hasUserMsgForThisRun) {
            mapped.push({
              id: crypto.randomUUID(),
              role: 'user',
              createdAt: Date.parse(active.startedAt),
              text: cleanPrompt,
              status: 'done',
              toolCalls: [],
              steps: [],
              mcpLogs: [],
              lastTokenIndex: -1,
            })
          }
          mapped.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            createdAt: Date.now(),
            text: '',
            runId: active.runId,
            status: 'streaming',
            toolCalls: [],
            steps: [],
            mcpLogs: [],
            lastTokenIndex: -1,
          })
        }
        setMessages(mapped)
        setMessagesLoadedFor(threadId)
        if (active) {
          // Setting activeRunId triggers the existing SSE subscription
          // path (`streamId = runStreamId(activeRunId)`), so the in-
          // flight run's events start landing on the placeholder
          // immediately. The seq-based processing tracks them safely.
          setActiveRunId(active.runId)
        }
      } catch (err) {
        if (alive) {
          setSendError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load messages',
          )
        }
      } finally {
        if (alive) setLoadingMessages(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, threadId, threads, threadsLoaded, activeRunId, messagesLoadedFor])

  // After a run terminates, refresh the thread list — the new thread
  // (if it was first message of a fresh conversation) needs to show
  // up in the sidebar; existing threads need their `updatedAt` /
  // `messageCount` bumped. Also mark the active thread as
  // "loaded" so the load-messages effect (which watches `threads`)
  // doesn't immediately re-fetch and overwrite the just-streamed
  // messages with the simpler backend replay.
  //
  // The follow-up refreshes catch Mastra's `generateTitle` write,
  // which is fire-and-forget inside the agent run and frequently
  // lands AFTER `run.finished`. Two short retries cover the common
  // cases (sub-second titles on small models, multi-second on the
  // big ones) without polling forever. If the title already landed
  // on the first refresh, the follow-ups are cheap no-ops.
  const lastRunIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeRunId) {
      lastRunIdRef.current = activeRunId
      return
    }
    if (!lastRunIdRef.current) return
    lastRunIdRef.current = null
    setMessagesLoadedFor(threadId)
    void refreshThreads()
    const t1 = window.setTimeout(() => void refreshThreads(), 2500)
    const t2 = window.setTimeout(() => void refreshThreads(), 6000)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [activeRunId, refreshThreads, threadId])

  const newThread = useCallback(() => {
    if (activeRunId || sending) return
    if (!agentId) return
    // Mint the id locally so downstream state stays simple, but DO NOT
    // push the URL yet: an unused thread is not a real shareable
    // location. `send()` flips `pendingNewThread` off and writes the
    // URL on the first message. Until then, the URL is the bare
    // `/agents/:id/chat` and history is unaffected.
    const fresh = crypto.randomUUID()
    setThreadId(fresh)
    setUrlSyncedFor(undefined)
    setPendingNewThread(true)
    setMessages([])
    setSendError(null)
    // Mark fresh as "loaded" so the load-messages effect doesn't try
    // to fetch a thread that doesn't exist on the backend yet.
    setMessagesLoadedFor(fresh)
    // Push the user to the bare chat URL. Using push (not replace)
    // keeps the previous conversation in history so back returns to it.
    if (window.location.pathname !== `/agents/${agentId}/chat`) {
      navigate(`/agents/${agentId}/chat`)
    }
  }, [activeRunId, sending, agentId])

  const switchThread = useCallback(
    async (next: string): Promise<void> => {
      if (activeRunId || sending) return
      if (next === threadId) return
      if (!agentId) return
      setThreadId(next)
      setUrlSyncedFor(next)
      // Switching to an existing conversation cancels any pending
      // "new conversation" state. Bringing a real thread into focus
      // means the deferred URL push for the prior fresh id is no
      // longer relevant.
      setPendingNewThread(false)
      setMessages([])
      setSendError(null)
      // The load-messages effect will fire when threadId changes.
      navigate(`/agents/${agentId}/chat/${next}`)
    },
    [activeRunId, sending, threadId, agentId],
  )

  const deleteThread = useCallback(
    async (target: string): Promise<void> => {
      if (!agentId) return
      try {
        await rpcDeleteAgentThread(agentId, target)
      } catch (err) {
        setThreadsError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to delete conversation',
        )
        return
      }
      const remaining = threads.filter((t) => t.threadId !== target)
      setThreads(remaining)
      if (target === threadId) {
        const nextActive = remaining[0]?.threadId ?? crypto.randomUUID()
        setThreadId(nextActive)
        setUrlSyncedFor(nextActive)
        setMessages([])
        // If we fell back to a fresh new thread (no remaining), mark
        // it as loaded so the effect skips. Otherwise null so the
        // existing thread's messages get fetched.
        setMessagesLoadedFor(remaining.length > 0 ? null : nextActive)
        // Sync the URL so the deleted thread's path doesn't linger.
        navigate(`/agents/${agentId}/chat/${nextActive}`, { replace: true })
      }
    },
    [agentId, threads, threadId],
  )

  return {
    messages,
    threadId,
    resourceId,
    activeRunId,
    sending,
    sendError,
    sseConnected: connected,
    threads,
    loadingMessages,
    threadsError,
    send,
    newThread,
    switchThread,
    deleteThread,
    refreshThreads,
  }
}

// ─── Reducer ─────────────────────────────────────────────────────────────

function reduceEvent(
  messages: ChatMessage[],
  event: RunEvent,
  runId: string,
): ChatMessage[] {
  // Find the assistant message for this run. Linear scan is fine — we
  // expect conversations to be short (<100 turns) before the user hits
  // "New conversation", and only the last assistant bubble is being
  // updated anyway.
  const idx = lastAssistantIndex(messages, runId)
  if (idx === -1) return messages
  const target = messages[idx]
  if (!target) return messages

  const updated = applyEvent(target, event)
  if (updated === target) return messages
  const next = messages.slice()
  next[idx] = updated
  return next
}

function lastAssistantIndex(messages: ChatMessage[], runId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && m.runId === runId) return i
  }
  return -1
}

function applyEvent(msg: ChatMessage, event: RunEvent): ChatMessage {
  switch (event.kind) {
    case 'run.started':
      return applyRunStarted(msg, event.data as RunStartedPayload)
    case 'run.token':
      return applyToken(msg, event.data as RunTokenPayload)
    case 'run.token.batch':
      return applyTokenBatch(msg, event.data as RunTokenBatchPayload)
    case 'run.step.started':
      return applyStepStarted(msg, event.data as RunStepStartedPayload)
    case 'run.step.finished':
      return applyStepFinished(msg, event.data as RunStepFinishedPayload)
    case 'run.tool.called':
      return applyToolCalled(msg, event.data as RunToolCalledPayload, event.ts)
    case 'run.tool.result':
      return applyToolResult(msg, event.data as RunToolResultPayload, event.ts)
    case 'run.mcp.log':
      return applyMcpLog(msg, event.data as RunMcpLogPayload, event.ts)
    case 'run.error':
      return applyRunError(msg, event.data as RunErrorPayload)
    case 'run.finished':
      return applyRunFinished(msg, event.data as RunFinishedPayload)
    default:
      return msg
  }
}

function applyMcpLog(
  msg: ChatMessage,
  payload: RunMcpLogPayload,
  ts: number,
): ChatMessage {
  return {
    ...msg,
    mcpLogs: [
      ...msg.mcpLogs,
      {
        ts,
        connectionId: payload.connectionId,
        connectionName: payload.connectionName,
        level: payload.level,
        line: payload.line,
      },
    ],
  }
}

function applyRunStarted(
  msg: ChatMessage,
  payload: RunStartedPayload,
): ChatMessage {
  return {
    ...msg,
    providerKind: payload.providerKind,
    modelId: payload.modelId,
    agentName: payload.agentName,
    toolCount: payload.toolCount,
    gitnexusMounted: payload.gitnexusMounted,
  }
}

function applyToken(msg: ChatMessage, payload: RunTokenPayload): ChatMessage {
  // High-water dedupe. If the stream hiccups and skips an index we
  // still append — the gap will be filled by the next token.batch (if
  // one arrives) or left unrendered (the user sees a tiny gap, which
  // is less jarring than duplicated text).
  if (payload.index <= msg.lastTokenIndex) return msg
  return {
    ...msg,
    text: msg.text + payload.text,
    lastTokenIndex: payload.index,
  }
}

function applyTokenBatch(
  msg: ChatMessage,
  payload: RunTokenBatchPayload,
): ChatMessage {
  // Only useful on late-subscribe / reconnect. If the batch is
  // entirely in the past we drop it; if it extends past the
  // high-water mark we splice the tail.
  if (payload.endIndex <= msg.lastTokenIndex) return msg
  if (payload.startIndex > msg.lastTokenIndex + 1) {
    // A gap we can't reconstruct — append the batch verbatim and
    // advance the high-water mark. The missing tokens are lost for
    // display purposes; full transcript still lives in run_events.
    return {
      ...msg,
      text: msg.text + payload.text,
      lastTokenIndex: payload.endIndex,
    }
  }
  // `startIndex <= lastTokenIndex + 1 <= endIndex`. We already have
  // everything up to lastTokenIndex; append the slice strictly past it.
  // Since the batch payload is a single concatenated string we can't
  // cheaply slice by index — but because `startIndex ≤ lastIndex+1`
  // and we already rendered tokens 0..lastIndex, the overlap is 0 at
  // the most common boundary. Conservative fix: append the whole
  // batch text (duplicates are rare in the steady-state path and this
  // logic only fires on reconnect anyway).
  return {
    ...msg,
    text: msg.text + payload.text,
    lastTokenIndex: payload.endIndex,
  }
}

function applyStepStarted(
  msg: ChatMessage,
  payload: RunStepStartedPayload,
): ChatMessage {
  // Ignore duplicates (defensive against reconnect replay).
  if (msg.steps.some((s) => s.stepIndex === payload.stepIndex)) return msg
  const step: ChatStepInfo = {
    stepIndex: payload.stepIndex,
    messageId: payload.messageId,
    status: 'streaming',
  }
  return { ...msg, steps: [...msg.steps, step] }
}

function applyStepFinished(
  msg: ChatMessage,
  payload: RunStepFinishedPayload,
): ChatMessage {
  let replaced = false
  const steps = msg.steps.map((s) => {
    if (s.stepIndex !== payload.stepIndex) return s
    replaced = true
    return {
      ...s,
      status: 'done' as const,
      finishReason: payload.finishReason,
      ...(payload.usage ? { usage: payload.usage } : {}),
    }
  })
  // If the step-start arrived after step-finish (out of order) synth
  // one so the UI still reflects the step count.
  if (!replaced) {
    steps.push({
      stepIndex: payload.stepIndex,
      messageId: payload.messageId,
      status: 'done',
      finishReason: payload.finishReason,
      ...(payload.usage ? { usage: payload.usage } : {}),
    })
  }
  return { ...msg, steps }
}

function applyToolCalled(
  msg: ChatMessage,
  payload: RunToolCalledPayload,
  ts: number,
): ChatMessage {
  if (msg.toolCalls.some((t) => t.toolCallId === payload.toolCallId)) return msg
  const call: ChatToolInvocation = {
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    stepIndex: payload.stepIndex,
    input: payload.input,
    status: 'pending',
    startedAt: ts,
  }
  return { ...msg, toolCalls: [...msg.toolCalls, call] }
}

function applyToolResult(
  msg: ChatMessage,
  payload: RunToolResultPayload,
  ts: number,
): ChatMessage {
  let matched = false
  const toolCalls = msg.toolCalls.map((t) => {
    if (t.toolCallId !== payload.toolCallId) return t
    matched = true
    return {
      ...t,
      status: (payload.error ? 'error' : 'done') as 'error' | 'done',
      ...(payload.output !== undefined ? { output: payload.output } : {}),
      ...(payload.error ? { error: payload.error } : {}),
      finishedAt: ts,
    }
  })
  if (!matched) {
    // Result for a call we never saw start; still record it so the
    // user has visibility into what ran.
    toolCalls.push({
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      stepIndex: payload.stepIndex,
      input: null,
      status: payload.error ? 'error' : 'done',
      ...(payload.output !== undefined ? { output: payload.output } : {}),
      ...(payload.error ? { error: payload.error } : {}),
      startedAt: ts,
      finishedAt: ts,
    })
  }
  return { ...msg, toolCalls }
}

function applyRunError(msg: ChatMessage, payload: RunErrorPayload): ChatMessage {
  return {
    ...msg,
    status: 'error',
    errorKind: payload.kind,
    errorMessage: payload.message,
  }
}

function applyRunFinished(
  msg: ChatMessage,
  payload: RunFinishedPayload,
): ChatMessage {
  return {
    ...msg,
    status: 'done',
    finishReason: payload.finishReason,
    durationMs: payload.durationMs,
    ...(payload.usage ? { usage: payload.usage } : {}),
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────
//
// Local persistence is now intentionally minimal: just the active
// thread id per agent, so a reload lands the user back on the same
// conversation. Messages + thread metadata live on the backend
// (`mastra.threads` / `mastra.messages`). The pre-multi-thread version
// of this file mirrored every message into localStorage; that's gone
// — Mastra is the single source of truth now.

const STORAGE_PREFIX = 'ab.chat-active:'

function activeKey(agentId: string): string {
  return `${STORAGE_PREFIX}${agentId}`
}

function loadActiveThreadId(agentId: string | null): string | null {
  if (!agentId) return null
  try {
    const raw = localStorage.getItem(activeKey(agentId))
    if (!raw) return null
    return raw.length > 0 ? raw : null
  } catch {
    /* localStorage disabled / quota — ignore */
  }
  return null
}

function persistActiveThreadId(agentId: string, threadId: string): void {
  try {
    localStorage.setItem(activeKey(agentId), threadId)
  } catch {
    /* private mode / quota — best-effort */
  }
}
