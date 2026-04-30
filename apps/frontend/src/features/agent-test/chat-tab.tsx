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
import { Markdown } from '../../ui/markdown'
import {
  ArrowRightIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from '../../ui/icons'
import type { ChatThreadMeta } from '../../lib/use-chat'

interface MentionItem {
  kind: 'repo' | 'skill' | 'tool' | 'mcp'
  /** Display label. */
  label: string
  /** Token to insert in the prompt — replaces `@<query>`. */
  token: string
}

const KIND_GROUP_LABEL: Record<MentionItem['kind'], string> = {
  repo: 'Repos',
  skill: 'Skills',
  tool: 'Tools',
  mcp: 'MCP tools',
}

const KIND_CHIP_GLYPH: Record<MentionItem['kind'], string> = {
  repo: 'R',
  skill: 'S',
  tool: 'T',
  mcp: 'M',
}

export function ChatTab({ agentId }: { agentId: string }) {
  const { agents, agentResources } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const chat = useChat({ agentId })
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionPopoverRef = useRef<HTMLDivElement | null>(null)
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

  // Sort the catalog by kind (repo → skill → tool → mcp) so the flat
  // index that drives keyboard navigation matches the visual order
  // when grouped into sections in the popover.
  const KIND_ORDER: Record<MentionItem['kind'], number> = {
    repo: 0,
    skill: 1,
    tool: 2,
    mcp: 3,
  }
  const filteredMentions = useMemo(() => {
    if (!mention) return [] as MentionItem[]
    const q = mention.query.toLowerCase()
    // Match against kind label too — typing `@tool` should surface
    // every tool-kind item even if "tool" doesn't appear in the
    // resource's name. Same for "repo", "skill", "mcp".
    const matched = q
      ? mentionItems.filter((m) => {
          const haystack = `${m.kind} ${KIND_GROUP_LABEL[m.kind].toLowerCase()} ${m.label.toLowerCase()}`
          return haystack.includes(q)
        })
      : mentionItems
    return matched
      .slice()
      .sort((a, b) => {
        const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
        return k !== 0 ? k : a.label.localeCompare(b.label)
      })
      .slice(0, 16)
    // KIND_ORDER is a stable literal — safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention, mentionItems])

  // Group filtered items by kind for rendering. Each item carries its
  // flat index so the active-row highlight + click handler line up
  // with what the keyboard navigation tracks.
  const mentionGroups = useMemo(() => {
    const out: Array<{
      kind: MentionItem['kind']
      label: string
      items: Array<{ item: MentionItem; flatIndex: number }>
    }> = []
    filteredMentions.forEach((item, flatIndex) => {
      const last = out[out.length - 1]
      if (last && last.kind === item.kind) {
        last.items.push({ item, flatIndex })
      } else {
        out.push({
          kind: item.kind,
          label: KIND_GROUP_LABEL[item.kind],
          items: [{ item, flatIndex }],
        })
      }
    })
    return out
  }, [filteredMentions])

  // Auto-scroll to the bottom on new messages / streamed tokens.
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [chat.messages, chat.sending])

  // Keep the active mention row visible when the user arrow-keys past
  // the popover's max-height. Querying by the .is-active class keeps
  // this independent of the rendered structure (groups, headers, etc.).
  useEffect(() => {
    if (!mention) return
    const popover = mentionPopoverRef.current
    if (!popover) return
    const activeEl = popover.querySelector<HTMLElement>(
      '.ab-mention-item.is-active',
    )
    activeEl?.scrollIntoView({ block: 'nearest' })
  }, [mention])

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
      <div className="ab-chat-with-threads">
      <ThreadRail
        threads={chat.threads}
        activeThreadId={chat.threadId}
        onNew={() => chat.newThread()}
        onSwitch={(id) => void chat.switchThread(id)}
        onDelete={(id) => void chat.deleteThread(id)}
        error={chat.threadsError}
        disabled={chat.activeRunId !== null || chat.sending}
      />
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
                mentionTokens={mentionItems.map((mi) => mi.token)}
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
          <div className="ab-chat-input-pill">
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
                  ? 'No LLM provider assigned — configure on the Configure tab.'
                  : chat.activeRunId
                    ? 'Streaming…'
                    : `Ask ${agent?.name ?? 'the agent'} anything…  (type @ to mention)`
              }
              rows={1}
              disabled={
                chat.activeRunId !== null || chat.sending || noProvider
              }
            />
            <div className="ab-chat-input-actions">
              <button
                type="button"
                className="ab-chat-input-icon-btn"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => chat.newThread()}
                disabled={
                  chat.activeRunId !== null || chat.messages.length === 0
                }
              >
                <RefreshIcon />
              </button>
              <button
                type="button"
                className="ab-chat-input-send"
                aria-label="Send"
                onClick={send}
                disabled={
                  !draft.trim() ||
                  chat.sending ||
                  chat.activeRunId !== null ||
                  noProvider
                }
              >
                <ArrowRightIcon strokeWidth={2.4} />
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>

      {mention &&
        filteredMentions.length >= 0 &&
        createPortal(
          <div
            ref={mentionPopoverRef}
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
                  ? 'No resources attached. Visit the Resources tab to attach repos, skills, tools, or MCPs.'
                  : `No matches for "${mention.query}"`}
              </div>
            ) : (
              <>
                {mentionGroups.map((group) => (
                  <div className="ab-mention-group" key={group.kind}>
                    <div className="ab-mention-group-label">
                      <span>{group.label}</span>
                      <span className="ab-mention-group-count">
                        {group.items.length}
                      </span>
                    </div>
                    {group.items.map(({ item, flatIndex }) => {
                      const active = flatIndex === mention.activeIndex
                      return (
                        <button
                          key={`${item.kind}:${item.label}`}
                          type="button"
                          className={`ab-mention-item${active ? ' is-active' : ''}`}
                          onMouseEnter={() =>
                            setMention((m) =>
                              m ? { ...m, activeIndex: flatIndex } : m,
                            )
                          }
                          onClick={() => insertMention(item)}
                        >
                          <span
                            className={`ab-mention-kind-chip is-${item.kind}`}
                            aria-hidden="true"
                          >
                            {KIND_CHIP_GLYPH[item.kind]}
                          </span>
                          <span className="ab-mention-item-body">
                            <span className="ab-mention-item-name">
                              {renderMatch(item.label, mention.query)}
                            </span>
                            <span className="ab-mention-item-token">
                              {item.token}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
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
  mentionTokens,
}: {
  msg: ChatMessage
  agentInitial: string
  mentionTokens: ReadonlyArray<string>
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
        {msg.text &&
          (msg.role === 'user' ? (
            <div
              className="ab-msg-bubble"
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {renderUserText(msg.text, mentionTokens)}
              {msg.status === 'streaming' && (
                <span style={{ opacity: 0.5 }}> ▍</span>
              )}
            </div>
          ) : (
            <div className="ab-msg-bubble ab-msg-bubble-md">
              <Markdown source={msg.text} />
              {msg.status === 'streaming' && (
                <span style={{ opacity: 0.5 }}> ▍</span>
              )}
            </div>
          ))}
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

/** Highlight `@thing:value` tokens inside user messages.
 *
 * Matches against a live catalog of known tokens (sorted longest-first
 * so a `@skill:Code Review` token wins over `@skill:Code`) so a
 * resource name with spaces stays one pill. Falls back to a strict
 * regex (`[\w./:-]+` value class) for tokens that don't appear in
 * the catalog — e.g., a message replayed from history whose skill
 * has since been renamed. */
function renderUserText(
  text: string,
  knownTokens: ReadonlyArray<string>,
): React.ReactNode {
  // Sort longest-first so `@skill:Code` doesn't mask `@skill:Code Review`.
  const sortedTokens = [...knownTokens].sort((a, b) => b.length - a.length)
  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < text.length) {
    if (text[i] === '@') {
      // 1) Try the live catalog first — handles spaces in names.
      const hit = sortedTokens.find(
        (t) => t.length > 0 && text.startsWith(t, i),
      )
      if (hit) {
        parts.push(
          <span key={`m${key++}`} className="ab-msg-mention">
            {hit}
          </span>,
        )
        i += hit.length
        continue
      }
      // 2) Fallback: strict-regex token (no spaces) for replayed
      //    messages whose catalog item no longer exists.
      const tail = text.slice(i)
      const m = tail.match(/^@(repo|skill|tool|mcp):([\w./:-]+)/)
      if (m) {
        parts.push(
          <span key={`m${key++}`} className="ab-msg-mention">
            {m[0]}
          </span>,
        )
        i += m[0].length
        continue
      }
    }
    // Coalesce a run of plain text into one string node.
    let j = i + 1
    while (j < text.length && text[j] !== '@') j++
    parts.push(text.slice(i, j))
    i = j
  }
  return parts.length > 0 ? parts : text
}

/** Highlight the typed query inside a label — case-insensitive match. */
function renderMatch(label: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return label
  const lower = label.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx === -1) return label
  return (
    <>
      {label.slice(0, idx)}
      <span className="ab-mention-item-match">
        {label.slice(idx, idx + q.length)}
      </span>
      {label.slice(idx + q.length)}
    </>
  )
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

function ThreadRail({
  threads,
  activeThreadId,
  onNew,
  onSwitch,
  onDelete,
  error,
  disabled,
}: {
  threads: readonly ChatThreadMeta[]
  activeThreadId: string
  onNew: () => void
  onSwitch: (threadId: string) => void
  onDelete: (threadId: string) => void
  error: string | null
  disabled: boolean
}) {
  return (
    <aside className="ab-thread-rail" aria-label="Conversations">
      <div className="ab-thread-rail-head">
        <span>Conversations</span>
        <span>{threads.length}</span>
      </div>
      <button
        type="button"
        className="ab-thread-rail-new"
        onClick={onNew}
        disabled={disabled}
      >
        <PlusIcon strokeWidth={2.4} />
        New conversation
      </button>
      {error && <div className="ab-thread-rail-error">{error}</div>}
      {threads.length === 0 && !error && (
        <div className="ab-thread-rail-empty">
          No past conversations yet. Send a message to start one.
        </div>
      )}
      {threads.map((t) => (
        <button
          type="button"
          key={t.threadId}
          className={`ab-thread-row${t.threadId === activeThreadId ? ' is-active' : ''}`}
          onClick={() => onSwitch(t.threadId)}
          disabled={disabled && t.threadId !== activeThreadId}
        >
          <span className="ab-thread-row-title">
            {t.title ?? 'Untitled'}
          </span>
          <span className="ab-thread-row-meta">
            {t.messageCount} msg · {formatRelativeShort(t.updatedAt)}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="ab-thread-row-delete"
            aria-label="Delete conversation"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(t.threadId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onDelete(t.threadId)
              }
            }}
          >
            <TrashIcon />
          </span>
        </button>
      ))}
    </aside>
  )
}

function formatRelativeShort(ts: number): string {
  if (Number.isNaN(ts)) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'now'
  const m = Math.floor(delta / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}
