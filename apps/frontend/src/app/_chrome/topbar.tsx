/**
 * Topbar — breadcrumbs + spacer + live-bridge chip + notifications +
 * avatar. Crumbs are computed by the layout from the current path.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RunListRow } from '@agent-bridge/shared'
import { Link } from '../../lib/link'
import { NotificationIcon } from '../../ui/icons'
import { Tooltip } from '../../ui/tooltip'
import { Pill } from '../../ui/pill'
import { ApiError, listRuns } from '../../lib/rpc'
import { navigate } from '../../lib/router'

export interface Crumb {
  label: ReactNode
  to?: string
}

export function Topbar({
  crumbs,
}: {
  crumbs: ReadonlyArray<Crumb>
}) {
  const { runningCount, errorCount, runs } = useNotificationCounts()
  const totalDot = runningCount + errorCount > 0
  const dotColor = errorCount > 0 ? 'var(--danger)' : 'var(--accent-400)'
  const tooltip =
    runningCount === 0 && errorCount === 0
      ? 'No active runs'
      : [
          runningCount > 0
            ? `${runningCount} running`
            : null,
          errorCount > 0 ? `${errorCount} recent error${errorCount === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · ')

  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const flyoutRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!flyoutOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!flyoutRef.current?.contains(e.target as Node)) {
        setFlyoutOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyoutOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [flyoutOpen])

  return (
    <header className="ab-topbar">
      <nav className="ab-breadcrumbs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={i} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {i > 0 && <span className="ab-sep">/</span>}
              {last || !c.to ? (
                <span className="ab-current">{c.label}</span>
              ) : (
                <Link to={c.to}>{c.label}</Link>
              )}
            </span>
          )
        })}
      </nav>
      <div className="ab-topbar-spacer" />
      <div ref={flyoutRef} style={{ position: 'relative' }}>
        <Tooltip label={tooltip} side="bottom">
          <button
            type="button"
            className="ab-icon-btn"
            aria-label="Notifications"
            aria-haspopup="dialog"
            aria-expanded={flyoutOpen}
            onClick={() => setFlyoutOpen((v) => !v)}
            style={{ position: 'relative' }}
          >
            <NotificationIcon />
            {totalDot && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: dotColor,
                  border: '2px solid var(--surface)',
                  boxSizing: 'content-box',
                }}
              />
            )}
          </button>
        </Tooltip>
        {flyoutOpen && (
          <NotificationFlyout
            runs={runs}
            onClose={() => setFlyoutOpen(false)}
          />
        )}
      </div>
      <div className="ab-avatar" aria-label="Account" role="img">
        AK
      </div>
    </header>
  )
}

function useNotificationCounts(): {
  runningCount: number
  errorCount: number
  runs: readonly RunListRow[]
} {
  const [state, setState] = useState<{
    runningCount: number
    errorCount: number
    runs: readonly RunListRow[]
  }>({ runningCount: 0, errorCount: 0, runs: [] })

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const res = await listRuns({ limit: 25 })
        if (!alive) return
        let running = 0
        let errors = 0
        const cutoff = Date.now() - 10 * 60 * 1000
        for (const r of res.runs) {
          if (r.status === 'running' || r.status === 'pending') running++
          if (
            (r.status === 'error' || r.status === 'aborted') &&
            Date.parse(r.startedAt) > cutoff
          ) {
            errors++
          }
        }
        setState({ runningCount: running, errorCount: errors, runs: res.runs })
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) return
      }
    }
    void tick()
    const schedule = () => {
      if (!alive) return
      timer = setTimeout(async () => {
        await tick()
        schedule()
      }, 8000)
    }
    schedule()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  return state
}

function NotificationFlyout({
  runs,
  onClose,
}: {
  runs: readonly RunListRow[]
  onClose: () => void
}) {
  // `now` is captured once when the flyout opens; it doesn't need to
  // tick — the cutoff is just for "recent". Re-rendering is fine and
  // keeps the renderer pure.
  const [now] = useState(() => Date.now())
  const interesting = runs
    .filter((r) => {
      if (r.status === 'running' || r.status === 'pending') return true
      const recent = Date.parse(r.startedAt) > now - 30 * 60 * 1000
      return recent && (r.status === 'error' || r.status === 'aborted')
    })
    .slice(0, 8)
  return (
    <div
      role="dialog"
      aria-label="Recent activity"
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        width: 360,
        maxHeight: '60vh',
        overflowY: 'auto',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-3)',
        zIndex: 60,
        padding: 4,
        animation: 'ab-fadeup 160ms var(--ease-out)',
      }}
    >
      <div
        style={{
          padding: '10px 12px 6px',
          fontSize: 12,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Recent activity
      </div>
      {interesting.length === 0 ? (
        <div
          style={{
            padding: '12px 14px 16px',
            fontSize: 13,
            color: 'var(--text-dim)',
          }}
        >
          Nothing in flight, no recent errors.
        </div>
      ) : (
        interesting.map((row) => {
          const kind: Parameters<typeof Pill>[0]['kind'] =
            row.status === 'error' || row.status === 'aborted'
              ? 'danger'
              : row.status === 'running' || row.status === 'pending'
                ? 'accent'
                : 'success'
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                onClose()
                navigate(`/agents/${row.agentId}/logs`)
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 7,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                font: 'inherit',
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = 'var(--surface-hover)')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = 'transparent')
              }
            >
              <Pill kind={kind} dot>
                {row.status}
              </Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.agentName}
                </div>
                <div
                  className="ab-mono"
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.source} ·{' '}
                  {formatRelative(Date.parse(row.startedAt))}
                  {row.errorMessage && ` · ${row.errorMessage}`}
                </div>
              </div>
            </button>
          )
        })
      )}
      <div
        style={{
          padding: '6px 10px 8px',
          borderTop: '1px solid var(--border)',
          marginTop: 4,
        }}
      >
        <button
          type="button"
          onClick={() => {
            onClose()
            navigate('/bridge#runs')
          }}
          style={{
            width: '100%',
            padding: '7px 10px',
            border: 'none',
            background: 'transparent',
            color: 'var(--accent-300)',
            fontSize: 13,
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
            borderRadius: 7,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = 'var(--surface-hover)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = 'transparent')
          }
        >
          See all activity in Bridge →
        </button>
      </div>
    </div>
  )
}

function formatRelative(ts: number): string {
  if (Number.isNaN(ts)) return ''
  const delta = Date.now() - ts
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  const m = Math.floor(delta / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
