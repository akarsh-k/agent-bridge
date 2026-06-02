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
          width: 'min(520px, calc(100vw - var(--space-8)))',
          maxHeight: '80vh',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          /* 102: above .ab-sheet-backdrop(100)+sheet(101); see dialog.tsx note */
          zIndex: 102,
          overflow: 'hidden',
          animation: 'ab-dialog-in var(--dur-2) var(--ease-out)',
        }}
      >
        <div
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="ab-section-title">Keyboard shortcuts</div>
        </div>
        <div
          style={{
            padding: 'var(--space-2) var(--space-5) var(--space-4)',
            overflowY: 'auto',
          }}
        >
          {GROUPS.map((g) => (
            <div key={g.title} style={{ marginTop: 'var(--space-4)' }}>
              <div
                style={{
                  fontSize: 'var(--text-2xs)',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: 'var(--space-1_5)',
                }}
              >
                {g.title}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                }}
              >
                {g.rows.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      padding: 'var(--space-1_5) 0',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    <span style={{ flex: 1 }}>{r.label}</span>
                    <span
                      style={{ display: 'inline-flex', gap: 'var(--space-1)' }}
                    >
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
