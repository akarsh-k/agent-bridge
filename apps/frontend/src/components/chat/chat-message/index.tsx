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
import type { ChatMessage as ChatMessageType } from '../../../lib/use-chat'
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
              <ToolCallCard key={call.toolCallId} call={call} />
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
