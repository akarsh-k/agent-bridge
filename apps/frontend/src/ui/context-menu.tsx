/**
 * Right-click context menu. Wraps a child element. On `contextmenu`
 * event we suppress the OS menu and float our own popup at the
 * cursor — same item shape as RowMenu.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { RowMenuItem } from './row-menu'

interface CtxState {
  x: number
  y: number
}

export function ContextMenu({
  items,
  children,
}: {
  items: ReadonlyArray<RowMenuItem>
  children: ReactNode
}) {
  const [pos, setPos] = useState<CtxState | null>(null)

  useEffect(() => {
    if (!pos) return
    const onDoc = () => setPos(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [pos])

  return (
    <>
      <div
        onContextMenu={(e) => {
          e.preventDefault()
          // Clamp to viewport so the menu doesn't render off-screen.
          const x = Math.min(e.clientX, window.innerWidth - 200)
          const y = Math.min(e.clientY, window.innerHeight - 12 - items.length * 36)
          setPos({ x, y })
        }}
        style={{ display: 'contents' }}
      >
        {children}
      </div>
      {pos && (
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos.y,
            left: pos.x,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-2)',
            padding: 4,
            minWidth: 160,
            zIndex: 60,
            animation: 'ab-fadeup 120ms var(--ease-out)',
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setPos(null)
                item.onClick()
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                borderRadius: 7,
                background: 'transparent',
                border: 'none',
                color: item.destructive ? 'var(--danger)' : 'var(--text)',
                fontSize: 13,
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                opacity: item.disabled ? 0.5 : 1,
                font: 'inherit',
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = 'var(--surface-hover)')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = 'transparent')
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
