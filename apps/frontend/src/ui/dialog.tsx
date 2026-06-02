/**
 * Centered confirm dialog. Mounts once at the app root via
 * <DialogHost />. Driven by `confirmDialog(...)` from
 * `./dialog-store.ts`.
 */

import { useEffect, useRef, useState } from 'react'
// `useState` is used for the confirmText input value below.
import {
  resolveDialog,
  subscribeDialogs,
  type PendingConfirm,
} from './dialog-store'
import { Button } from './button'

export function DialogHost() {
  const [pending, setPending] = useState<readonly PendingConfirm[]>([])
  useEffect(() => subscribeDialogs(setPending), [])

  // Show one at a time — newest last (queue).
  const top = pending[0]
  return top ? <ConfirmModal entry={top} /> : null
}

function ConfirmModal({ entry }: { entry: PendingConfirm }) {
  const { id, req } = entry
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [typed, setTyped] = useState('')
  // Countdown for the confirmDelaySec safety hold. Ticks every 250ms
  // for smoother visual change; the button stays disabled while
  // `secondsLeft > 0`.
  const [secondsLeft, setSecondsLeft] = useState(req.confirmDelaySec ?? 0)
  useEffect(() => {
    if (!req.confirmDelaySec) return
    const start = Date.now()
    const total = req.confirmDelaySec * 1000
    const handle = setInterval(() => {
      const left = Math.max(0, Math.ceil((total - (Date.now() - start)) / 1000))
      setSecondsLeft(left)
      if (left <= 0) clearInterval(handle)
    }, 250)
    return () => clearInterval(handle)
  }, [req.confirmDelaySec])
  const confirmEnabled =
    (!req.confirmText || typed === req.confirmText) && secondsLeft <= 0

  // Backwards-compat: legacy `destructive: true` maps to the
  // destructive kind. Otherwise default to whatever was passed.
  const kind: 'default' | 'warning' | 'destructive' = req.kind
    ? req.kind
    : req.destructive
      ? 'destructive'
      : 'default'

  // Trap focus + handle Esc.
  // We register on the capture phase + call stopPropagation so the
  // still-mounted Sheet's bubble-phase Esc handler doesn't ALSO fire
  // and re-trigger useDirtyClose's confirm prompt — that race was
  // queueing a second discard dialog that lingered after the first.
  useEffect(() => {
    if (req.confirmText) {
      inputRef.current?.focus()
    } else {
      confirmRef.current?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        resolveDialog(id, false)
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKey, { capture: true })
  }, [id, req.confirmText])

  return (
    <>
      <div
        className="ab-sheet-backdrop is-open"
        onClick={() => resolveDialog(id, false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`ab-dialog-title-${id}`}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(440px, calc(100vw - var(--space-8)))',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          /* z-index 102: above the .ab-sheet-backdrop (100) + .ab-sheet (101).
           * Intentional deviation from --z-modal (50) until shell.css backdrop
           * migrates to --z-overlay (40) so the token scale is self-consistent. */
          zIndex: 102,
          padding: 'var(--space-6) var(--space-6) var(--space-5)',
          animation: 'ab-dialog-in var(--dur-2) var(--ease-out)',
        }}
      >
        <div
          id={`ab-dialog-title-${id}`}
          className="ab-section-title"
          style={{ marginBottom: 'var(--space-2)' }}
        >
          {req.title}
        </div>
        {req.body && (
          <div
            className="ab-section-sub"
            style={{ marginBottom: 'var(--space-5)', lineHeight: 1.55 }}
          >
            {req.body}
          </div>
        )}
        {req.confirmText && (
          <div className="ab-field" style={{ marginBottom: 'var(--space-5)' }}>
            <label className="ab-field-label" htmlFor={`ab-dialog-input-${id}`}>
              Type <code className="ab-mono">{req.confirmText}</code> to confirm
            </label>
            <input
              id={`ab-dialog-input-${id}`}
              ref={inputRef}
              className="ab-input ab-mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmEnabled) {
                  e.preventDefault()
                  resolveDialog(id, true)
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
          }}
        >
          <Button
            variant="ghost"
            ref={cancelRef}
            onClick={() => resolveDialog(id, false)}
          >
            {req.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={
              kind === 'destructive'
                ? 'danger'
                : kind === 'warning'
                  ? 'secondary'
                  : 'primary'
            }
            className={kind === 'warning' ? 'ab-btn-warning' : undefined}
            ref={confirmRef}
            disabled={!confirmEnabled}
            onClick={() => resolveDialog(id, true)}
          >
            {(req.confirmLabel ??
              (kind === 'destructive'
                ? 'Delete'
                : kind === 'warning'
                  ? 'Continue'
                  : 'Confirm')) + (secondsLeft > 0 ? ` (${secondsLeft})` : '')}
          </Button>
        </div>
      </div>
    </>
  )
}
