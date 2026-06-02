/**
 * Global "unsaved changes" modal. Subscribes to the nav-guard store
 * and renders whenever a navigation is held by one or more active
 * guards. Mounted once at the app shell — never inline.
 *
 * Three actions:
 *   - Save & continue: runs every guard's save in parallel, then
 *     proceeds. If any save throws, the modal stays open with the
 *     failure surfaced; sections that succeeded stay saved.
 *   - Discard & continue: runs every guard's discard, then proceeds.
 *   - Stay: cancels the navigation.
 *
 * Stay also wires Escape and backdrop click. The modal must not be
 * dismissable to "neither save nor discard nor cancel" — those are
 * the only three outcomes that resolve the held navigation.
 */

import { useEffect, useState } from 'react'
import { Button } from './button'
import {
  type PendingNav,
  getPendingNav,
  subscribePendingNav,
} from '../lib/nav-guard'

export function NavGuardModal() {
  const [pending, setPending] = useState<PendingNav | null>(getPendingNav())
  const [busy, setBusy] = useState(false)
  const [failedIds, setFailedIds] = useState<readonly string[]>([])

  useEffect(() => subscribePendingNav(setPending), [])

  // The modal is a global host — it stays mounted and its state
  // outlives any single show/hide cycle. Reset transient UI state
  // (busy spinner, prior-failure block) whenever a fresh pending nav
  // arrives so the next cycle starts clean. "Adjust state based on
  // props" pattern — no useEffect → no cascading render churn.
  const [seenPending, setSeenPending] = useState<PendingNav | null>(pending)
  if (seenPending !== pending) {
    setSeenPending(pending)
    if (pending) {
      setBusy(false)
      setFailedIds([])
    }
  }

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        pending.cancel()
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKey, { capture: true })
  }, [pending])

  if (!pending) return null

  const onSave = async () => {
    setBusy(true)
    setFailedIds([])
    const results = await Promise.allSettled(
      pending.guards.map((g) => g.handlers.save()),
    )
    const failed: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push(pending.guards[i]!.id)
    })
    // Always reset busy — the modal is a global host (mounted once
    // at the app shell, hidden via `return null`), so its state
    // outlives any single show/hide cycle. Without this reset,
    // success leaves `busy=true` and the next time the modal
    // re-opens every button is disabled.
    setBusy(false)
    if (failed.length === 0) {
      pending.proceed()
    } else {
      // Each form's save() should have toasted its own error message;
      // we surface the section ids as a backup hint.
      setFailedIds(failed)
    }
  }

  const onDiscard = () => {
    for (const g of pending.guards) g.handlers.discard()
    pending.proceed()
  }

  const count = pending.guards.length

  return (
    <>
      <div
        className="ab-sheet-backdrop is-open"
        onClick={() => !busy && pending.cancel()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ab-navguard-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(460px, calc(100vw - var(--space-8)))',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          /* 102: above .ab-sheet-backdrop(100)+sheet(101); see dialog.tsx note */
          zIndex: 102,
          padding: 'var(--space-6) var(--space-6) var(--space-5)',
          animation: 'ab-dialog-in var(--dur-2) var(--ease-out)',
        }}
      >
        <div
          id="ab-navguard-title"
          className="ab-section-title"
          style={{ marginBottom: 'var(--space-2)' }}
        >
          {count === 1
            ? 'You have unsaved changes'
            : `You have unsaved changes in ${count} sections`}
        </div>
        <div
          className="ab-section-sub"
          style={{ marginBottom: 'var(--space-4)', lineHeight: 1.55 }}
        >
          Save them before leaving, discard them, or stay on this page to keep
          editing.
        </div>
        {failedIds.length > 0 && (
          <div
            role="alert"
            style={{
              marginBottom: 'var(--space-4)',
              padding: 'var(--space-2) var(--space-2_5)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--danger-border)',
              background: 'var(--danger-bg)',
              color: 'var(--danger)',
              fontSize: 'var(--text-xs)',
              lineHeight: 1.5,
            }}
          >
            Couldn't save: {failedIds.join(', ')}. See the error toast(s) for
            details. You can retry, discard, or stay.
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <Button
            variant="ghost"
            onClick={() => pending.cancel()}
            disabled={busy}
          >
            Stay
          </Button>
          <Button variant="secondary" onClick={onDiscard} disabled={busy}>
            Discard &amp; continue
          </Button>
          <Button
            variant="primary"
            onClick={() => void onSave()}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save & continue'}
          </Button>
        </div>
      </div>
    </>
  )
}
