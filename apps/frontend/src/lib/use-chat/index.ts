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
 *     localStorage in this phase. Phase 3g adds DB-backed replay once
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
import { runStreamId } from '@agent-bridge/shared'
import {
  ApiError,
  apiBaseUrl,
  callApi,
  deleteAgentThread as rpcDeleteAgentThread,
  getAgentThreadMessages as rpcGetAgentThreadMessages,
  listAgentThreads as rpcListAgentThreads,
} from '../rpc'
import { useSSE } from '../use-sse'

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
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useChat(input: UseChatInput): UseChatResult {
  const { agentId } = input

  // Per-agent persistence. Mastra owns the message + thread storage
  // server-side; we only persist the *active* thread id locally so the
  // user lands on the same conversation after a reload. Messages
  // themselves are fetched from the backend on switch / mount.
  const [agentKey, setAgentKey] = useState<string | null>(agentId)
  const [threadId, setThreadId] = useState(
    () => loadActiveThreadId(agentId) ?? crypto.randomUUID(),
  )
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [threads, setThreads] = useState<ChatThreadMeta[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [threadsError, setThreadsError] = useState<string | null>(null)
  // Tracks "we've loaded messages for this threadId" — see the
  // load-messages effect for why this is state instead of a ref.
  const [messagesLoadedFor, setMessagesLoadedFor] = useState<string | null>(
    null,
  )

  // Sync state to the current agent using the canonical
  // setState-in-render "reset-on-prop-change" pattern: avoids the
  // single-frame flash you get if you reset inside an effect.
  if (agentKey !== agentId) {
    setAgentKey(agentId)
    setThreadId(loadActiveThreadId(agentId) ?? crypto.randomUUID())
    setMessages([])
    setActiveRunId(null)
    setSending(false)
    setSendError(null)
    setThreads([])
    setLoadingMessages(false)
    setThreadsError(null)
    setMessagesLoadedFor(null)
  }

  // Persist active thread id whenever it changes. Tiny key (no
  // message data), so this is cheap — no need to gate on `activeRunId`.
  useEffect(() => {
    if (!agentId) return
    persistActiveThreadId(agentId, threadId)
  }, [agentId, threadId])

  const streamId = activeRunId ? runStreamId(activeRunId) : null
  const { connected, events } = useSSE(streamId, { cap: 600 })

  // Track which events we've already folded into message state. The
  // SSE hook's `events` buffer is append-only but can be truncated; we
  // process the tail since `processedCount`. Using a ref (not state)
  // so the effect can update it without re-running.
  const processedCountRef = useRef(0)

  // Reset the processed pointer whenever the active run id changes —
  // the SSE hook replaces its buffer on `streamId` change, so the tail
  // logic restarts from zero.
  useEffect(() => {
    processedCountRef.current = 0
  }, [activeRunId])

  useEffect(() => {
    if (!activeRunId) return
    const start = processedCountRef.current
    if (events.length <= start) return
    const slice = events.slice(start)
    processedCountRef.current = events.length

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
  }, [events, activeRunId])

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
      } finally {
        setSending(false)
      }
    },
    [agentId, activeRunId, resourceId, sending, threadId],
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
        const saved = loadActiveThreadId(agentId)
        const exists = saved && mapped.some((t) => t.threadId === saved)
        const nextActive = exists
          ? saved
          : mapped[0]?.threadId ?? threadId // keep current if list empty
        if (nextActive !== threadId) setThreadId(nextActive)
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
    const meta = threads.find((t) => t.threadId === threadId)
    // Brand-new thread (no server record) → nothing to fetch. The
    // `newThread()` / `switchThread()` actions already cleared messages
    // synchronously before changing `threadId`, so we return without
    // touching state here (avoids react-hooks/set-state-in-effect).
    if (!meta) return
    let alive = true
    void (async () => {
      // Flip loading inside the microtask so the lint rule sees the
      // setState as part of the async work, not a synchronous side
      // effect of mounting the effect.
      if (alive) setLoadingMessages(true)
      try {
        const list = await rpcGetAgentThreadMessages(agentId, threadId)
        if (!alive) return
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
        setMessages(mapped)
        setMessagesLoadedFor(threadId)
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
  }, [agentId, threadId, threads, activeRunId, messagesLoadedFor])

  // After a run terminates, refresh the thread list — the new thread
  // (if it was first message of a fresh conversation) needs to show
  // up in the sidebar; existing threads need their `updatedAt` /
  // `messageCount` bumped. Also mark the active thread as
  // "loaded" so the load-messages effect (which watches `threads`)
  // doesn't immediately re-fetch and overwrite the just-streamed
  // messages with the simpler backend replay.
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
  }, [activeRunId, refreshThreads, threadId])

  const newThread = useCallback(() => {
    if (activeRunId || sending) return
    const fresh = crypto.randomUUID()
    setThreadId(fresh)
    setMessages([])
    setSendError(null)
    // Mark fresh as "loaded" so the load-messages effect doesn't try
    // to fetch a thread that doesn't exist on the backend yet.
    setMessagesLoadedFor(fresh)
  }, [activeRunId, sending])

  const switchThread = useCallback(
    async (next: string): Promise<void> => {
      if (activeRunId || sending) return
      if (next === threadId) return
      setThreadId(next)
      setMessages([])
      setSendError(null)
      // The load-messages effect will fire when threadId changes.
    },
    [activeRunId, sending, threadId],
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
        setMessages([])
        // If we fell back to a fresh new thread (no remaining), mark
        // it as loaded so the effect skips. Otherwise null so the
        // existing thread's messages get fetched.
        setMessagesLoadedFor(remaining.length > 0 ? null : nextActive)
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
