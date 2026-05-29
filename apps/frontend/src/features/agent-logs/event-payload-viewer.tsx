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
          padding: '10px 14px',
          color: 'var(--text-muted)',
          fontSize: 12,
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
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
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
          fontSize: 12,
          fontStyle: 'italic',
        }}
      >
        No payload.
      </div>
    )
  }
  return isPlainObject(payload) ? (
    <ObjectKeyValueList obj={payload} />
  ) : (
    <ValueBlock value={payload} />
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
        style={{ zIndex: 200 }}
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
          width: 'min(1200px, calc(100vw - 48px))',
          height: 'min(820px, calc(100vh - 48px))',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          zIndex: 201,
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
            gap: 12,
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-hi)',
          }}
        >
          <div
            id={titleId}
            className="ab-section-title"
            style={{ fontSize: 13, flex: 1 }}
          >
            Payload JSON
          </div>
          <span
            className="ab-mono"
            style={{
              fontSize: 11,
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
            padding: '14px 18px',
            background: 'var(--bg-canvas)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
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
      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
        Empty object.
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, max-content) 1fr',
        columnGap: 14,
        rowGap: 6,
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
          fontSize: 11,
          color: 'var(--text-muted)',
          paddingTop: 2,
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

  // Object or array: render as compact JSON in its own pane.
  return <NestedJson value={value} />
}

function Atom({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <span
      className="ab-mono"
      style={{
        fontSize: 12,
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
          fontSize: 12,
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
          padding: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
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
        style={{ marginTop: 4 }}
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
          padding: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
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
          style={{ marginTop: 4 }}
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
