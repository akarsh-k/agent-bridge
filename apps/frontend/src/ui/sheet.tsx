/**
 * Right-slide overlay — the canonical "Add a thing" surface across
 * the app. Replaces every centered "create" / "connect" modal.
 *
 * Width: defaults to 480px, user can drag the LEFT edge to widen up
 * to 720px. Persisted in localStorage so the next sheet opens at the
 * same width.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from './icons'
import { Button } from './button'
import { Tooltip } from './tooltip'

const MIN_WIDTH = 420
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 480
const WIDTH_KEY = 'ab.sheet.width'

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH) return v
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH
}

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  primaryLabel?: string
  onPrimary?: () => void
  primaryBusy?: boolean
  primaryDisabled?: boolean
  cancelLabel?: string
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  primaryLabel,
  onPrimary,
  primaryBusy,
  primaryDisabled,
  cancelLabel = 'Cancel',
}: SheetProps) {
  const [width, setWidth] = useState(readWidth)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startX = e.clientX
    const startW = width
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return
      const dx = startX - ev.clientX // dragging left = grow
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + dx))
      setWidth(next)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      try {
        // Read latest value off the DOM since closure captures stale `width`.
        // Use the React state via the setter callback would require a ref;
        // re-reading from getBoundingClientRect is the simplest source of truth.
        const persisted = readPersist()
        localStorage.setItem(WIDTH_KEY, String(persisted))
      } catch {
        // ignore
      }
    }
    // Capture-the-current-width by reading state via a closure ref
    const readPersist = () => {
      const el = document.querySelector('.ab-sheet') as HTMLElement | null
      if (!el) return DEFAULT_WIDTH
      return Math.round(el.getBoundingClientRect().width)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return (
    <>
      <div
        className={'ab-sheet-backdrop' + (open ? ' is-open' : '')}
        onClick={onClose}
      />
      <aside
        className={'ab-sheet' + (open ? ' is-open' : '')}
        aria-hidden={!open}
        role="dialog"
        aria-modal="true"
        style={{ width }}
      >
        <div
          className="ab-sheet-resize"
          onPointerDown={startDrag}
          aria-hidden="true"
        />
        <div className="ab-sheet-head">
          <div>
            <div className="ab-sheet-title">{title}</div>
            {subtitle && (
              <div className="ab-field-help" style={{ marginTop: 2 }}>
                {subtitle}
              </div>
            )}
          </div>
          <Tooltip label="Close (Esc)" side="left">
            <button
              type="button"
              className="ab-icon-btn"
              onClick={onClose}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </Tooltip>
        </div>
        <div className="ab-sheet-body">{children}</div>
        {primaryLabel && (
          <div className="ab-sheet-foot">
            <Button variant="ghost" onClick={onClose}>
              {cancelLabel}
            </Button>
            <Button
              variant="primary"
              onClick={onPrimary}
              disabled={primaryDisabled || primaryBusy}
            >
              {primaryBusy ? 'Working…' : primaryLabel}
            </Button>
          </div>
        )}
      </aside>
    </>
  )
}
