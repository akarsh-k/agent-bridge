/**
 * Tiny kebab menu used on list rows. Anchored popover portalled to
 * document.body so it escapes ancestor `overflow: hidden` /
 * `backdrop-filter` containing blocks (the menu was being clipped by
 * `.ab-list-card { overflow: hidden }` on the last row).
 *
 * Click-outside + Esc close, items get a destructive flag.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface RowMenuItem {
  label: ReactNode
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}

const MENU_WIDTH = 180
const MENU_GAP = 6

export function RowMenu({
  items,
  align = 'right',
}: {
  items: ReadonlyArray<RowMenuItem>
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  )

  useEffect(() => {
    if (!open) return
    const place = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const top = rect.bottom + MENU_GAP
      const left =
        align === 'right'
          ? Math.max(8, rect.right - MENU_WIDTH)
          : Math.min(window.innerWidth - MENU_WIDTH - 8, rect.left)
      setCoords({ top, left })
    }
    place()
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (popupRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, align])

  return (
    <div
      style={{ display: 'inline-flex' }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ab-icon-btn"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          setOpen((v) => !v)
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx={5} cy={12} r={1.6} />
          <circle cx={12} cy={12} r={1.6} />
          <circle cx={19} cy={12} r={1.6} />
        </svg>
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popupRef}
            role="menu"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: MENU_WIDTH,
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-2)',
              padding: 'var(--space-1)',
              // Portaled menu: must sit above page content AND any sheet/modal
              // a triggering row lives inside (those use the 100–200 band).
              zIndex: 'var(--z-popover)',
              animation: 'ab-fadeup 140ms var(--ease-out)',
            }}
          >
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`ab-menu-item${item.destructive ? ' ab-menu-item-danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  item.onClick()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
