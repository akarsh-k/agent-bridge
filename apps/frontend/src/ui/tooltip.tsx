/**
 * Tooltip — replaces native `title=""` on interactive controls so the
 * tooltip itself follows the design tokens (rather than the OS' yellow
 * 1990s box) and is keyboard-discoverable via focus.
 *
 * Implementation: wraps the child in a `<span>` that owns the
 * pointer/focus listeners + the bounding-rect ref. Setting it as
 * `display: 'contents'` would zero the box so we use
 * `display: 'inline-flex'` (shrink-to-fit) which preserves layout in
 * the surrounding flex/grid containers we care about.
 *
 * Open delay: 500 ms. Close delay: 100 ms.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom' | 'left' | 'right'

const OPEN_DELAY = 500
const CLOSE_DELAY = 100

export function Tooltip({
  label,
  children,
  side = 'right',
}: {
  label: ReactNode
  children: ReactNode
  side?: Side
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const compute = (): { x: number; y: number } | null => {
    const el = wrapperRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const gap = 8
    switch (side) {
      case 'top':
        return { x: r.left + r.width / 2, y: r.top - gap }
      case 'bottom':
        return { x: r.left + r.width / 2, y: r.bottom + gap }
      case 'left':
        return { x: r.left - gap, y: r.top + r.height / 2 }
      case 'right':
      default:
        return { x: r.right + gap, y: r.top + r.height / 2 }
    }
  }

  const show = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    openTimer.current = setTimeout(() => {
      setCoords(compute())
      setOpen(true)
    }, OPEN_DELAY)
  }
  const hide = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY)
  }

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    [],
  )

  // Compute popup transform — offset based on side.
  const transform =
    side === 'top'
      ? 'translate(-50%, -100%)'
      : side === 'bottom'
        ? 'translate(-50%, 0)'
        : side === 'left'
          ? 'translate(-100%, -50%)'
          : 'translate(0, -50%)'

  // Hide on any pointer-down inside the wrapper — clicking a button
  // shouldn't leave its tooltip lingering. Same on blur.
  const hideNow = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpen(false)
  }

  return (
    <>
      <span
        ref={wrapperRef}
        className="ab-tooltip-wrap"
        onMouseEnter={show}
        onMouseLeave={hide}
        onMouseDown={hideNow}
        onClick={hideNow}
        onFocus={() => {
          setCoords(compute())
          setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open &&
        coords &&
        // Portal the popup to document.body so it escapes any
        // ancestor with `backdrop-filter` / `transform` / `filter`,
        // which would otherwise capture `position: fixed` as their
        // own containing block. The sidebar uses backdrop-filter,
        // and without this the popup gets clipped by the sidebar's
        // `overflow-y: auto` and forces a scrollbar.
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              left: coords.x,
              top: coords.y,
              transform,
              background: 'var(--surface-raised)',
              color: 'var(--text)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-2)',
              padding: '5px 9px',
              fontSize: 12,
              lineHeight: 1.4,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 200,
              animation: 'ab-tooltip-in 120ms var(--ease-out)',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
