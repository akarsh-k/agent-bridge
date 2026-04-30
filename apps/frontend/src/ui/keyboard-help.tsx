/**
 * Keyboard shortcuts overlay. Bound to `?` (or `Shift+/`) globally.
 * Lists every shortcut the app defines so the user can discover
 * them without hunting through docs.
 */

import { useEffect, useState } from 'react'

interface Group {
  title: string
  rows: ReadonlyArray<{ keys: ReadonlyArray<string>; label: string }>
}

const GROUPS: ReadonlyArray<Group> = [
  {
    title: 'Global',
    rows: [
      { keys: ['⌘', 'K'], label: 'Open command palette' },
      { keys: ['?'], label: 'Show this overlay' },
      { keys: ['Esc'], label: 'Close any open palette / dialog / sheet' },
    ],
  },
  {
    title: 'Command palette',
    rows: [
      { keys: ['↑', '↓'], label: 'Navigate items' },
      { keys: ['Enter'], label: 'Run highlighted item' },
    ],
  },
  {
    title: 'Chat tab',
    rows: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['Shift', 'Enter'], label: 'New line in composer' },
    ],
  },
  {
    title: 'Agent detail',
    rows: [
      { keys: ['B'], label: 'Switch to Build' },
      { keys: ['C'], label: 'Switch to Chat' },
      { keys: ['M'], label: 'Switch to Memory' },
      { keys: ['T'], label: 'Switch to Tools' },
      { keys: ['G'], label: 'Switch to Bridge tools' },
      { keys: ['L'], label: 'Switch to Logs' },
    ],
  },
]

export function KeyboardHelp() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (isTyping) return
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null
  return (
    <>
      <div
        className="ab-sheet-backdrop is-open"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: '80vh',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          zIndex: 102,
          overflow: 'hidden',
          animation: 'ab-dialog-in 200ms var(--ease-out)',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="ab-section-title">Keyboard shortcuts</div>
        </div>
        <div style={{ padding: '8px 20px 16px', overflowY: 'auto' }}>
          {GROUPS.map((g) => (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: 6,
                }}
              >
                {g.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {g.rows.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ flex: 1 }}>{r.label}</span>
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {r.keys.map((k, j) => (
                        <span key={j} className="ab-kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
