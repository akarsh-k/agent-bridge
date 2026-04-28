/**
 * Collapsible card for a single tool invocation inside an assistant
 * message. Header always shows the tool name + status; expanded body
 * renders pretty-printed input and output.
 *
 * Status glyphs:
 *   - pending (spinning circle) — tool-call seen, result not back
 *   - done    (check)           — tool-result arrived, no error
 *   - error   (cross)           — tool-result arrived with an error string
 *
 * Rendering rules:
 *   - JSON is shown as `<code>` blocks; strings render verbatim.
 *   - Outputs bigger than MAX_PREVIEW_CHARS render a "show more" link.
 */

import { useMemo, useState } from 'react'
import type { ChatMcpLog, ChatToolInvocation } from '../../../lib/use-chat'

import './index.css'

interface ToolCallCardProps {
  readonly call: ChatToolInvocation
  /**
   * Scrubbed stderr lines from the underlying MCP connection that
   * fall within this call's time window. Rendered as a collapsed
   * entry at the bottom of the card body so the operator can inspect
   * the banner printed by the MCP alongside the JSON-RPC input /
   * output.
   */
  readonly mcpLogs?: readonly ChatMcpLog[]
}

const MAX_PREVIEW_CHARS = 1200

export function ToolCallCard({ call, mcpLogs }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const [inputExpanded, setInputExpanded] = useState(false)
  const [outputExpanded, setOutputExpanded] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const logs = mcpLogs ?? []

  const { preview: inputPreview, full: inputFull } = useMemo(
    () => stringify(call.input),
    [call.input],
  )
  const { preview: outputPreview, full: outputFull } = useMemo(
    () => stringify(call.output),
    [call.output],
  )

  const durationMs =
    call.finishedAt !== undefined
      ? call.finishedAt - call.startedAt
      : null

  return (
    <div className={`tool-call tool-call-${call.status}`}>
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <StatusIcon status={call.status} />
        <span className="tool-call-name">{call.toolName || 'tool'}</span>
        <span className="tool-call-step">step {call.stepIndex}</span>
        {durationMs !== null ? (
          <span className="tool-call-duration">{formatDuration(durationMs)}</span>
        ) : null}
        <span className={`tool-call-caret${open ? ' open' : ''}`} aria-hidden="true">
          ▸
        </span>
      </button>

      {open ? (
        <div className="tool-call-body">
          {call.error ? (
            <div className="tool-call-error" role="alert">
              {call.error}
            </div>
          ) : null}

          <PayloadBlock
            label="input"
            preview={inputPreview}
            full={inputFull}
            expanded={inputExpanded}
            onToggle={() => setInputExpanded((v) => !v)}
          />

          {call.output !== undefined ? (
            <PayloadBlock
              label="output"
              preview={outputPreview}
              full={outputFull}
              expanded={outputExpanded}
              onToggle={() => setOutputExpanded((v) => !v)}
            />
          ) : call.status === 'pending' ? (
            <div className="tool-call-pending">Waiting for result…</div>
          ) : null}

          {logs.length > 0 ? (
            <div className="tool-call-mcp-logs">
              <button
                type="button"
                className="tool-call-mcp-logs-toggle"
                onClick={() => setLogsOpen((v) => !v)}
                aria-expanded={logsOpen}
              >
                <span className={`tool-call-caret${logsOpen ? ' open' : ''}`}>
                  ▸
                </span>
                <span>
                  mcp log · {logs.length} line{logs.length === 1 ? '' : 's'}
                </span>
              </button>
              {logsOpen ? (
                <pre className="tool-call-payload-body tool-call-mcp-logs-body">
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
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ─── Internal pieces ────────────────────────────────────────────────────

function StatusIcon({ status }: { status: ChatToolInvocation['status'] }) {
  if (status === 'pending') {
    return (
      <span
        className="tool-call-status tool-call-status-pending"
        aria-hidden="true"
      />
    )
  }
  if (status === 'error') {
    return (
      <span
        className="tool-call-status tool-call-status-error"
        aria-hidden="true"
      >
        ✕
      </span>
    )
  }
  return (
    <span className="tool-call-status tool-call-status-done" aria-hidden="true">
      ✓
    </span>
  )
}

interface PayloadBlockProps {
  readonly label: string
  readonly preview: string
  readonly full: string
  readonly expanded: boolean
  readonly onToggle: () => void
}

function PayloadBlock({
  label,
  preview,
  full,
  expanded,
  onToggle,
}: PayloadBlockProps) {
  const truncated = preview !== full
  const shown = expanded ? full : preview
  return (
    <div className="tool-call-payload">
      <div className="tool-call-payload-label">{label}</div>
      <pre className="tool-call-payload-body">{shown}</pre>
      {truncated ? (
        <button
          type="button"
          className="tool-call-payload-more"
          onClick={onToggle}
        >
          {expanded ? 'Show less' : `Show ${full.length - preview.length} more chars`}
        </button>
      ) : null}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function stringify(value: unknown): { preview: string; full: string } {
  if (value === undefined) return { preview: '—', full: '—' }
  if (value === null) return { preview: 'null', full: 'null' }
  if (typeof value === 'string') {
    return preview(value)
  }
  try {
    const s = JSON.stringify(value, null, 2)
    return preview(s)
  } catch {
    return preview(String(value))
  }
}

function preview(s: string): { preview: string; full: string } {
  if (s.length <= MAX_PREVIEW_CHARS) return { preview: s, full: s }
  return { preview: s.slice(0, MAX_PREVIEW_CHARS) + '…', full: s }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}
