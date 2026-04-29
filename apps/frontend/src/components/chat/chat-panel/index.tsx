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
import { useWorkspace } from '../../../lib/workspace-context'
import { ChatMessage } from '../chat-message'
import {
  applyMention,
  buildMentionItems,
  detectMentionTrigger,
  rankMentionItems,
  type MentionItem,
} from './mentions'

import './index.css'

interface ChatPanelProps {
  readonly agent: AgentResponse
}

const SCROLL_STICK_THRESHOLD_PX = 72

export function ChatPanel({ agent }: ChatPanelProps) {
  const chat = useChat({ agentId: agent.id })
  const workspace = useWorkspace()

  // Build the mention catalogue once per render of the agent's
  // resources. The hook walks skills + native tools + MCP allowlist +
  // other agents — see `mentions.ts` for the slug rules. When the agent
  // has no resources yet (still loading) we pass `[]` and the popover
  // just doesn't open.
  const mentionItems = useMemo<readonly MentionItem[]>(() => {
    const res = workspace.agentResources[agent.id]
    if (!res) return []
    return buildMentionItems({
      agentId: agent.id,
      skills: res.skills,
      tools: res.tools,
      mcpAllowlist: res.mcpAllowlist,
      mcpConnections: workspace.mcpConnections,
      agents: workspace.agents,
    })
  }, [
    agent.id,
    workspace.agentResources,
    workspace.mcpConnections,
    workspace.agents,
  ])

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
        mentionItems={mentionItems}
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
  readonly mentionItems: readonly MentionItem[]
  readonly onSend: (prompt: string) => Promise<void>
}

function Composer({
  disabled,
  isStreaming,
  sendError,
  hasProvider,
  mentionItems,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // Pairs with `mentionIndex` to reset the highlight whenever the
  // active query changes — the React 19 "reset state on prop change"
  // setState-in-render pattern.
  const [lastMentionQuery, setLastMentionQuery] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // We need to defer one render after splicing a mention so we can
  // restore the caret to the position right after the inserted token —
  // textarea selection is uncontrolled, so React doesn't manage it for us.
  const pendingCaretRef = useRef<number | null>(null)

  // Autogrow: recompute min(scrollHeight, max) on every value change.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
  }, [value])

  // Restore caret after a programmatic mention splice.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    const target = pendingCaretRef.current
    if (!ta || target === null) return
    ta.setSelectionRange(target, target)
    setCaret(target)
    pendingCaretRef.current = null
  }, [value])

  // ─── Mention state ─────────────────────────────────────────────────────
  const trigger = useMemo(
    () => detectMentionTrigger(value, caret),
    [value, caret],
  )
  const filteredMentions = useMemo(
    () =>
      trigger ? rankMentionItems(mentionItems, trigger.query) : [],
    [trigger, mentionItems],
  )
  const mentionOpen = trigger !== null && filteredMentions.length > 0

  // Reset the highlighted item whenever the active query changes — the
  // setState-in-render pattern keeps the highlight at index 0 for each
  // new keystroke without scheduling an effect (no cascading renders).
  const currentQuery = trigger?.query ?? null
  if (currentQuery !== lastMentionQuery) {
    setLastMentionQuery(currentQuery)
    setMentionIndex(0)
  }

  const insertMention = useCallback(
    (item: MentionItem) => {
      if (!trigger) return
      const { nextValue, nextCaret } = applyMention(value, trigger, item)
      pendingCaretRef.current = nextCaret
      setValue(nextValue)
    },
    [trigger, value],
  )

  const submit = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    setValue('')
    await onSend(trimmed)
  }, [disabled, onSend, value])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMentionIndex((i) => (i + 1) % filteredMentions.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMentionIndex(
            (i) =>
              (i - 1 + filteredMentions.length) % filteredMentions.length,
          )
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const item = filteredMentions[mentionIndex]
          if (item) {
            e.preventDefault()
            insertMention(item)
            return
          }
        }
        if (e.key === 'Escape') {
          // Close by collapsing the popover — easiest path is to nudge
          // the caret left of the `@`. Cheaper: emit a synthetic
          // selection update through a no-op state nudge so
          // `detectMentionTrigger` re-runs and returns null. We just
          // bump caret to start of the @ sign so it's no longer trailing
          // any query chars.
          if (trigger) {
            e.preventDefault()
            pendingCaretRef.current = trigger.start
            // Force a re-render — the caret-restore effect will re-evaluate.
            setValue((v) => v)
          }
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void submit()
      }
    },
    [
      mentionOpen,
      filteredMentions,
      mentionIndex,
      insertMention,
      trigger,
      submit,
    ],
  )

  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    setCaret(e.target.selectionStart ?? e.target.value.length)
  }, [])

  const onSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = e.currentTarget
      setCaret(target.selectionStart ?? target.value.length)
    },
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
                : 'Ask something (Shift + Enter for a newline, @ to mention)'
              : 'Attach an LLM provider to chat'
          }
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onClick={onSelect}
          disabled={disabled || !hasProvider}
          rows={1}
          maxLength={16_000}
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={mentionOpen}
          aria-controls={mentionOpen ? 'chat-mention-popover' : undefined}
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
      {mentionOpen ? (
        <MentionPopover
          items={filteredMentions}
          activeIndex={mentionIndex}
          onHover={setMentionIndex}
          onPick={insertMention}
        />
      ) : null}
    </form>
  )
}

// ─── Mention popover ────────────────────────────────────────────────────

interface MentionPopoverProps {
  readonly items: readonly MentionItem[]
  readonly activeIndex: number
  readonly onHover: (index: number) => void
  readonly onPick: (item: MentionItem) => void
}

function MentionPopover({
  items,
  activeIndex,
  onHover,
  onPick,
}: MentionPopoverProps) {
  return (
    <ul
      id="chat-mention-popover"
      className="chat-mention-popover"
      role="listbox"
      aria-label="Mention suggestions"
    >
      {items.map((item, i) => (
        <li
          key={`${item.kind}:${item.token}`}
          className={`chat-mention-item${i === activeIndex ? ' is-active' : ''}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            // Prevent textarea blur — without this the click steals focus
            // and the popover closes before our onPick fires.
            e.preventDefault()
            onPick(item)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className={`chat-mention-kind chat-mention-kind-${item.kind}`}>
            {item.kind}
          </span>
          <span className="chat-mention-label">{item.label}</span>
          <span className="chat-mention-hint">{item.hint}</span>
        </li>
      ))}
    </ul>
  )
}
