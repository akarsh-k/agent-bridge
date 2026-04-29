/**
 * Single chat message. User messages are plain right-aligned bubbles.
 * Assistant messages carry the whole run timeline:
 *
 *   ┌─ assistant bubble ────────────────────────┐
 *   │ <streaming text with blinking cursor>     │
 *   │                                           │
 *   │ [ tool-call cards, inline, in step order ]│
 *   │                                           │
 *   │ ▾ Run details  ·  3 steps · 418ms · 312t  │
 *   └───────────────────────────────────────────┘
 *
 * Run details collapse by default. Errors always render a visible
 * banner — no need to expand to see what went wrong.
 *
 * Streaming state is conveyed by (a) a pulsing cursor after the last
 * character and (b) subtle opacity on tool-call cards whose result has
 * not landed yet.
 */

import { useMemo, useState } from 'react'
import type {
  ChatMcpLog,
  ChatMessage as ChatMessageType,
  ChatToolInvocation,
} from '../../../lib/use-chat'
import { ToolCallCard } from '../tool-call-card'

import './index.css'

interface ChatMessageProps {
  readonly message: ChatMessageType
}

export function ChatMessage({ message }: ChatMessageProps) {
  if (message.role === 'user') {
    return <UserBubble message={message} />
  }
  return <AssistantBubble message={message} />
}

// ─── User ────────────────────────────────────────────────────────────────

function UserBubble({ message }: { message: ChatMessageType }) {
  return (
    <div className="chat-msg chat-msg-user">
      <div className="chat-msg-bubble">
        {message.text}
        {message.status === 'error' && message.errorMessage ? (
          <div className="chat-msg-error chat-msg-error-inline" role="alert">
            Couldn’t start run: {message.errorMessage}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── Assistant ──────────────────────────────────────────────────────────

function AssistantBubble({ message }: { message: ChatMessageType }) {
  const [detailsOpen, setDetailsOpen] = useState(false)

  const totalUsage = useMemo(() => sumUsage(message), [message])
  const isStreaming = message.status === 'streaming'
  const hasErrored = message.status === 'error'
  const isPlainStreamingNoText = isStreaming && message.text.length === 0
  const showDetailsToggle = message.steps.length > 0 || totalUsage !== null

  // Filter out info-level MCP logs from the chat surface. These are
  // protocol traces and `mcp-remote` startup spam (`tools/list`,
  // `initialize`, npm warnings, OAuth handshake banners) — useful for
  // debugging but pure noise in a conversation. Warn + error stay
  // because they signal something actionable (auth failure, upstream
  // rate-limit, etc.). The full feed remains in `run_events` for
  // forensic replay.
  const visibleMcpLogs = useMemo(
    () => filterRelevantLogs(message.mcpLogs),
    [message.mcpLogs],
  )

  return (
    <div className="chat-msg chat-msg-assistant">
      <div className={`chat-msg-bubble${hasErrored ? ' has-error' : ''}`}>
        {message.modelId ? (
          <div className="chat-msg-meta">
            <span className="chat-msg-dot" aria-hidden="true" />
            <span className="chat-msg-model" title={message.providerKind ?? ''}>
              {message.modelId}
            </span>
            {message.gitnexusMounted && message.toolCount ? (
              <span
                className="chat-msg-tools-count"
                title={`${message.toolCount} GitNexus tools mounted`}
              >
                · {message.toolCount} tools
              </span>
            ) : null}
          </div>
        ) : null}

        {isPlainStreamingNoText ? (
          <div className="chat-msg-thinking">
            <span className="chat-msg-thinking-dot" />
            <span className="chat-msg-thinking-dot" />
            <span className="chat-msg-thinking-dot" />
          </div>
        ) : null}

        {message.text.length > 0 ? (
          <div className="chat-msg-text">
            {message.text}
            {isStreaming ? (
              <span className="chat-msg-cursor" aria-hidden="true" />
            ) : null}
          </div>
        ) : null}

        {message.toolCalls.length > 0 ? (
          <div className="chat-msg-tools">
            {message.toolCalls.map((call) => (
              <ToolCallCard
                key={call.toolCallId}
                call={call}
                mcpLogs={filterRelevantLogs(
                  logsForToolCall(call, message.toolCalls, visibleMcpLogs),
                )}
              />
            ))}
          </div>
        ) : null}

        {orphanMcpLogs(message.toolCalls, visibleMcpLogs).length > 0 ? (
          <div className="chat-msg-tools chat-msg-tools-orphan">
            {groupLogsByConnection(
              orphanMcpLogs(message.toolCalls, visibleMcpLogs),
            ).map((group) => (
              <McpLogsStandaloneCard
                key={group.connectionId}
                connectionName={group.connectionName}
                logs={group.logs}
              />
            ))}
          </div>
        ) : null}

        {hasErrored ? (
          <div className="chat-msg-error" role="alert">
            <div className="chat-msg-error-kind">
              {formatErrorKind(message.errorKind)}
            </div>
            <div className="chat-msg-error-text">
              {message.errorMessage ?? 'Run failed.'}
            </div>
          </div>
        ) : null}

        {showDetailsToggle ? (
          <div className="chat-msg-details">
            <button
              type="button"
              className="chat-msg-details-toggle"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
            >
              <span className={`chat-msg-caret${detailsOpen ? ' open' : ''}`}>
                ▸
              </span>
              <span>Run details</span>
              <span className="chat-msg-details-summary">
                {formatRunSummary(message, totalUsage)}
              </span>
            </button>
            {detailsOpen ? (
              <RunDetails message={message} totalUsage={totalUsage} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── Run details drawer ─────────────────────────────────────────────────

function RunDetails({
  message,
  totalUsage,
}: {
  message: ChatMessageType
  totalUsage: { input: number | null; output: number | null; total: number | null } | null
}) {
  return (
    <div className="chat-msg-details-body">
      <dl className="chat-msg-details-grid">
        {message.runId ? (
          <>
            <dt>run</dt>
            <dd>
              <code>{message.runId.slice(0, 8)}</code>
            </dd>
          </>
        ) : null}
        {message.finishReason ? (
          <>
            <dt>reason</dt>
            <dd>{message.finishReason}</dd>
          </>
        ) : null}
        {message.durationMs !== undefined ? (
          <>
            <dt>duration</dt>
            <dd>{formatDuration(message.durationMs)}</dd>
          </>
        ) : null}
        {totalUsage && totalUsage.total !== null ? (
          <>
            <dt>tokens</dt>
            <dd>
              {totalUsage.total}
              {totalUsage.input !== null && totalUsage.output !== null ? (
                <span className="chat-msg-details-dim">
                  {' '}
                  ({totalUsage.input} in · {totalUsage.output} out)
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      {message.steps.length > 0 ? (
        <div className="chat-msg-steps">
          {message.steps.map((step) => (
            <div
              key={step.stepIndex}
              className={`chat-msg-step chat-msg-step-${step.status}`}
            >
              <div className="chat-msg-step-head">
                <span className="chat-msg-step-index">
                  step {step.stepIndex}
                </span>
                {step.finishReason ? (
                  <span className="chat-msg-step-reason">
                    · {step.finishReason}
                  </span>
                ) : null}
                {step.status === 'streaming' ? (
                  <span className="chat-msg-step-live">live</span>
                ) : null}
              </div>
              {step.usage && step.usage.totalTokens !== null ? (
                <div className="chat-msg-step-usage">
                  {step.usage.totalTokens} tokens
                  {step.usage.inputTokens !== null &&
                  step.usage.outputTokens !== null ? (
                    <span className="chat-msg-details-dim">
                      {' '}
                      ({step.usage.inputTokens} in · {step.usage.outputTokens}{' '}
                      out)
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ─── MCP log grouping ───────────────────────────────────────────────────

/**
 * Pick the MCP log lines that "belong" to a given tool card. The rule:
 * a log line's `connectionName` slugified (lower/ascii/run-collapsed)
 * MUST match the tool card's name prefix up to `__`. Multiple tool
 * cards can share a connection (e.g. two `notion__*` calls in one
 * run); each card shows the ENTIRE tail since the previous same-
 * connection tool card finished, so the operator can see the
 * stderr banner that accompanied each call.
 *
 * Ordering guarantee:
 *   - Logs are captured in event-arrival order (see `applyMcpLog`).
 *   - For each tool card we take the logs whose timestamp falls
 *     between (exclusive) the previous same-connection card's
 *     finishedAt and (inclusive) this card's finishedAt-or-now.
 *
 * This is best-effort — we don't have a hard link between a log
 * line and a tool call. The worst case is a line assigned to the
 * wrong card (if two calls run overlapped on a connection we don't
 * actually support yet); operators can still see it in the standalone
 * orphan block.
 */
function logsForToolCall(
  call: ChatToolInvocation,
  allCalls: readonly ChatToolInvocation[],
  allLogs: readonly ChatMcpLog[],
): ChatMcpLog[] {
  if (allLogs.length === 0) return []
  const slug = connectionSlugFromToolName(call.toolName)
  if (!slug) return []

  const sameConnectionCalls = allCalls.filter(
    (c) => connectionSlugFromToolName(c.toolName) === slug,
  )
  const index = sameConnectionCalls.findIndex(
    (c) => c.toolCallId === call.toolCallId,
  )
  if (index === -1) return []

  const prevCall = index > 0 ? sameConnectionCalls[index - 1] : null
  const lowerBound = prevCall?.finishedAt ?? prevCall?.startedAt ?? 0
  const upperBound = call.finishedAt ?? Number.POSITIVE_INFINITY

  return allLogs.filter((log) => {
    if (slugifyClient(log.connectionName) !== slug) return false
    return log.ts > lowerBound && log.ts <= upperBound
  })
}

/**
 * Logs that didn't land under any tool card. Usually: startup
 * banners (printed before the first tool call) or logs for a
 * connection whose tool-call message hasn't arrived yet (rare,
 * because we always see `tool-call` before `tool-result`, but
 * possible on SSE reconnect).
 */
function orphanMcpLogs(
  allCalls: readonly ChatToolInvocation[],
  allLogs: readonly ChatMcpLog[],
): ChatMcpLog[] {
  if (allLogs.length === 0) return []
  const used = new Set<number>()
  for (const call of allCalls) {
    const mine = logsForToolCall(call, allCalls, allLogs)
    for (const log of mine) {
      // Identity is stable across renders because logs are immutable
      // ChatMcpLog instances pushed once and never mutated; a ref-
      // equality set is fine.
      used.add(allLogs.indexOf(log))
    }
  }
  const orphans: ChatMcpLog[] = []
  allLogs.forEach((log, i) => {
    if (!used.has(i)) orphans.push(log)
  })
  return orphans
}

function groupLogsByConnection(
  logs: readonly ChatMcpLog[],
): readonly {
  readonly connectionId: string
  readonly connectionName: string
  readonly logs: readonly ChatMcpLog[]
}[] {
  const byId = new Map<
    string,
    { connectionId: string; connectionName: string; logs: ChatMcpLog[] }
  >()
  for (const log of logs) {
    const existing = byId.get(log.connectionId)
    if (existing) {
      existing.logs.push(log)
      continue
    }
    byId.set(log.connectionId, {
      connectionId: log.connectionId,
      connectionName: log.connectionName,
      logs: [log],
    })
  }
  return Array.from(byId.values())
}

/** Extract the connection slug from an auto-prefixed tool name. */
function connectionSlugFromToolName(toolName: string): string | null {
  const idx = toolName.indexOf('__')
  if (idx <= 0) return null
  return toolName.slice(0, idx)
}

/**
 * Mirror of `slugifyConnectionName` in `packages/agents/src/mcp/external-mcps.ts`.
 * Keep in sync — drift would mis-assign logs to tool cards.
 */
function slugifyClient(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}

/**
 * Standalone card for log groups that don't belong under any tool
 * card. Same visual idiom as `ToolCallCard`'s header to keep the
 * message's vertical rhythm consistent.
 */
function McpLogsStandaloneCard({
  connectionName,
  logs,
}: {
  connectionName: string
  logs: readonly ChatMcpLog[]
}) {
  const [open, setOpen] = useState(false)
  const highest = highestLevel(logs)
  return (
    <div className={`tool-call tool-call-${highest === 'error' ? 'error' : 'done'}`}>
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-call-status tool-call-status-done" aria-hidden="true">
          ⓘ
        </span>
        <span className="tool-call-name">{connectionName} · logs</span>
        <span className="tool-call-step">
          {logs.length} line{logs.length === 1 ? '' : 's'}
        </span>
        <span className={`tool-call-caret${open ? ' open' : ''}`} aria-hidden="true">
          ▸
        </span>
      </button>
      {open ? (
        <div className="tool-call-body">
          <McpLogList logs={logs} />
        </div>
      ) : null}
    </div>
  )
}

function McpLogList({ logs }: { logs: readonly ChatMcpLog[] }) {
  return (
    <pre className="tool-call-payload-body chat-msg-mcp-log-body">
      {logs
        .map((log) => {
          const tag =
            log.level === 'error'
              ? '[error]'
              : log.level === 'warn'
                ? '[warn] '
                : '[info] '
          return `${tag} ${log.line}`
        })
        .join('\n')}
    </pre>
  )
}

/**
 * Filter MCP log lines for the chat surface. Currently returns an
 * empty array — chat is for the conversation, not subprocess stderr.
 *
 * Why a hard zero, not "warn+error only":
 *   - `info` is dominated by `mcp-remote`'s JSON-RPC trace
 *     (`initialize`, `tools/list`, `Connecting to remote server: …`)
 *     and OAuth handshake banners.
 *   - `warn` is dominated by npm-config noise from the Node wrapper
 *     around `mcp-remote` (`npm warn Unknown env config …`) — it
 *     comes from the CLI shell, not the upstream MCP, so the
 *     operator can't act on it from this UI.
 *   - Real failures the user CAN act on — auth errors, tool-call
 *     errors, run errors — already surface via:
 *       (a) the tool card flipping to `tool-call-error` with an
 *           error message, and
 *       (b) the assistant bubble's red `run.error` banner.
 *   - The full unfiltered feed remains in `run_events`. A future
 *     "Show MCP logs in chat" setting can flip this gate without
 *     touching the audit log path.
 */
function filterRelevantLogs(
  logs: readonly ChatMcpLog[],
): ChatMcpLog[] {
  void logs
  return []
}

function highestLevel(
  logs: readonly ChatMcpLog[],
): ChatMcpLog['level'] {
  let level: ChatMcpLog['level'] = 'info'
  for (const log of logs) {
    if (log.level === 'error') return 'error'
    if (log.level === 'warn') level = 'warn'
  }
  return level
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sumUsage(
  message: ChatMessageType,
): { input: number | null; output: number | null; total: number | null } | null {
  if (message.usage) {
    return {
      input: message.usage.inputTokens,
      output: message.usage.outputTokens,
      total: message.usage.totalTokens,
    }
  }
  // Fall back to step-level usage (multi-step runs).
  let input = 0
  let output = 0
  let total = 0
  let anyTotal = false
  for (const step of message.steps) {
    if (!step.usage) continue
    if (step.usage.totalTokens !== null) {
      total += step.usage.totalTokens
      anyTotal = true
    }
    if (step.usage.inputTokens !== null) input += step.usage.inputTokens
    if (step.usage.outputTokens !== null) output += step.usage.outputTokens
  }
  if (!anyTotal) return null
  return { input: input || null, output: output || null, total }
}

function formatRunSummary(
  message: ChatMessageType,
  totalUsage: { total: number | null } | null,
): string {
  const parts: string[] = []
  if (message.steps.length > 0) {
    parts.push(
      `${message.steps.length} step${message.steps.length === 1 ? '' : 's'}`,
    )
  }
  if (message.durationMs !== undefined) {
    parts.push(formatDuration(message.durationMs))
  }
  if (totalUsage && totalUsage.total !== null) {
    parts.push(`${totalUsage.total}t`)
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const mins = Math.floor(seconds / 60)
  const rem = Math.floor(seconds - mins * 60)
  return `${mins}m ${rem}s`
}

function formatErrorKind(kind: ChatMessageType['errorKind']): string {
  switch (kind) {
    case 'auth':
      return 'Authentication error'
    case 'upstream':
      return 'Upstream provider error'
    case 'tool':
      return 'Tool error'
    case 'internal':
      return 'Internal error'
    default:
      return 'Error'
  }
}
