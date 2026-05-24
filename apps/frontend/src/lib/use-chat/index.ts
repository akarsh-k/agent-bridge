/**
 * Chat state machine for one agent.
 *
 * Owns:
 *   - The list of rendered messages (user bubbles + streaming assistant bubbles).
 *   - The current `threadId` / `resourceId` passed to every POST
 *     /api/agents/:id/runs. Regenerating the thread (via `resetThread`)
 *     starts a new conversation; memory-enabled agents will stop seeing
 *     previous turns in their context.
 *   - A per-thread map of SSE subscriptions. Multiple runs can stream
 *     concurrently across different threads (one run per thread, but
 *     many threads in parallel). The composer for a thread stays
 *     disabled until THAT thread's run reaches a terminal state
 *     (`run.finished` or `run.error`). Switching to another thread is
 *     always allowed — the off-screen run keeps streaming into its
 *     own slot of `messagesByThread`.
 *
 * Does NOT own:
 *   - Rendering (that's `<ChatPanel />` and friends).
 *   - Persistence. Messages are in-memory per agent. When the user
 *     switches agents we swap the whole state; nothing is pushed to
 *     localStorage in this phase. DB-backed replay will be added once
 *     `runs.mastra_thread_id` columns exist.
 *
 * SSE plumbing notes:
 *   - One EventSource per entry in `activeRunByThread`. The manager
 *     reconciles the open-subscriptions Map against that state each
 *     time it changes — adds new EventSources, closes ones whose
 *     thread+run no longer has an entry. Each handler captures its
 *     `threadId` + `runId` in closure so events route into the right
 *     thread's slot of `messagesByThread`, regardless of which thread
 *     is focused. See `docs/multi-thread-streaming.md` for the why.
 *   - Terminal events (`run.finished`, `run.error`) come via SSE only
 *     (not via the POST response). The reducer flips the assistant
 *     message to its final state; a microtask then removes the entry
 *     from `activeRunByThread`, which closes the EventSource on the
 *     next reconcile pass.
 *   - Token dedupe is a high-water mark: on `run.token` append if
 *     `index > lastIndex`; on `run.token.batch` fill in the tail if the
 *     batch covers indices past `lastIndex`. The batch path matters
 *     when the EventSource subscribes mid-run.
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
import {
  runEventKinds,
  runEventSchema,
  runStreamId,
  stripPromptEnrichments,
} from '@agent-bridge/shared'
import {
  ApiError,
  apiBaseUrl,
  callApi,
  deleteAgentThread as rpcDeleteAgentThread,
  getActiveRunForThread as rpcGetActiveRunForThread,
  getAgentThreadMessages as rpcGetAgentThreadMessages,
  listAgentThreads as rpcListAgentThreads,
} from '../rpc'
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
  /**
   * Names of knowledge files the user explicitly referenced via
   * `@`-mention this turn. Resolved client-side at send-time. The
   * chat UI renders a "Filtered to: X, Y" pill above the user
   * message so the operator sees the scope was honored. Only set on
   * user-role messages.
   */
  readonly referencedFileNames?: ReadonlyArray<string>
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
  /** Thread ids that currently have a streaming run. Multi-SSE keeps
   *  off-screen runs subscribed, so this set persists across
   *  navigation — `ThreadRail` uses it (together with `unreadThreadIds`)
   *  to decide whether the per-row dot should pulse or stay static. */
  readonly streamingThreadIds: ReadonlySet<string>
  /** Thread ids that have unviewed activity — a run started or
   *  completed on the thread while the user was elsewhere. Cleared
   *  on visit. In-memory only; resets on page reload. */
  readonly unreadThreadIds: ReadonlySet<string>
  /** True while fetching messages on a thread switch. */
  readonly loadingMessages: boolean
  /** True while a thread fetch failed (so the UI can show a retry). */
  readonly threadsError: string | null
  send(
    prompt: string,
    options?: {
      referencedFileIds?: ReadonlyArray<string>
      referencedFileNames?: ReadonlyArray<string>
    },
  ): Promise<void>
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

// Stable empty array — returned from the per-thread accessor when a
// thread has no entry in `messagesByThread`. A literal `[]` would
// be a fresh reference every render and pop dep-array equality for
// downstream effects / memos.
const EMPTY_MESSAGES: ChatMessage[] = []

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
  // Per-thread state shape so off-screen threads' streaming bubbles
  // keep accumulating tokens when the operator navigates away. See
  // `docs/multi-thread-streaming.md` for the why; in short, a single
  // `messages` array was wiped on every thread switch and the
  // streaming SSE was detached, so coming back to a still-streaming
  // run meant losing whatever the model had emitted in the gap.
  //
  // Consumer-facing `messages` / `activeRunId` are derived for the
  // focused thread further down — ChatTab's API doesn't change.
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, ChatMessage[]>
  >({})
  const [activeRunByThread, setActiveRunByThread] = useState<
    Record<string, string>
  >({})
  // Per-thread "unread" marker — set when a run starts on a thread
  // the user isn't focused on (i.e., they didn't see it start), and
  // cleared when they visit that thread. In-memory only; resets on
  // page reload. Drives the blue dot on sidebar rows.
  const [unreadThreadIds, setUnreadThreadIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  // Diff snapshot used by the watchdog effect (declared near the
  // bottom of the hook) to detect runs starting / terminating
  // between renders. Hoisted up here so the render-body agent-reset
  // path can clear it without referencing a not-yet-declared ref.
  const prevActiveRunsRef = useRef<Record<string, string>>({})
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

  // ── Per-thread state accessors ──────────────────────────────────
  // These mirror the old single-state API but are scoped to a
  // particular threadId. Callers either pass an explicit `tid` (used
  // when the SSE handler captures the streaming run's thread in its
  // closure) or rely on the focused-thread derivations below.
  const messages = messagesByThread[threadId] ?? EMPTY_MESSAGES
  const activeRunId = activeRunByThread[threadId] ?? null

  const setMessagesFor = useCallback(
    (
      tid: string,
      updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
    ) => {
      setMessagesByThread((prev) => {
        const cur = prev[tid] ?? EMPTY_MESSAGES
        const next =
          typeof updater === 'function'
            ? (updater as (p: ChatMessage[]) => ChatMessage[])(cur)
            : updater
        if (next === cur) return prev
        return { ...prev, [tid]: next }
      })
    },
    [],
  )

  const setActiveRunFor = useCallback(
    (tid: string, runId: string | null) => {
      setActiveRunByThread((prev) => {
        const cur = prev[tid] ?? null
        if (cur === runId) return prev
        if (runId === null) {
          if (!(tid in prev)) return prev
          const next = { ...prev }
          delete next[tid]
          return next
        }
        return { ...prev, [tid]: runId }
      })
    },
    [],
  )

  // Sync state to the current agent using the canonical
  // setState-in-render "reset-on-prop-change" pattern: avoids the
  // single-frame flash you get if you reset inside an effect.
  if (agentKey !== agentId) {
    setAgentKey(agentId)
    setThreadId(urlThreadId ?? loadActiveThreadId(agentId) ?? crypto.randomUUID())
    setUrlSyncedFor(urlThreadId)
    // Per-agent state — when the focused agent changes, drop ALL
    // per-thread streaming + message caches. (Agent change implies
    // the old runs are unreachable anyway.)
    setMessagesByThread({})
    setActiveRunByThread({})
    setUnreadThreadIds(new Set())
    // Reset the watchdog's diff snapshot too — otherwise it sees the
    // old agent's entries as "removals" on first render after switch
    // and fires a spurious refreshThreads + three title-catch-up
    // timeouts for the new agent.
    prevActiveRunsRef.current = {}
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
    //
    // Note: we deliberately DO NOT clear messagesByThread or
    // activeRunByThread for the prior thread. Off-screen threads keep
    // their state so streaming bubbles stay continuous when the
    // operator navigates back. The SSE manager keeps its EventSource
    // open for any thread that still has an entry in
    // `activeRunByThread`.
    setUrlSyncedFor(urlThreadId)
    if (urlThreadId && urlThreadId !== threadId) {
      setThreadId(urlThreadId)
      setSendError(null)
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

  // ── Multi-stream SSE manager ────────────────────────────────────
  // One EventSource per (threadId, runId) entry in
  // `activeRunByThread`. Each subscription's handler captures its
  // own tid + rid in closure so events route to the right thread's
  // messages, regardless of which thread is currently focused. This
  // is what lets streaming bubbles on off-screen threads keep
  // accumulating tokens.
  //
  // Connection state (just the focused thread's) is exposed as
  // `sseConnected` for parity with the prior API.
  type SubEntry = {
    source: EventSource
    threadId: string
    runId: string
    connected: boolean
  }
  const subsRef = useRef<Map<string, SubEntry>>(new Map())
  const [focusedConnected, setFocusedConnected] = useState(false)
  // Mirror of `threadId` readable from inside long-lived SSE handler
  // closures. The handlers compare their captured `tid` against this
  // to decide whether to update `focusedConnected`, so a thread
  // switch doesn't leave them stuck on the old focused thread.
  const focusedThreadRef = useRef(threadId)
  useEffect(() => {
    focusedThreadRef.current = threadId
  }, [threadId])

  // Clear the unread mark when the user focuses a thread. Set-based
  // membership check first to skip the setState (and re-render) for
  // the common "switch to a thread that wasn't unread" case.
  useEffect(() => {
    setUnreadThreadIds((prev) => {
      if (!prev.has(threadId)) return prev
      const next = new Set(prev)
      next.delete(threadId)
      return next
    })
  }, [threadId])

  useEffect(() => {
    const subs = subsRef.current
    const desired = new Map<string, { threadId: string; runId: string }>()
    for (const [tid, rid] of Object.entries(activeRunByThread)) {
      desired.set(`${tid}::${rid}`, { threadId: tid, runId: rid })
    }

    // Open any new subscriptions.
    for (const [key, { threadId: tid, runId: rid }] of desired) {
      if (subs.has(key)) continue
      const url = `${apiBaseUrl}/api/events/${encodeURIComponent(runStreamId(rid))}`
      const source = new EventSource(url)
      const entry: SubEntry = {
        source,
        threadId: tid,
        runId: rid,
        connected: false,
      }
      subs.set(key, entry)

      const dispatch = (raw: string) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return
        }
        const result = runEventSchema.safeParse(parsed)
        if (!result.success) return
        const event = result.data
        setMessagesFor(tid, (prev) => reduceEvent(prev, event, rid))
        if (event.kind === 'run.finished' || event.kind === 'run.error') {
          // Microtask so the reducer commit lands before the gate
          // unlocks on the focused thread (matches old behavior).
          queueMicrotask(() => setActiveRunFor(tid, null))
        }
      }
      source.onopen = () => {
        entry.connected = true
        if (tid === focusedThreadRef.current) setFocusedConnected(true)
      }
      source.onerror = () => {
        entry.connected = false
        if (tid === focusedThreadRef.current) setFocusedConnected(false)
      }
      for (const kind of runEventKinds) {
        source.addEventListener(kind, (ev: MessageEvent) =>
          dispatch(ev.data as string),
        )
      }
      source.addEventListener('message', (ev: MessageEvent) =>
        dispatch(ev.data as string),
      )
    }

    // Close any subscriptions that are no longer desired.
    for (const [key, sub] of subs.entries()) {
      if (!desired.has(key)) {
        sub.source.close()
        subs.delete(key)
        if (sub.threadId === focusedThreadRef.current) {
          setFocusedConnected(false)
        }
      }
    }
    // No cleanup-on-deps-change — we explicitly reconcile each run.
    // Unmount-only cleanup lives in the dedicated effect below.
  }, [activeRunByThread, setMessagesFor, setActiveRunFor])

  // When the focused thread changes, surface that thread's current
  // connection status to consumers (the SSE itself doesn't restart).
  useEffect(() => {
    const subs = subsRef.current
    const focused = subs.get(
      activeRunId ? `${threadId}::${activeRunId}` : '',
    )
    setFocusedConnected(focused?.connected ?? false)
  }, [threadId, activeRunId])

  // Unmount cleanup: close every open EventSource so nothing leaks
  // when ChatTab unmounts (tab switch away from the agent).
  useEffect(() => {
    const subs = subsRef.current
    return () => {
      for (const sub of subs.values()) sub.source.close()
      subs.clear()
    }
  }, [])

  // Stuck-run watchdog. The SSE bus has no replay, and the dispatcher
  // flips `status='completed'` BEFORE publishing `run.finished` — so a
  // run that terminates between our `findActiveForThread` query and
  // the EventSource subscribe leaves the per-thread `activeRunByThread`
  // entry set on a drained stream. That keeps the composer for THAT
  // thread disabled (send is still gated per-thread). Same shape
  // when a worker crashes and leaves `status='running'` orphaned.
  //
  // Polls `getActiveRunForThread` for the focused thread while it has
  // an entry in `activeRunByThread`: 2s initial catches the race, 8s
  // recurring catches orphans. Off-screen recovery: not needed — the
  // multi-SSE handler sees the terminal event from its EventSource.
  //
  // Grace window: the route inserts the runs row with
  // `mastraThreadId=null`; the dispatcher only stamps it inside
  // `setMastraThread` AFTER `buildAgent` resolves memory config.
  // `findActiveForThread` filters by exact `mastraThreadId` match,
  // so during the dispatcher's startup window it returns null even
  // though the run is alive. Without a grace window the 2s probe
  // false-positives every fresh send, prematurely flipping the
  // streaming placeholder to `done` and showing "(no text response)"
  // before the LLM has emitted a single token. 15s is generous
  // enough for the slowest local agent build to settle.
  const RECOVERY_GRACE_MS = 15_000
  const activeRunStartedAtRef = useRef<number>(0)
  useEffect(() => {
    if (activeRunId) activeRunStartedAtRef.current = Date.now()
  }, [activeRunId])

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
      // Dispatcher-startup grace: a null result this early in the run's
      // life almost certainly means the dispatcher hasn't stamped
      // `mastraThreadId` yet, not that the run actually finished. Let
      // the next interval tick re-check after the dispatcher catches up.
      if (
        !active &&
        Date.now() - activeRunStartedAtRef.current < RECOVERY_GRACE_MS
      ) {
        return
      }
      setActiveRunFor(threadId, null)
      setMessagesFor(threadId, (prev) =>
        prev.map((m) =>
          m.runId === activeRunId && m.status === 'streaming'
            ? { ...m, status: 'done' }
            : m,
        ),
      )
      // SSE-race recovery: when the watchdog fires it almost always
      // means the EventSource missed the run's `run.token` / `.batch`
      // events (Redis pub/sub doesn't buffer, and the dispatcher can
      // race the client's subscribe on fast runs). The bubble's
      // accumulated `text` is empty, but Mastra has the persisted
      // assistant message. Invalidate `messagesLoadedFor` so the
      // load-messages effect re-runs and pulls the real text — without
      // this the bubble renders as just a timestamp until the operator
      // refreshes the page. Order matters: setActiveRunFor(null) above
      // removes the per-thread entry first, so the load-messages
      // effect's `if (activeRunId) return` gate (derived from the
      // map) is open by the time it re-evaluates.
      setMessagesLoadedFor(null)
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
    async (
      rawPrompt: string,
      options?: {
        referencedFileIds?: ReadonlyArray<string>
        referencedFileNames?: ReadonlyArray<string>
      },
    ) => {
      const prompt = rawPrompt.trim()
      if (!prompt) return
      if (!agentId) {
        setSendError('No agent focused')
        return
      }
      if (activeRunId || sending) return
      const referencedFileIds = options?.referencedFileIds ?? []
      const referencedFileNames = options?.referencedFileNames ?? []

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
        ...(referencedFileNames.length > 0
          ? { referencedFileNames }
          : {}),
      }
      setMessagesFor(threadId, (prev) => [...prev, userMessage])

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
                ...(referencedFileIds.length > 0
                  ? { referencedFileIds }
                  : {}),
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
        setMessagesFor(threadId, (prev) => [...prev, assistant])
        setActiveRunFor(threadId, res.runId)
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
        setMessagesFor(threadId, (prev) =>
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

  // Load messages for the focused thread. Skipped when the focused
  // thread already has an active SSE run (its `messagesByThread`
  // slot is being live-filled by the SSE manager — refetching would
  // clobber the in-progress text) and when the thread is brand-new
  // with no backend record yet (no entry in `threads`). Off-screen
  // threads load lazily — the next switch to one triggers this
  // effect via the `threadId` dep.
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
          setMessagesFor(threadId, EMPTY_MESSAGES)
          setMessagesLoadedFor(threadId)
          return
        }
        const mapped: ChatMessage[] = list.map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          createdAt: Date.parse(m.createdAt),
          // Strip server-injected enrichments from user messages so a
          // refreshed thread doesn't surface the callsite line + the
          // pre-fetch passages + the attached-files note as part of
          // the user's bubble. Mastra persists the FULL prompt the LLM
          // saw (enrichments included); we only want the operator's
          // own text in the bubble. Assistant messages skip this — they
          // never carry enrichments.
          text:
            m.role === 'user' ? stripPromptEnrichments(m.text) : m.text,
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
          const cleanPrompt = stripPromptEnrichments(active.inputPrompt)
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
        setMessagesFor(threadId, (prev) => reconcileLoaded(prev, mapped))
        setMessagesLoadedFor(threadId)
        if (active) {
          // Putting an entry in `activeRunByThread` triggers the
          // multi-SSE manager to open an EventSource for this thread's
          // run. The handler routes events into `messagesByThread[tid]`
          // via the reducer.
          setActiveRunFor(threadId, active.runId)
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
  // Watchdog: fires on any thread's run termination (focused or
  // off-screen). Triggers `refreshThreads` so Mastra's
  // generateTitle catch-up lands in the sidebar. Tracks the
  // previous `activeRunByThread` via ref to detect removals.
  //
  // `threadId` is read via `focusedThreadRef` rather than being a
  // dep, so a thread switch within the 6s catch-up window doesn't
  // re-run the effect and tear down the title-refresh timeouts
  // before they fire. (Mastra's generateTitle frequently lands a
  // few seconds AFTER `run.finished`; losing the retries means the
  // sidebar sticks on the truncated-prompt placeholder.)
  //
  // Note: `prevActiveRunsRef` is declared up top (near state) so the
  // render-body agent-reset path can clear it.
  useEffect(() => {
    const prev = prevActiveRunsRef.current
    const cur = activeRunByThread
    const added: string[] = []
    const removed: string[] = []
    for (const tid of Object.keys(cur)) {
      if (!(tid in prev)) added.push(tid)
    }
    for (const tid of Object.keys(prev)) {
      if (!(tid in cur)) removed.push(tid)
    }
    prevActiveRunsRef.current = { ...cur }
    // Mark unread: a run starting on a non-focused thread means the
    // user wasn't there when it began, so they have "new content"
    // waiting. A run starting on the focused thread is something
    // they're watching live — no unread flag needed.
    const focused = focusedThreadRef.current
    const newlyUnread = added.filter((tid) => tid !== focused)
    if (newlyUnread.length > 0) {
      setUnreadThreadIds((prev) => {
        const next = new Set(prev)
        for (const tid of newlyUnread) next.add(tid)
        return next
      })
    }
    if (removed.length === 0) return
    void refreshThreads()
    // Catch-up retries for Mastra's generateTitle write, which is
    // fire-and-forget inside the agent run and frequently lands
    // AFTER `run.finished`. Range covers small models (sub-second)
    // through to large models (10-20s). switchThread also triggers
    // a refresh, so navigation in the sidebar is an additional
    // event-driven catch.
    const t1 = window.setTimeout(() => void refreshThreads(), 3000)
    const t2 = window.setTimeout(() => void refreshThreads(), 10000)
    const t3 = window.setTimeout(() => void refreshThreads(), 25000)
    // When the focused thread's run terminates, INVALIDATE
    // `messagesLoadedFor` so load-messages refetches the canonical
    // text from Mastra. Protects against SSE-missed-events: if the
    // local SSE handler dropped token events (Redis race on subscribe,
    // network blip), the in-memory bubble would otherwise lock in a
    // truncated version forever.
    //
    // Delayed by 250ms so Mastra has a window to commit the assistant
    // message before we refetch. Mastra persistence is normally
    // synchronous-before-publish, but under load / large memory stores
    // the publish can land ahead of the commit; without the delay the
    // refetch can return a list that doesn't yet contain the new
    // assistant, briefly blanking the bubble. `reconcileLoaded`
    // (load-messages) also guards against this by preferring `prev`
    // when mapped is shorter, but the delay turns the rare "Mastra
    // slow" case into a no-op instead of a brief flicker.
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined
    if (removed.includes(focused)) {
      invalidateTimer = window.setTimeout(
        () => setMessagesLoadedFor(null),
        250,
      )
    }
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
      if (invalidateTimer !== undefined) {
        window.clearTimeout(invalidateTimer)
      }
    }
  }, [activeRunByThread, refreshThreads])

  const newThread = useCallback(() => {
    // Same policy as switchThread: only block during the brief send
    // POST. A streaming run on the prior thread keeps going server-
    // side and stays in `activeRunByThread`; its SSE continues to
    // accumulate tokens into that thread's slot of `messagesByThread`.
    if (sending) return
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
    // Seed the fresh thread's slot to [] so the focused-thread
    // accessor reads it as empty (not undefined → fallback array).
    setMessagesFor(fresh, EMPTY_MESSAGES)
    setSendError(null)
    // Mark fresh as "loaded" so the load-messages effect doesn't try
    // to fetch a thread that doesn't exist on the backend yet.
    setMessagesLoadedFor(fresh)
    // Push the user to the bare chat URL. Using push (not replace)
    // keeps the previous conversation in history so back returns to it.
    if (window.location.pathname !== `/agents/${agentId}/chat`) {
      navigate(`/agents/${agentId}/chat`)
    }
  }, [sending, agentId, setMessagesFor])

  const switchThread = useCallback(
    async (next: string): Promise<void> => {
      // `sending` is the brief window during the send POST — blocking
      // it prevents a half-applied optimistic UI. We do NOT block on
      // streaming runs: their SSE keeps running in the background and
      // their messages stay in `messagesByThread` so coming back to a
      // streaming conversation shows the in-progress bubble.
      if (sending) return
      if (next === threadId) return
      if (!agentId) return
      // Event-driven sidebar refresh: every thread navigation is a
      // cheap, accurate signal that the operator wants up-to-date
      // metadata. Catches LLM-generated titles that landed AFTER the
      // watchdog's 6s catch-up window (common with slow models). The
      // list endpoint is fast; doing this on every switch beats
      // sizing arbitrary timeouts.
      void refreshThreads()
      setThreadId(next)
      setUrlSyncedFor(next)
      // Switching to an existing conversation cancels any pending
      // "new conversation" state. Bringing a real thread into focus
      // means the deferred URL push for the prior fresh id is no
      // longer relevant.
      setPendingNewThread(false)
      setSendError(null)
      // The load-messages effect will fire when threadId changes —
      // gated by the per-thread `activeRunByThread` entry so a
      // streaming thread we return to doesn't get clobbered.
      navigate(`/agents/${agentId}/chat/${next}`)
    },
    [sending, threadId, agentId, refreshThreads],
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
      // Drop the deleted thread from per-thread state. The SSE manager
      // will reconcile and close any open EventSource for it on the
      // next effect tick. (Server-side run is orphaned if there is
      // one — a pre-existing limitation.)
      setMessagesByThread((prev) => {
        if (!(target in prev)) return prev
        const next = { ...prev }
        delete next[target]
        return next
      })
      setActiveRunByThread((prev) => {
        if (!(target in prev)) return prev
        const next = { ...prev }
        delete next[target]
        return next
      })
      setUnreadThreadIds((prev) => {
        if (!prev.has(target)) return prev
        const next = new Set(prev)
        next.delete(target)
        return next
      })
      if (target === threadId) {
        const nextActive = remaining[0]?.threadId ?? crypto.randomUUID()
        setThreadId(nextActive)
        setUrlSyncedFor(nextActive)
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

  // Stable identity for the public set: same reference between
  // renders when the underlying keys don't change, so consumers'
  // memoized children don't re-render unnecessarily.
  const streamingThreadIds = useMemo(
    () => new Set(Object.keys(activeRunByThread)),
    [activeRunByThread],
  )

  // Sort sidebar entries by `createdAt` DESC so an existing
  // conversation doesn't jump to the top every time it gets a new
  // message. New conversations (most recent `createdAt`) still
  // appear at the top by virtue of their creation timestamp.
  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => b.createdAt - a.createdAt),
    [threads],
  )

  return {
    messages,
    threadId,
    resourceId,
    activeRunId,
    sending,
    sendError,
    sseConnected: focusedConnected,
    threads: sortedThreads,
    loadingMessages,
    threadsError,
    streamingThreadIds,
    unreadThreadIds,
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

/**
 * Reconcile a freshly-loaded mapped list (canonical, from Mastra)
 * with whatever is currently in memory. Two jobs:
 *
 *   1. Preserve message ids when the role / position align so React
 *      doesn't re-key the bubble and trigger a remount flicker. The
 *      streamed placeholder uses `crypto.randomUUID()`; Mastra has its
 *      own ids — without this step the swap would unmount/remount
 *      every bubble on every refetch.
 *   2. Keep an in-memory message that Mastra hasn't persisted yet.
 *      Mastra persistence is normally synchronous-before-publish, but
 *      under load or with large memory stores the publish can land
 *      first. If `prev` has more messages than `mapped`, keep `prev`
 *      verbatim — the next refetch (title-catch-up timeout or
 *      subsequent navigation) will pick up Mastra's version once it
 *      catches up.
 */
function reconcileLoaded(
  prev: ChatMessage[],
  mapped: ChatMessage[],
): ChatMessage[] {
  if (mapped.length < prev.length) return prev
  if (mapped.length === 0) return mapped
  // Same length — try to preserve ids position-by-position when role
  // matches. Conservative: if any role mismatches, fall back to
  // mapped verbatim (cheaper than over-complicating the diff).
  if (mapped.length === prev.length) {
    let allRolesMatch = true
    for (let i = 0; i < mapped.length; i++) {
      if (mapped[i]!.role !== prev[i]!.role) {
        allRolesMatch = false
        break
      }
    }
    if (allRolesMatch) {
      return mapped.map((m, i) => ({ ...m, id: prev[i]!.id }))
    }
  }
  return mapped
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
