/**
 * Chat dock. Renders when an agent is focused (`/agents/:id`) and the
 * split-on-focus layout reveals the right 40% of the main area.
 *
 * Three regions, stacked vertically:
 *   - Header: agent name + "New conversation" + connection status dot.
 *   - Scrolling message list: user bubbles and streaming assistant bubbles.
 *   - Composer: textarea with Enter-to-send, Shift+Enter for newline,
 *     send button is disabled while a run is streaming.
 *
 * Autoscroll behaviour: we stick to the bottom UNLESS the user has
 * scrolled up (inspecting a previous turn). New messages still land in
 * the DOM; a small "Jump to latest" affordance appears so the user can
 * catch back up. Keeps long conversations readable without hijacking
 * the scroll position while the user is reading.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import type { AgentResponse } from '@agent-bridge/shared'
import { useChat } from '../../../lib/use-chat'
import { ChatMessage } from '../chat-message'

import './index.css'

interface ChatPanelProps {
  readonly agent: AgentResponse
}

const SCROLL_STICK_THRESHOLD_PX = 72

export function ChatPanel({ agent }: ChatPanelProps) {
  const chat = useChat({ agentId: agent.id })

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [stickToBottom, setStickToBottom] = useState(true)

  // Track scroll position so we can auto-stick only when the user is
  // already at the bottom. Rechecking on every scroll is cheap — the
  // listener is passive.
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const onScroll = () => {
      const distance =
        node.scrollHeight - node.clientHeight - node.scrollTop
      setStickToBottom(distance < SCROLL_STICK_THRESHOLD_PX)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  // Pin to the bottom as new messages arrive; layout effect avoids a
  // perceptible jump between commit and paint.
  useLayoutEffect(() => {
    if (!stickToBottom) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [chat.messages, stickToBottom])

  const isStreaming = chat.activeRunId !== null
  const composerDisabled = isStreaming || chat.sending

  const agentHasProvider = agent.llmProviderId !== null

  const threadIdShort = useMemo(
    () => chat.threadId.slice(0, 8),
    [chat.threadId],
  )

  return (
    <div className="chat-panel">
      <header className="chat-panel-header">
        <div className="chat-panel-heading">
          <div className="chat-panel-title">{agent.name}</div>
          <div className="chat-panel-subtitle">
            <span className="chat-thread-pill" title={`thread ${chat.threadId}`}>
              <span className="chat-thread-dot" aria-hidden="true" />
              thread · <code>{threadIdShort}</code>
            </span>
            <span
              className={`chat-conn-dot${chat.sseConnected ? ' is-live' : ''}`}
              aria-hidden="true"
            />
            <span className="chat-panel-status">
              {isStreaming
                ? 'streaming…'
                : chat.sseConnected
                  ? 'live'
                  : 'idle'}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="chat-reset-btn"
          onClick={chat.resetThread}
          disabled={composerDisabled || chat.messages.length === 0}
          title="Start a new conversation — clears this window and allocates a fresh thread id"
        >
          New conversation
        </button>
      </header>

      <div className="chat-panel-scroll" ref={scrollRef}>
        {chat.messages.length === 0 ? (
          <EmptyChat agent={agent} hasProvider={agentHasProvider} />
        ) : (
          <div className="chat-message-list">
            {chat.messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} aria-hidden="true" />
          </div>
        )}
      </div>

      {!stickToBottom && chat.messages.length > 0 ? (
        <button
          type="button"
          className="chat-jump-latest"
          onClick={() => {
            setStickToBottom(true)
            bottomRef.current?.scrollIntoView({
              block: 'end',
              behavior: 'smooth',
            })
          }}
        >
          Jump to latest ↓
        </button>
      ) : null}

      <Composer
        disabled={composerDisabled}
        isStreaming={isStreaming}
        sendError={chat.sendError}
        hasProvider={agentHasProvider}
        onSend={chat.send}
      />
    </div>
  )
}

// ─── Empty state ────────────────────────────────────────────────────────

function EmptyChat({
  agent,
  hasProvider,
}: {
  agent: AgentResponse
  hasProvider: boolean
}) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-title">Talk to {agent.name}</div>
      <div className="chat-empty-hint">
        {hasProvider
          ? agent.memoryEnabled
            ? 'Messages thread within this conversation. Click “New conversation” to start fresh.'
            : 'Each message runs as a one-shot — memory is disabled for this agent.'
          : 'Attach an LLM provider to this agent before chatting.'}
      </div>
    </div>
  )
}

// ─── Composer ────────────────────────────────────────────────────────────

interface ComposerProps {
  readonly disabled: boolean
  readonly isStreaming: boolean
  readonly sendError: string | null
  readonly hasProvider: boolean
  readonly onSend: (prompt: string) => Promise<void>
}

function Composer({
  disabled,
  isStreaming,
  sendError,
  hasProvider,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Autogrow: recompute min(scrollHeight, max) on every value change.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
  }, [value])

  const submit = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    setValue('')
    await onSend(trimmed)
  }, [disabled, onSend, value])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void submit()
      }
    },
    [submit],
  )

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value),
    [],
  )

  const canSend = value.trim().length > 0 && !disabled && hasProvider

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {sendError ? (
        <div className="chat-composer-error" role="alert">
          {sendError}
        </div>
      ) : null}
      <div className="chat-composer-inner">
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          placeholder={
            hasProvider
              ? isStreaming
                ? 'Waiting for agent to finish…'
                : 'Ask something (Shift + Enter for a newline)'
              : 'Attach an LLM provider to chat'
          }
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={disabled || !hasProvider}
          rows={1}
          maxLength={16_000}
          aria-label="Message"
        />
        <button
          type="submit"
          className="chat-composer-send"
          disabled={!canSend}
          aria-label="Send"
          title="Send (Enter)"
        >
          {isStreaming ? (
            <span className="chat-composer-spinner" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">↵</span>
          )}
        </button>
      </div>
    </form>
  )
}
