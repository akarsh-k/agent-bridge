/**
 * Save dock — sticky footer that surfaces every dirty section in the
 * page and offers a single Save / Discard action across all of them.
 *
 * The dock is the page-level answer to "you have unsaved work":
 *   - When clean, it renders nothing (zero footprint).
 *   - When any guard is dirty, it slides in from the bottom with the
 *     list of dirty section labels and two actions: Discard all,
 *     Save all.
 *
 * Per-section "Unsaved" dots remain in the section headers — those
 * are point-of-interaction confirmation for the section being
 * edited. The dock is the cross-section overview + power-user
 * shortcut.
 *
 * The nav-guard modal still fires if the user navigates away
 * without using the dock; this dock is the explicit-save path that
 * lives alongside it.
 */

import { useEffect, useState } from 'react'
import { Button } from '../../ui/button'
import { toast } from '../../ui/toast-store'
import {
  type RegisteredGuard,
  discardAllGuards,
  getRegisteredGuards,
  saveAllGuards,
  subscribeGuards,
} from '../../lib/nav-guard'

export function SaveDock() {
  const [guards, setGuards] = useState<readonly RegisteredGuard[]>(
    getRegisteredGuards(),
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return subscribeGuards(() => {
      setGuards(getRegisteredGuards())
    })
  }, [])

  if (guards.length === 0) return null

  const labels = guards.map((g) => g.handlers.label)
  const labelText =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`

  const onSave = async () => {
    setBusy(true)
    try {
      const { failedIds } = await saveAllGuards()
      if (failedIds.length === 0) {
        toast.success('All changes saved')
      }
      // Per-section save() handlers already toasted their own
      // failures; no need to duplicate that here.
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = () => {
    discardAllGuards()
  }

  return (
    <div className="ab-save-dock" role="status" aria-live="polite">
      <div className="ab-save-dock-inner">
        <span className="ab-save-dock-status">
          <span className="ab-save-dock-dot" aria-hidden="true" />
          <span className="ab-save-dock-label">
            Unsaved in <strong>{labelText}</strong>
          </span>
        </span>
        <div className="ab-save-dock-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={busy}
          >
            Discard all
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onSave()}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save all'}
          </Button>
        </div>
      </div>
    </div>
  )
}
