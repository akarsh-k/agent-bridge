/**
 * Sheet/dialog close-guard — prompts before discarding unsaved
 * edits. Call `wrapClose(originalOnClose)` and pass the wrapped
 * function to the sheet — when `dirty` is true, the user gets a
 * confirm dialog; otherwise it closes immediately.
 *
 * Re-entrancy: a single in-flight ref prevents the same hook from
 * queuing a second confirm if its trigger fires twice (e.g. Esc
 * reaching both the dialog's listener AND the still-mounted sheet's
 * listener). Without it, the second prompt would linger after the
 * first resolves.
 */

import { useCallback, useRef } from 'react'
import { confirmDialog } from '../ui/dialog-store'

export function useDirtyClose(
  dirty: boolean,
  onClose: () => void,
): () => void {
  const inFlightRef = useRef(false)
  return useCallback(async () => {
    if (inFlightRef.current) return
    if (!dirty) {
      onClose()
      return
    }
    inFlightRef.current = true
    try {
      const ok = await confirmDialog({
        title: 'Discard changes?',
        body: 'You have unsaved edits in this form. Closing will lose them.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: true,
      })
      if (ok) onClose()
    } finally {
      inFlightRef.current = false
    }
  }, [dirty, onClose])
}
