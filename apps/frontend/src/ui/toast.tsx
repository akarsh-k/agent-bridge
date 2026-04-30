/**
 * Toast host component. Mounted once via the app shell. Driven by
 * the imperative `toast` API in `./toast-store.ts`.
 */

import { useEffect, useState } from 'react'
import {
  dismissToast,
  subscribeToasts,
  type ToastEntry,
} from './toast-store'
import { CloseIcon } from './icons'

const VISIBLE_CAP = 3

export function ToastHost() {
  const [list, setList] = useState<readonly ToastEntry[]>([])
  useEffect(() => subscribeToasts(setList), [])
  if (list.length === 0) return null
  // Show the most recent N. Older ones queue and get rendered as
  // they age out; the user sees the freshest signal without losing
  // history when batches fire (e.g. drag-reorder of skills).
  const visible = list.slice(-VISIBLE_CAP)
  const overflow = list.length - visible.length
  return (
    <div className="ab-toast-host">
      {overflow > 0 && (
        <div
          className="ab-toast"
          style={{
            background: 'var(--surface-hi)',
            color: 'var(--text-muted)',
            fontSize: 12,
            border: '1px solid var(--border)',
          }}
        >
          +{overflow} earlier
        </div>
      )}
      {visible.map((t) => (
        <div key={t.id} className={`ab-toast ab-toast-${t.kind}`}>
          <span className="ab-pulse-dot" />
          <span style={{ flex: 1 }}>{t.msg}</span>
          <button
            type="button"
            className="ab-icon-btn"
            style={{ width: 22, height: 22 }}
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <CloseIcon width={12} height={12} strokeWidth={2.4} />
          </button>
        </div>
      ))}
    </div>
  )
}
