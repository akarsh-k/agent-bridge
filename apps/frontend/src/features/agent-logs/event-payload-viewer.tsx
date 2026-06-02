/**
 * Render an opaque event `payload` (typed `unknown`, see `RunEvent.data`)
 * in a way an operator can actually scan.
 *
 * The current timeline drops the whole payload into one
 * `<pre>JSON.stringify(p, null, 2)</pre>` block. That's fine for tiny rows
 * but unreadable when a tool returns 30KB of nested JSON or a `line` field
 * holds an escaped multi-line stderr blob (`\\n` everywhere instead of
 * actual line breaks).
 *
 * This viewer renders:
 *   - **Object payloads** as a label / value table for the top-level keys.
 *     Scalars inline. Long strings get a "Show all" toggle so they don't
 *     blow the row height. Nested objects/arrays render as compact pretty-
 *     printed JSON in their own scroll-capped pane.
 *   - **Non-object payloads** (string, number, array) as a single value.
 *
 * One "Copy JSON" button at the top covers the whole payload — the per-row
 * Copy from the previous viewer was rarely useful (operators paste the
 * whole event when filing a bug).
 *
 * Added but not yet consumed. A follow-up wires this into the
 * `EventRow` expansion in `run-detail-sheet.tsx`.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const LONG_STRING_PREVIEW = 280
const NESTED_MAX_HEIGHT = 280

interface EventPayloadViewerProps {
  payload: unknown
}

/**
 * Standalone wrapper used by `SingleRow` — the row body opens straight
 * into one payload, so it owns its own divider + copy-bar chrome. For
 * paired rows that render Input AND Output side-by-side, use
 * `EventPayloadBody` directly so the two halves can share consistent
 * outer styling instead of stacking two viewer chromes inside one card.
 */
export function EventPayloadViewer({ payload }: EventPayloadViewerProps) {
  if (payload === null || payload === undefined) {
    return (
      <div
        style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--surface-hi)',
          padding: 'var(--space-2_5) var(--space-3)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-xs)',
          fontStyle: 'italic',
        }}
      >
        No payload.
      </div>
    )
  }
  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--surface-hi)',
        padding: 'var(--space-2_5) var(--space-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 'var(--space-2_5)',
        }}
      >
        <ViewJsonButton payload={payload} />
        <CopyJsonButton payload={payload} />
      </div>
      <EventPayloadBody payload={payload} />
    </div>
  )
}

/**
 * Just the data — no card chrome, no copy button, no top divider. The
 * caller controls the surrounding box, so paired Input/Output sub-cards
 * can share a single padded region instead of nesting two viewer chromes.
 *
 * Renders objects as a key/value table; primitives + arrays fall through
 * to `ValueBlock` which knows how to handle long strings and nested JSON.
 */
export function EventPayloadBody({ payload }: { payload: unknown }) {
  if (payload === null || payload === undefined) {
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          fontSize: 'var(--text-xs)',
          fontStyle: 'italic',
        }}
      >
        No payload.
      </div>
    )
  }
  if (looksLikeInspectionReport(payload)) {
    return <CodebaseInspectionReportView report={payload} />
  }
  // A `run.tool.result` wraps the report under `output`; the rest of the
  // envelope (runId / toolName / stepIndex / toolCallId) is already on the
  // row header, so surface the report itself as the block's main content.
  if (isPlainObject(payload) && looksLikeInspectionReport(payload['output'])) {
    return <CodebaseInspectionReportView report={payload['output']} />
  }
  return isPlainObject(payload) ? (
    <ObjectKeyValueList obj={payload} />
  ) : (
    <ValueBlock value={payload} />
  )
}

/** Caption above a formatted report, framing it as evidence (not the answer). */
const INSPECTION_REPORT_EXPLAINER =
  'Research evidence from one step, capped at ~12k tokens. The agent reads ' +
  'it to ground its answer, and the accumulated reports are returned to the ' +
  'caller (e.g. your IDE agent) as the citations behind that answer.'

/** Structural sniff for a `CodebaseInspectionReport` (see
 *  `packages/agents/src/inspector/types.ts`). Loose on purpose, the
 *  payload is `unknown` over the wire. */
function looksLikeInspectionReport(p: unknown): p is Record<string, unknown> {
  return (
    isPlainObject(p) &&
    typeof p['wrapper'] === 'string' &&
    typeof p['summary'] === 'string' &&
    Array.isArray(p['files']) &&
    typeof p['tokens_used'] === 'number' &&
    isPlainObject(p['graph_subset'])
  )
}

/**
 * Formatted inspection-report view, with a "Raw JSON" toggle so nothing the
 * formatter doesn't surface is hidden.
 */
function CodebaseInspectionReportView({
  report,
}: {
  report: Record<string, unknown>
}) {
  const [showRaw, setShowRaw] = useState(false)
  const wrapper =
    typeof report['wrapper'] === 'string' ? report['wrapper'] : 'report'
  const summary = typeof report['summary'] === 'string' ? report['summary'] : ''
  const tokensUsed =
    typeof report['tokens_used'] === 'number' ? report['tokens_used'] : null
  const tokensCap =
    typeof report['tokens_cap'] === 'number' ? report['tokens_cap'] : null
  const warnings = Array.isArray(report['warnings'])
    ? report['warnings'].filter((w): w is string => typeof w === 'string')
    : []
  const truncated = warnings.some((w) => w.includes('to fit under'))
  const files = Array.isArray(report['files']) ? report['files'] : []
  const resolved = isPlainObject(report['resolved_repo'])
    ? report['resolved_repo']
    : null
  const resolvedLabel =
    resolved && typeof resolved['label'] === 'string' ? resolved['label'] : null
  const resolvedSignal =
    resolved && typeof resolved['matched_signal'] === 'string'
      ? resolved['matched_signal']
      : null

  const toggle = (
    <button
      type="button"
      className="ab-inline-action"
      onClick={() => setShowRaw((v) => !v)}
    >
      {showRaw ? 'Formatted' : 'Raw JSON'}
    </button>
  )

  if (showRaw) {
    return (
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginBottom: 'var(--space-1_5)',
          }}
        >
          {toggle}
        </div>
        <pre
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-2_5)',
            background: 'var(--code-well)',
            border: '1px solid var(--code-well-border)',
            borderRadius: 'var(--radius)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {safeStringify(report)}
        </pre>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2_5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <span
          className="ab-mono"
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--fw-semibold)',
            color: 'var(--text)',
          }}
        >
          {wrapper}
        </span>
        {tokensUsed !== null && (
          <span
            className="ab-mono"
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {tokensUsed.toLocaleString()}
            {tokensCap !== null ? ` / ${tokensCap.toLocaleString()}` : ''} tok
          </span>
        )}
        {truncated && (
          <span
            style={{
              fontSize: 'var(--text-3xs)',
              fontWeight: 'var(--fw-semibold)',
              color: 'var(--warn)',
              background: 'var(--warn-bg)',
              border: '1px solid var(--warn-border)',
              borderRadius: 'var(--radius-pill)',
              padding: 'var(--space-0_5) var(--space-1_5)',
            }}
          >
            truncated
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>{toggle}</span>
      </div>

      <div
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          lineHeight: 1.45,
        }}
      >
        {INSPECTION_REPORT_EXPLAINER}
      </div>

      {summary && (
        <div
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text)',
            lineHeight: 1.5,
          }}
        >
          {summary}
        </div>
      )}

      {resolvedLabel && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
          Repo: <span className="ab-mono">{resolvedLabel}</span>
          {resolvedSignal ? ` · matched ${resolvedSignal}` : ''}
        </div>
      )}

      {warnings.length > 0 && (
        <ul
          style={{
            margin: 0,
            paddingLeft: 'var(--space-4)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--warn)',
          }}
        >
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div>
        <div
          className="ab-field-label"
          style={{ marginBottom: 'var(--space-1_5)' }}
        >
          Files ({files.length})
        </div>
        {files.length === 0 ? (
          <div
            style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}
          >
            No files in this report.
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1_5)',
            }}
          >
            {files.map((f, i) => (
              <ReportFileRow key={i} file={f} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReportFileRow({ file }: { file: unknown }) {
  if (!isPlainObject(file)) return null
  const path =
    typeof file['path'] === 'string' ? file['path'] : '(unknown path)'
  const repoLabel =
    typeof file['repo_label'] === 'string' ? file['repo_label'] : null
  const language =
    typeof file['language'] === 'string' ? file['language'] : null
  const why = typeof file['why'] === 'string' ? file['why'] : null
  const chunks = Array.isArray(file['chunks']) ? file['chunks'].length : 0
  const meta = [
    repoLabel,
    language,
    `${chunks} chunk${chunks === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-0_5)',
        padding: 'var(--space-1_5) var(--space-2)',
        background: 'var(--code-well)',
        border: '1px solid var(--code-well-border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <span
          className="ab-mono"
          style={{
            fontSize: 'var(--text-2xs)',
            color: 'var(--text)',
            wordBreak: 'break-all',
          }}
        >
          {path}
        </span>
        <span
          style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}
        >
          {meta}
        </span>
      </div>
      {why && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
          {why}
        </div>
      )}
    </div>
  )
}

/**
 * Right-aligned "Copy JSON" affordance. Pulled out so paired rows can
 * render one copy button per sub-card (Input copy / Output copy) without
 * each call site re-implementing the clipboard + transient "Copied!"
 * state.
 */
export function CopyJsonButton({ payload }: { payload: unknown }) {
  const [copied, setCopied] = useState(false)
  const rawJson = useMemo(() => safeStringify(payload), [payload])
  const onCopy = (): void => {
    void navigator.clipboard.writeText(rawJson).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="ab-inline-action"
      title="Copy raw payload JSON"
    >
      {copied ? 'Copied' : 'Copy JSON'}
    </button>
  )
}

/**
 * Opens a centered full-screen modal with the entire payload pretty-
 * printed. Lives next to Copy JSON so operators can read the whole thing
 * inline without round-tripping through clipboard + external editor.
 */
export function ViewJsonButton({ payload }: { payload: unknown }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const close = (): void => {
    setOpen(false)
    // Restore focus to the trigger so keyboard navigation continues
    // from where the user invoked the modal.
    triggerRef.current?.focus()
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="ab-inline-action"
        title="View full JSON"
      >
        View JSON
      </button>
      {open && <JsonModal payload={payload} onClose={close} />}
    </>
  )
}

function JsonModal({
  payload,
  onClose,
}: {
  payload: unknown
  onClose: () => void
}) {
  const json = useMemo(() => safeStringify(payload), [payload])
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(true)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  // Capture-phase Esc so a parent Sheet's bubble-phase Esc handler
  // doesn't ALSO fire and close the surrounding sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // Pull focus into the modal on open so Tab / Esc work without an
  // initial click. Close is the safest target — pressing Enter on it
  // matches user intent.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const onCopy = (): void => {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return createPortal(
    <>
      <div
        className="ab-sheet-backdrop is-open"
        onClick={onClose}
        style={{ zIndex: 'var(--z-modal)' }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(1200px, calc(100vw - var(--space-12)))',
          height: 'min(820px, calc(100vh - var(--space-12)))',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          zIndex: 'calc(var(--z-modal) + 1)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'ab-dialog-in 200ms var(--ease-out)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-2_5) var(--space-3)',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-hi)',
          }}
        >
          <div
            id={titleId}
            className="ab-section-title"
            style={{ fontSize: 'var(--text-sm)', flex: 1 }}
          >
            Payload JSON
          </div>
          <span
            className="ab-mono"
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {json.length.toLocaleString()} chars
          </span>
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            className="ab-inline-action"
            title="Toggle line wrap"
          >
            {wrap ? 'No wrap' : 'Wrap'}
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="ab-inline-action"
            title="Copy raw payload JSON"
          >
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="ab-inline-action"
            title="Close (Esc)"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--bg-canvas)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.55,
            color: 'var(--text)',
            whiteSpace: wrap ? 'pre-wrap' : 'pre',
            wordBreak: wrap ? 'break-word' : 'normal',
            overflow: 'auto',
            flex: 1,
          }}
        >
          {json}
        </pre>
      </div>
    </>,
    document.body,
  )
}

// ─── Top-level object → key/value rows ──────────────────────────────────

function ObjectKeyValueList({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
        Empty object.
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, max-content) 1fr',
        columnGap: 'var(--space-3)',
        rowGap: 'var(--space-1_5)',
        alignItems: 'baseline',
      }}
    >
      {entries.map(([k, v]) => (
        <KeyValueRow key={k} k={k} v={v} />
      ))}
    </div>
  )
}

function KeyValueRow({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <div
        className="ab-mono"
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          paddingTop: 'var(--space-0_5)',
          wordBreak: 'break-word',
        }}
      >
        {k}
      </div>
      <div style={{ minWidth: 0 }}>
        <ValueBlock value={v} />
      </div>
    </>
  )
}

// ─── Per-value rendering ────────────────────────────────────────────────

function ValueBlock({ value }: { value: unknown }) {
  if (value === null) return <Atom>null</Atom>
  if (value === undefined) return <Atom dim>undefined</Atom>

  if (typeof value === 'string') return <StringValue value={value} />

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <Atom>{String(value)}</Atom>
  }

  // A nested inspection report (e.g. the `output` of a `run.tool.result`)
  // renders formatted, not as raw JSON.
  if (looksLikeInspectionReport(value)) {
    return <CodebaseInspectionReportView report={value} />
  }

  // Object or array: render as compact JSON in its own pane.
  return <NestedJson value={value} />
}

function Atom({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <span
      className="ab-mono"
      style={{
        fontSize: 'var(--text-xs)',
        color: dim ? 'var(--text-muted)' : 'var(--text)',
      }}
    >
      {children}
    </span>
  )
}

function StringValue({ value }: { value: string }) {
  const long = value.length > LONG_STRING_PREVIEW || value.includes('\n')
  const [expanded, setExpanded] = useState(false)
  if (!long) {
    return (
      <span
        className="ab-mono"
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text)',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </span>
    )
  }
  return (
    <div>
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-2) var(--space-2_5)',
          background: 'var(--code-well)',
          border: '1px solid var(--code-well-border)',
          borderRadius: 'var(--radius)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          maxHeight: expanded ? NESTED_MAX_HEIGHT : 96,
          overflow: 'auto',
        }}
      >
        {value}
      </pre>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="ab-inline-action"
        style={{ marginTop: 'var(--space-1)' }}
      >
        {expanded
          ? 'Show less'
          : `Show all (${value.length.toLocaleString()} chars)`}
      </button>
    </div>
  )
}

function NestedJson({ value }: { value: unknown }) {
  const json = useMemo(() => safeStringify(value), [value])
  const long =
    json.length > LONG_STRING_PREVIEW * 2 || json.split('\n').length > 8
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-2) var(--space-2_5)',
          background: 'var(--code-well)',
          border: '1px solid var(--code-well-border)',
          borderRadius: 'var(--radius)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          maxHeight: expanded || !long ? NESTED_MAX_HEIGHT : 120,
          overflow: 'auto',
        }}
      >
        {json}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="ab-inline-action"
          style={{ marginTop: 'var(--space-1)' }}
        >
          {expanded
            ? 'Collapse'
            : `Expand (${json.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
