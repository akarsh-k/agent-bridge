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
  FileIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from '../../ui/icons'
import { Button } from '../../ui/button'
import { toast } from '../../ui/toast-store'
import { ApiError, discoverMcpTools, pollMcpTest } from '../../lib/rpc'
import type { ChatThreadMeta } from '../../lib/use-chat'

interface MentionItem {
  kind: 'repo' | 'skill' | 'tool' | 'mcp' | 'file'
  /** Display label. */
  label: string
  /** Token to insert in the prompt — replaces `@<query>`. */
  token: string
  /** For file mentions: the underlying file id. Used by the send
   *  handler to pull `referencedFileIds` out of the draft text. */
  fileId?: string
}

const KIND_GROUP_LABEL: Record<MentionItem['kind'], string> = {
  repo: 'Repos',
  skill: 'Skills',
  tool: 'Tools',
  mcp: 'MCP tools',
  file: 'Files',
}

const KIND_CHIP_GLYPH: Record<MentionItem['kind'], string> = {
  repo: 'R',
  skill: 'S',
  tool: 'T',
  mcp: 'M',
  file: 'F',
}

export function ChatTab({
  agentId,
  initialThreadId,
}: {
  agentId: string
  initialThreadId?: string
}) {
  const { agents, agentResources } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const chat = useChat({ agentId, urlThreadId: initialThreadId })
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
    // Knowledge files. Token is the readable `@<filename>` form (no
    // `@file:<uuid>` prefix) so the composer and rendered bubble both
    // show the same human-friendly text. Send-time extraction matches
    // tokens against this catalog (longest-first) to recover fileIds
    // without ever exposing uuids in the textarea.
    for (const af of r.attachedFiles) {
      out.push({
        kind: 'file',
        label: af.file.name,
        token: `@${af.file.name}`,
        fileId: af.file.id,
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
    file: 4,
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

  // Chat-scope file upload. Default behavior: file is persisted to
  // Library AND attached to this thread (`ephemeral=false`). The
  // operator opts out via Library → delete; we deliberately don't
  // expose an ephemeral toggle in the composer yet — it's a minor
  // power-user feature that adds UI clutter for the 95% case.
  const { uploadFile, refreshFile } = useWorkspace()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [fileUploading, setFileUploading] = useState(false)
  const onPickFile = (): void => {
    fileInputRef.current?.click()
  }
  const onFileChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await runFileUpload(file)
  }
  const runFileUpload = async (file: File): Promise<void> => {
    setFileUploading(true)
    try {
      const result = await uploadFile({
        file,
        threadId: chat.threadId,
        ephemeral: false,
      })
      if (result.duplicate) {
        toast.info(
          `"${result.file.name}" already in Library — attached to this chat.`,
        )
      } else {
        toast.success(`Uploaded "${result.file.name}"`)
      }
      void refreshFile(result.file.id)
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Upload failed',
      )
    } finally {
      setFileUploading(false)
    }
  }

  const send = () => {
    const text = draft.trim()
    if (!text || chat.sending || chat.activeRunId) return
    // Extract `@<filename>` mentions from the draft so the backend can
    // clamp `search_knowledge` to that scope. We walk the catalog of
    // attached files sorted by name LENGTH DESCENDING, so a longer
    // filename ("vendor-agreement-2024.pdf") wins over a shorter one
    // that's a substring ("vendor.pdf"). Each match strips its token
    // from a scratch copy of the text before the next check, so the
    // shorter prefix doesn't double-count when both are present.
    const fileMentions = mentionItems
      .filter(
        (m): m is MentionItem & { fileId: string } =>
          m.kind === 'file' && !!m.fileId,
      )
      .slice()
      .sort((a, b) => b.token.length - a.token.length)
    const seenIds = new Set<string>()
    const referencedFileIds: string[] = []
    const referencedFileNames: string[] = []
    let scan = text
    for (const f of fileMentions) {
      if (!scan.includes(f.token)) continue
      if (!seenIds.has(f.fileId)) {
        seenIds.add(f.fileId)
        referencedFileIds.push(f.fileId)
        referencedFileNames.push(f.label)
      }
      scan = scan.split(f.token).join('')
    }
    setDraft('')
    setMention(null)
    void chat.send(
      text,
      referencedFileIds.length > 0
        ? { referencedFileIds, referencedFileNames }
        : undefined,
    )
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
        streamingThreadIds={chat.streamingThreadIds}
        unreadThreadIds={chat.unreadThreadIds}
        onNew={() => chat.newThread()}
        onSwitch={(id) => void chat.switchThread(id)}
        onDelete={(id) => void chat.deleteThread(id)}
        error={chat.threadsError}
        disabled={chat.sending}
      />
      <div className="ab-chat-main">
        {agent && !agent.memoryEnabled && (
          <div
            role="note"
            style={{
              padding: '8px 14px',
              fontSize: 12,
              color: 'var(--text-muted)',
              background: 'var(--surface-hi)',
              borderBottom: '1px solid var(--border)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--text)' }}>Memory is off.</strong>{' '}
            This conversation won't be saved after you leave or navigate
            away. Turn on memory in the Memory tab to keep history across
            sessions.
          </div>
        )}
        <div className="ab-chat-thread" ref={threadRef}>
          {chat.messages.length === 0 ? (
            // Suppress the greeting while the load-messages effect is in
            // flight or a resumed run is still streaming. Without this
            // gate the empty `messages: []` window flashes the greeting
            // bubble alongside a highlighted thread row in the sidebar,
            // which reads as "two conversations active." Loading state
            // owns the brief in-between; the greeting is reserved for
            // genuine "no conversation yet."
            chat.loadingMessages || chat.activeRunId ? null : (
              <div className="ab-msg ab-msg-bot">
                <div className="ab-msg-avatar is-bot">
                  {(agent?.name ?? 'A').charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="ab-msg-bubble">
                    Hi — I'm {agent?.name ?? 'here'}. Ask me anything about
                    the resources I'm wired up with. Type{' '}
                    <code className="ab-mono">@</code> to reference a repo,
                    skill, tool, or MCP.
                  </div>
                </div>
              </div>
            )
          ) : (
            chat.messages.map((m) => (
              <MessageRow
                key={m.id}
                msg={m}
                agentInitial={(agent?.name ?? 'A').charAt(0).toUpperCase()}
                mentionItems={mentionItems}
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
                border: '1px solid var(--danger-border)',
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
                aria-label="Attach file"
                title="Attach file (.md, .txt, .pdf)"
                onClick={onPickFile}
                disabled={chat.activeRunId !== null || fileUploading}
              >
                <FileIcon />
              </button>
              <button
                type="button"
                className="ab-chat-input-icon-btn"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => chat.newThread()}
                disabled={chat.messages.length === 0}
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
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.pdf,text/plain,text/markdown,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => void onFileChosen(e)}
            />
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
  mentionItems,
}: {
  msg: ChatMessage
  agentInitial: string
  /** Full catalog of @-mention items the agent knows about — used to
   *  match readable tokens (`@vendor.pdf`, `@skill:Code Review`) in
   *  the message text and wrap them as styled chips. Catalog-driven
   *  matching also handles names with spaces, which a strict regex
   *  would split. */
  mentionItems: ReadonlyArray<MentionItem>
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
            <JsonBlock value={tc.input} />
            {tc.output !== undefined &&
              (tc.toolName === 'search_knowledge' ? (
                <KnowledgeCitations output={tc.output} />
              ) : (
                <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                  <JsonBlock value={tc.output} />
                </div>
              ))}
            {tc.error && (
              <div
                style={{
                  marginTop: 6,
                  color: 'var(--danger)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {tc.error}
              </div>
            )}
          </div>
        ))}
        {msg.text &&
          (msg.role === 'user' ? (
            <>
              {msg.referencedFileNames && msg.referencedFileNames.length > 0 && (
                <div
                  className="ab-pill"
                  style={{
                    display: 'inline-block',
                    marginBottom: 6,
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                  title="Files scoped via @-mention for this turn"
                >
                  Filtered to: {msg.referencedFileNames.join(', ')}
                </div>
              )}
              <div
                className="ab-msg-bubble"
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {renderUserText(msg.text, mentionItems)}
                {msg.status === 'streaming' && (
                  <span style={{ opacity: 0.5 }}> ▍</span>
                )}
              </div>
            </>
          ) : (
            <AssistantBubble msg={msg} />
          ))}
        {msg.role === 'assistant' &&
          msg.status === 'streaming' &&
          !msg.text &&
          msg.toolCalls.length === 0 && (
            <div className="ab-msg-bubble">
              <ThinkingDots />
            </div>
          )}
        {msg.role === 'assistant' &&
          msg.status === 'done' &&
          !msg.text &&
          msg.toolCalls.length === 0 &&
          !msg.errorMessage && (
            // Catches the brief window between the watchdog clearing a
            // stuck run and the message reload landing the persisted
            // text (see use-chat's watchdog). Also catches the genuine
            // "model returned no text" case — without this the row was
            // just a timestamp meta line with no bubble at all.
            <div
              className="ab-msg-bubble"
              style={{
                opacity: 0.55,
                fontStyle: 'italic',
                color: 'var(--text-muted)',
              }}
            >
              (no text response)
            </div>
          )}
        {msg.errorMessage && (
          <div
            className="ab-msg-bubble"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              color: 'var(--danger)',
            }}
          >
            {msg.errorMessage}
          </div>
        )}
        {msg.authorizeRequired?.map((conn) => (
          <McpReconnectNotice
            key={conn.connectionId}
            connectionId={conn.connectionId}
            connectionName={conn.connectionName}
          />
        ))}
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

/**
 * Inline "Reconnect" affordance shown under an assistant bubble when the
 * run discovered an external MCP connection whose OAuth session had
 * expired (the `run.mcp.authorize_required` event). Non-fatal: the run
 * completed without that connection's tools, so this is a quiet nudge,
 * not an error.
 *
 * Reuses the EXISTING connection test/authorize machinery — same shape
 * as `attach-mcp-sheet.tsx` and the MCP detail page: discover, and if
 * the server says `authorize_required`, open the upstream consent popup
 * and long-poll until the session goes terminal. The discover server-
 * side invalidates the agent's tool cache, so on success the user only
 * needs to resend their message. Popup + poll state is kept local to
 * this notice so two connections on the same message reconnect
 * independently.
 */
function McpReconnectNotice({
  connectionId,
  connectionName,
}: {
  connectionId: string
  connectionName: string
}) {
  const [busy, setBusy] = useState(false)
  const [reconnected, setReconnected] = useState(false)
  // Live refs so the recursive poll loop + the cross-window message
  // handler can coordinate the popup without re-subscribing each tick.
  const popupRef = useRef<Window | null>(null)
  const aliveRef = useRef(true)
  // Synchronous in-flight guard. `busy` is React state, so a second
  // click that lands in the same tick reads the stale render-closure
  // value (`false`) and slips past `if (busy) return`, kicking off a
  // second OAuth popup + poll loop. This ref flips true synchronously
  // at the top of `reconnect()` and clears when the loop ends, so a
  // second click is a true no-op.
  const inFlightRef = useRef(false)
  // Set once we've opened (or attempted to open) the popup for this
  // reconnect attempt, so the poll loop can watch for the user closing
  // it before completing OAuth and stop instead of hanging until the
  // server session TTL.
  const popupOpenedRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    // The OAuth callback page posts `mcp-oauth-complete` before closing
    // itself; close on our side too as a belt-and-suspenders.
    const onMessage = (e: MessageEvent) => {
      if (
        e.data &&
        typeof e.data === 'object' &&
        (e.data as { type?: unknown }).type === 'mcp-oauth-complete'
      ) {
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close()
        }
        popupRef.current = null
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      aliveRef.current = false
      inFlightRef.current = false
      window.removeEventListener('message', onMessage)
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close()
      }
      popupRef.current = null
    }
  }, [])

  const reconnect = async () => {
    // Synchronous re-entrancy guard (see `inFlightRef`). Must run before
    // any `await` so two clicks in the same tick can't both proceed.
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    popupOpenedRef.current = false

    // Single exit point: close the popup, re-enable the button, and
    // clear the in-flight guard so a later retry can start fresh. Every
    // terminal branch below routes through here.
    const stop = (): void => {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close()
      }
      popupRef.current = null
      popupOpenedRef.current = false
      inFlightRef.current = false
      setBusy(false)
    }

    const apply = async (
      res: Awaited<ReturnType<typeof discoverMcpTools>>,
    ): Promise<void> => {
      if (!aliveRef.current) return
      if (res.ok) {
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close()
        }
        popupRef.current = null
        popupOpenedRef.current = false
        inFlightRef.current = false
        setReconnected(true)
        setBusy(false)
        toast.success(`Reconnected ${connectionName}`)
        return
      }
      if (res.code === 'authorize_required' && res.sessionId) {
        if (res.authorizeUrl && !popupRef.current) {
          const popup = window.open(
            res.authorizeUrl,
            'agent-bridge-mcp-oauth',
            'popup,width=520,height=720',
          )
          // Popup blocked: `window.open` returns null. Surface a clear
          // nudge and STOP — do not let the loop retry `window.open`
          // every poll tick (it would spam blocked-popup attempts and
          // never converge).
          if (!popup) {
            toast.error(`Allow popups to reconnect ${connectionName}.`)
            stop()
            return
          }
          popupRef.current = popup
          popupOpenedRef.current = true
        }
        const sessionId = res.sessionId
        await new Promise((r) => setTimeout(r, 1500))
        if (!aliveRef.current) return
        // Abandoned popup: the user closed the consent window before
        // finishing OAuth. Stop instead of polling until the server
        // session TTL (~5 min) leaves the button disabled.
        if (popupOpenedRef.current && popupRef.current?.closed) {
          stop()
          return
        }
        const next = await pollMcpTest(
          connectionId,
          sessionId,
          'authorize_required',
        )
        return apply(next)
      }
      // Any other non-ok code is a genuine failure — surface it and
      // re-enable the button so the user can retry.
      toast.error(res.message ?? `Reconnect failed (${res.code})`)
      stop()
    }
    try {
      const res = await discoverMcpTools(connectionId, {})
      await apply(res)
    } catch (e) {
      if (!aliveRef.current) {
        // Component unmounted mid-flight — still clear the guard so a
        // remount can reconnect. (No toast: nothing is on screen.)
        inFlightRef.current = false
        return
      }
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Reconnect failed',
      )
      stop()
    }
  }

  if (reconnected) {
    return (
      <div
        className="ab-msg-bubble"
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--text-muted)',
        }}
      >
        <PlugIcon strokeWidth={2} />
        Reconnected. Resend your message to use {connectionName}.
      </div>
    )
  }

  return (
    <div
      className="ab-msg-bubble"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        fontSize: 13,
        color: 'var(--text-muted)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <PlugIcon strokeWidth={2} />
        {connectionName} needs reconnecting
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={reconnect}
        disabled={busy}
        leading={busy ? <ThinkingDots /> : undefined}
      >
        {busy ? 'Reconnecting…' : `Reconnect ${connectionName}`}
      </Button>
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
  catalog: ReadonlyArray<MentionItem>,
): React.ReactNode {
  // Sort by token length, longest-first, so `@skill:Code` doesn't
  // mask `@skill:Code Review` when both exist.
  const sortedItems = [...catalog]
    .filter((it) => it.token.length > 0)
    .sort((a, b) => b.token.length - a.token.length)
  // The token IS the display form for every kind — files are now
  // `@<filename>` (no `@file:<uuid>` wire prefix), so the chip text
  // and the underlying token are identical.
  const displayFor = (item: MentionItem): string => item.token
  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < text.length) {
    if (text[i] === '@') {
      // 1) Try the live catalog first — handles spaces in names.
      const hit = sortedItems.find((it) => text.startsWith(it.token, i))
      if (hit) {
        parts.push(
          <span key={`m${key++}`} className="ab-msg-mention">
            {displayFor(hit)}
          </span>,
        )
        i += hit.token.length
        continue
      }
      // 2) Fallback: strict-regex token (no spaces) for replayed
      //    messages whose catalog item no longer exists. File uuids
      //    in this branch get rendered as `@file:<short-id>` — better
      //    than the full uuid, still honest that the file is gone.
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
      const f = tail.match(
        /^@file:([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )
      if (f) {
        parts.push(
          <span key={`m${key++}`} className="ab-msg-mention">
            @file:{f[1]}…
          </span>,
        )
        i += f[0].length
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

/** Pretty-print a JS value as indented JSON. Long values collapse to a
 *  preview with a "Show all" toggle. Returns nothing when the value
 *  serialises to an empty string (undefined / functions / etc.). */
function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    if (value === undefined) return ''
    try {
      const s = JSON.stringify(value, null, 2)
      return typeof s === 'string' ? s : ''
    } catch {
      return String(value)
    }
  }, [value])
  const lineCount = text ? text.split('\n').length : 0
  const isLong = lineCount > JSON_BLOCK_PREVIEW_LINES + 2
  const [open, setOpen] = useState(false)
  if (!text) return null
  if (!isLong) {
    return <pre className="ab-msg-json">{text}</pre>
  }
  const visible = open
    ? text
    : text.split('\n').slice(0, JSON_BLOCK_PREVIEW_LINES).join('\n') + '\n…'
  return (
    <div className="ab-msg-json-collapse">
      <pre className="ab-msg-json">{visible}</pre>
      <button
        type="button"
        className="ab-msg-json-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Show less' : `Show all (${lineCount} lines)`}
      </button>
    </div>
  )
}

const JSON_BLOCK_PREVIEW_LINES = 12

/**
 * Visual rendering of `search_knowledge` results. Replaces the raw
 * JSON dump with one chip per chunk: `<filename> · p.N · "snippet…"`.
 * Hover shows the full snippet via the `title` attribute (cheap, no
 * extra portal needed). An empty `chunks: []` surfaces the `hint`
 * the tool returns when nothing cleared the relevance threshold.
 */
interface KnowledgeChunk {
  readonly file_id?: string
  readonly file_name?: string
  readonly page?: number | null
  readonly section?: string | null
  readonly snippet?: string
  readonly score?: number
}

function KnowledgeCitations({ output }: { output: unknown }) {
  const parsed = parseKnowledgeOutput(output)
  if (!parsed) {
    // Shape didn't match — fall back to raw JSON so the operator can
    // still inspect what came back.
    return (
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
        <JsonBlock value={output} />
      </div>
    )
  }
  if (parsed.chunks.length === 0) {
    return (
      <div
        className="ab-field-help"
        style={{ marginTop: 6, fontStyle: 'italic' }}
      >
        {parsed.hint ?? 'No matching passages.'}
      </div>
    )
  }
  // When the matched chunks span ≥3 distinct files, surface a small
  // "looking at N files" hint so the user knows the agent's
  // consulting the right scope (vs misinterpreting a low-N retrieval
  // as "the agent only found one source"). Doc-spec'd Phase 3 polish.
  const distinctFiles = new Set(
    parsed.chunks.map((c) => c.file_name ?? c.file_id ?? ''),
  )
  distinctFiles.delete('')
  return (
    <div
      style={{
        marginTop: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {distinctFiles.size >= 3 && (
        <div
          className="ab-pill"
          style={{
            display: 'inline-block',
            alignSelf: 'flex-start',
            fontSize: 11,
            color: 'var(--text-muted)',
            marginBottom: 2,
          }}
          title="Number of distinct files matched in this search"
        >
          Looking at {distinctFiles.size} files
        </div>
      )}
      {parsed.chunks.map((c, i) => {
        const head =
          (c.file_name ?? 'file') +
          (c.page != null ? ` · p.${c.page}` : '') +
          (c.section ? ` · ${c.section}` : '')
        const snippet = (c.snippet ?? '').replace(/\s+/g, ' ').trim()
        return (
          <div
            key={`${c.file_id ?? i}-${i}`}
            className="ab-pill"
            title={snippet}
            style={{
              display: 'block',
              maxWidth: '100%',
              lineHeight: 1.45,
              whiteSpace: 'normal',
              padding: '6px 10px',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {head}
            </div>
            <div
              style={{
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {snippet}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function parseKnowledgeOutput(
  output: unknown,
): { chunks: KnowledgeChunk[]; hint?: string } | null {
  if (!output || typeof output !== 'object') return null
  const obj = output as { chunks?: unknown; hint?: unknown }
  if (!Array.isArray(obj.chunks)) return null
  const chunks = obj.chunks.filter(
    (c): c is KnowledgeChunk => !!c && typeof c === 'object',
  )
  return {
    chunks,
    ...(typeof obj.hint === 'string' ? { hint: obj.hint } : {}),
  }
}

/** True when the entire trimmed string parses to a JSON object/array.
 *  Used to detect when an assistant message is a JSON-only payload
 *  (e.g. inspector toolkit output) so we render it as a code block
 *  instead of feeding it to the markdown renderer. */
function tryParseJson(text: string): unknown {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try {
    const v = JSON.parse(t)
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

function AssistantBubble({ msg }: { msg: ChatMessage }) {
  // Only treat the message as JSON once streaming has finished;
  // partial JSON tokens won't parse cleanly mid-stream.
  const jsonValue =
    msg.status === 'streaming' ? undefined : tryParseJson(msg.text)
  if (jsonValue !== undefined) {
    return (
      <div className="ab-msg-bubble">
        <JsonBlock value={jsonValue} />
      </div>
    )
  }
  // Strip reasoning-model wrapper tags from the rendered text. Qwen3
  // (and similar reasoning-capable local models) emit `<think>…</think>`
  // around their chain-of-thought; Mastra routes the inner text into a
  // `reasoning-*` chunk stream while the literal wrapper tokens leak
  // into the regular text-delta stream, leaving us with empty wrappers
  // in `msg.text`. Strip at render time only — `runs.output_summary`
  // keeps the raw stream so /logs preserves the debug signal, and
  // /logs's run.model.result event captures the actual reasoning text
  // separately (dispatcher handles `reasoning-*` chunks).
  const visibleText = stripThinkBlocks(msg.text)
  return (
    <div
      className={
        'ab-msg-bubble ab-msg-bubble-md' +
        (msg.status === 'streaming' ? ' is-streaming' : '')
      }
    >
      <Markdown source={visibleText} />
    </div>
  )
}

/**
 * Remove `<think>...</think>` blocks (the wrapper Qwen3-class reasoning
 * models emit around chain-of-thought). Handles empty wrappers (the
 * common case — content lives in `reasoning-*` chunks the dispatcher
 * routes elsewhere), multiline content, and multiple blocks per
 * message. Collapses any leftover blank-line runs so the chat bubble
 * doesn't end up with three blank lines where the reasoning block was.
 *
 * Conservative regex — only matches the exact `<think>` / `</think>`
 * pair (case-sensitive, no attributes). Other HTML-ish content the
 * model might emit passes through to Markdown unchanged.
 */
function stripThinkBlocks(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  return stripped.replace(/\n{3,}/g, '\n\n').trim()
}

function ThreadRail({
  threads,
  activeThreadId,
  streamingThreadIds,
  unreadThreadIds,
  onNew,
  onSwitch,
  onDelete,
  error,
  disabled,
}: {
  threads: readonly ChatThreadMeta[]
  activeThreadId: string
  /** Threads with an open SSE subscription (whether focused or not).
   *  Used together with `unreadThreadIds` to decide if the unread
   *  dot should pulse (still streaming) or stay static (terminated
   *  but unviewed). */
  streamingThreadIds: ReadonlySet<string>
  /** Threads with unviewed activity. Set when a run starts on a
   *  non-focused thread, cleared when the user visits. */
  unreadThreadIds: ReadonlySet<string>
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
            }}
          >
            {unreadThreadIds.has(t.threadId) && (
              <span
                aria-label={
                  streamingThreadIds.has(t.threadId)
                    ? 'Streaming, unviewed'
                    : 'Unviewed activity'
                }
                title={
                  streamingThreadIds.has(t.threadId)
                    ? 'A run is streaming here; switch in to watch.'
                    : 'New activity since you last opened this conversation.'
                }
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 7,
                  flexShrink: 0,
                  borderRadius: 999,
                  background: 'var(--accent-400)',
                  animation: streamingThreadIds.has(t.threadId)
                    ? 'ab-pulse-blue 1.6s ease-in-out infinite'
                    : undefined,
                }}
              />
            )}
            <span
              className="ab-thread-row-title"
              style={{ minWidth: 0, flex: 1 }}
            >
              {t.title ?? 'Untitled'}
            </span>
          </div>
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
