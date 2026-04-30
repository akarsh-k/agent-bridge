/**
 * Chat tab — wired to the real run endpoint via the existing
 * `useChat` hook. Streams tokens as they arrive, surfaces tool
 * calls inline. Composer supports `@` mentions for the agent's
 * attached resources (repos / skills / tools / MCP tools).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useWorkspace } from '../../lib/workspace-context'
import { useChat, type ChatMessage } from '../../lib/use-chat'
import { Button } from '../../ui/button'
import { ArrowRightIcon, RefreshIcon, SearchIcon } from '../../ui/icons'
import { confirmDialog } from '../../ui/dialog-store'

interface MentionItem {
  kind: 'repo' | 'skill' | 'tool' | 'mcp'
  /** Display label. */
  label: string
  /** Token to insert in the prompt — replaces `@<query>`. */
  token: string
}

export function ChatTab({ agentId }: { agentId: string }) {
  const { agents, agentResources } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const chat = useChat({ agentId })
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const noProvider = !!agent && !agent.llmProviderId

  // Mention picker state — driven by the cursor position relative to
  // the most recent unbalanced `@`.
  const [mention, setMention] = useState<{
    query: string
    anchor: { top: number; left: number }
    activeIndex: number
  } | null>(null)

  // Mention catalog — flat list grouped by kind for the popover.
  const mentionItems = useMemo<MentionItem[]>(() => {
    const r = agentResources[agentId]
    if (!r) return []
    const out: MentionItem[] = []
    for (const repo of r.attachedRepos) {
      const name = repo.role || shortRepoName(repo.repo.remoteUrl)
      out.push({ kind: 'repo', label: name, token: `@repo:${name}` })
    }
    for (const s of r.skills) {
      out.push({ kind: 'skill', label: s.name, token: `@skill:${s.name}` })
    }
    for (const t of r.tools) {
      out.push({ kind: 'tool', label: t.name, token: `@tool:${t.name}` })
    }
    // Group MCP tools by connection — show one entry per allowed tool.
    for (const m of r.mcpAllowlist) {
      if (!m.enabled) continue
      out.push({
        kind: 'mcp',
        label: `${m.mcpConnectionName} · ${m.toolName}`,
        token: `@mcp:${m.toolName}`,
      })
    }
    return out
  }, [agentResources, agentId])

  const filteredMentions = useMemo(() => {
    if (!mention) return [] as MentionItem[]
    const q = mention.query.toLowerCase()
    if (!q) return mentionItems.slice(0, 12)
    return mentionItems
      .filter((m) => m.label.toLowerCase().includes(q))
      .slice(0, 12)
  }, [mention, mentionItems])

  // Auto-scroll to the bottom on new messages / streamed tokens.
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [chat.messages, chat.sending])

  const send = () => {
    const text = draft.trim()
    if (!text || chat.sending || chat.activeRunId) return
    setDraft('')
    setMention(null)
    void chat.send(text)
  }

  const handleDraftChange = (value: string) => {
    setDraft(value)
    updateMentionState(value, textareaRef.current)
  }

  const updateMentionState = (
    text: string,
    el: HTMLTextAreaElement | null,
  ) => {
    if (!el) {
      setMention(null)
      return
    }
    const cursor = el.selectionStart ?? text.length
    const upToCursor = text.slice(0, cursor)
    // Most recent `@` not preceded by a word char (so emails don't trigger).
    const match = upToCursor.match(/(?:^|\s)@([\w-]*)$/)
    if (!match) {
      setMention(null)
      return
    }
    const query = match[1] ?? ''
    const rect = el.getBoundingClientRect()
    setMention({
      query,
      anchor: { top: rect.top - 8, left: rect.left + 16 },
      activeIndex: 0,
    })
  }

  const insertMention = (item: MentionItem) => {
    const el = textareaRef.current
    if (!el) return
    const cursor = el.selectionStart ?? draft.length
    const before = draft.slice(0, cursor)
    const after = draft.slice(cursor)
    const replaced = before.replace(/@([\w-]*)$/, item.token + ' ')
    const next = replaced + after
    setDraft(next)
    setMention(null)
    queueMicrotask(() => {
      const pos = replaced.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention((m) =>
          m
            ? {
                ...m,
                activeIndex: (m.activeIndex + 1) % filteredMentions.length,
              }
            : m,
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention((m) =>
          m
            ? {
                ...m,
                activeIndex:
                  (m.activeIndex - 1 + filteredMentions.length) %
                  filteredMentions.length,
              }
            : m,
        )
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const pick = filteredMentions[mention.activeIndex]
        if (pick) insertMention(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // While the POST is in flight we don't yet have an assistant
  // placeholder bubble (useChat appends it after the response). Show a
  // transient "thinking" bubble so the user sees feedback immediately.
  const showThinkingBubble =
    chat.sending && chat.activeRunId === null && chat.messages.length > 0

  return (
    <div className="ab-chat-shell">
      <div className="ab-chat-main">
        <div className="ab-chat-thread" ref={threadRef}>
          {chat.messages.length === 0 ? (
            <div className="ab-msg ab-msg-bot">
              <div className="ab-msg-avatar is-bot">
                {(agent?.name ?? 'A').charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="ab-msg-bubble">
                  Hi — I'm {agent?.name ?? 'here'}. Ask me anything about the
                  resources I'm wired up with. Type{' '}
                  <code className="ab-mono">@</code> to reference a repo,
                  skill, tool, or MCP.
                </div>
              </div>
            </div>
          ) : (
            chat.messages.map((m) => (
              <MessageRow
                key={m.id}
                msg={m}
                agentInitial={(agent?.name ?? 'A').charAt(0).toUpperCase()}
              />
            ))
          )}

          {showThinkingBubble && (
            <div className="ab-msg ab-msg-bot">
              <div className="ab-msg-avatar is-bot">
                {(agent?.name ?? 'A').charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="ab-msg-bubble">
                  <ThinkingDots />
                </div>
              </div>
            </div>
          )}

          {chat.sendError && (
            <div
              className="ab-field-help"
              style={{
                color: 'var(--danger)',
                background: 'var(--danger-bg)',
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                border: '1px solid rgba(251, 113, 133, 0.24)',
              }}
              role="alert"
            >
              {chat.sendError}
            </div>
          )}
        </div>

        <div className="ab-chat-input-bar">
          <textarea
            ref={textareaRef}
            className="ab-chat-input"
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={() => updateMentionState(draft, textareaRef.current)}
            onBlur={() => {
              // Defer so click-on-popover still fires before close.
              setTimeout(() => setMention(null), 120)
            }}
            placeholder={
              noProvider
                ? 'No LLM provider assigned — configure on the Build tab.'
                : chat.activeRunId
                  ? 'Streaming…'
                  : `Ask ${agent?.name ?? 'the agent'} anything…  (type @ to mention)`
            }
            rows={1}
            disabled={
              chat.activeRunId !== null || chat.sending || noProvider
            }
          />
          <Button
            variant="ghost"
            onClick={async () => {
              if (chat.messages.length === 0) {
                chat.resetThread()
                return
              }
              const ok = await confirmDialog({
                title: 'Reset thread?',
                body: `Clears the ${chat.messages.length} message${
                  chat.messages.length === 1 ? '' : 's'
                } with ${agent?.name ?? 'this agent'} from this view. The agent's memory store keeps any persisted facts on the server.`,
                confirmLabel: 'Reset thread',
                kind: 'warning',
              })
              if (ok) chat.resetThread()
            }}
            leading={<RefreshIcon />}
            disabled={chat.activeRunId !== null || chat.messages.length === 0}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            onClick={send}
            disabled={
              !draft.trim() ||
              chat.sending ||
              chat.activeRunId !== null ||
              noProvider
            }
            trailing={<ArrowRightIcon strokeWidth={2.4} />}
          >
            Send
          </Button>
        </div>
      </div>

      {mention &&
        filteredMentions.length >= 0 &&
        createPortal(
          <div
            className="ab-mention-popover"
            style={{
              top: mention.anchor.top,
              left: mention.anchor.left,
              transform: 'translateY(-100%)',
            }}
            onMouseDown={(e) => e.preventDefault() /* keep textarea focused */}
          >
            {filteredMentions.length === 0 ? (
              <div className="ab-mention-empty">
                {mentionItems.length === 0
                  ? 'No resources attached. Visit the Build tab to attach repos, skills, tools, or MCPs.'
                  : 'No matches'}
              </div>
            ) : (
              <>
                <div className="ab-mention-group-label">Resources</div>
                {filteredMentions.map((item, i) => (
                  <button
                    key={`${item.kind}:${item.label}`}
                    type="button"
                    className={`ab-mention-item${
                      i === mention.activeIndex ? ' is-active' : ''
                    }`}
                    onMouseEnter={() =>
                      setMention((m) => (m ? { ...m, activeIndex: i } : m))
                    }
                    onClick={() => insertMention(item)}
                  >
                    <span className="ab-mention-item-name">{item.label}</span>
                    <span className="ab-mention-item-kind">{item.kind}</span>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

function ThinkingDots() {
  // Three pulsing dots to signal the request is in flight before the
  // real assistant bubble arrives. CSS-driven keyframe.
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 4,
        alignItems: 'center',
        height: 16,
        verticalAlign: 'middle',
      }}
      aria-label="Thinking"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--text-muted)',
            opacity: 0.3,
            animation: `ab-pulse 1.2s ${i * 200}ms infinite`,
          }}
        />
      ))}
    </span>
  )
}

function MessageRow({
  msg,
  agentInitial,
}: {
  msg: ChatMessage
  agentInitial: string
}) {
  return (
    <div className={`ab-msg ab-msg-${msg.role === 'user' ? 'user' : 'bot'}`}>
      <div
        className={`ab-msg-avatar ${msg.role === 'user' ? 'is-user' : 'is-bot'}`}
      >
        {msg.role === 'user' ? 'AK' : agentInitial}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.toolCalls.map((tc) => (
          <div className="ab-msg-tool" key={tc.toolCallId}>
            <div className="ab-msg-tool-head">
              <SearchIcon strokeWidth={2} />
              {tc.toolName}
              {tc.status === 'pending' && ' · running…'}
              {tc.status === 'error' && ' · error'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {compactJson(tc.input)}
              {tc.output !== undefined && (
                <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                  {compactJson(tc.output)}
                </div>
              )}
              {tc.error && (
                <div style={{ marginTop: 6, color: 'var(--danger)' }}>
                  {tc.error}
                </div>
              )}
            </div>
          </div>
        ))}
        {msg.text && (
          <div className="ab-msg-bubble" style={{ whiteSpace: 'pre-wrap' }}>
            {msg.role === 'user' ? renderUserText(msg.text) : msg.text}
            {msg.status === 'streaming' && (
              <span style={{ opacity: 0.5 }}> ▍</span>
            )}
          </div>
        )}
        {msg.role === 'assistant' &&
          msg.status === 'streaming' &&
          !msg.text &&
          msg.toolCalls.length === 0 && (
            <div className="ab-msg-bubble">
              <ThinkingDots />
            </div>
          )}
        {msg.errorMessage && (
          <div
            className="ab-msg-bubble"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid rgba(251, 113, 133, 0.24)',
              color: 'var(--danger)',
            }}
          >
            {msg.errorMessage}
          </div>
        )}
        <div className="ab-msg-meta">
          {formatTime(msg.createdAt)}
          {msg.durationMs !== undefined &&
            ` · ${(msg.durationMs / 1000).toFixed(1)}s`}
          {msg.toolCalls.length > 0 && ` · ${msg.toolCalls.length} tool calls`}
          {msg.usage && (
            <>
              {' · '}
              {msg.usage.inputTokens ?? '—'} in
              {' · '}
              {msg.usage.outputTokens ?? '—'} out
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Highlight `@thing:value` tokens inside user messages. */
function renderUserText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const re = /@(repo|skill|tool|mcp):([\w./:-]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <span key={`m${i++}`} className="ab-msg-mention">
        @{m[1]}:{m[2]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : text
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    if (!s) return ''
    return s.length > 240 ? s.slice(0, 237) + '…' : s
  } catch {
    return String(v)
  }
}
