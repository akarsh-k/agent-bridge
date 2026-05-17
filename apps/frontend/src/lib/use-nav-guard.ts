/**
 * React hook for the nav-guard store. A form passes its dirty flag
 * plus save/discard handlers; the hook keeps a registration alive
 * while dirty, swapping in fresh save/discard closures without
 * unregistering on every keystroke.
 *
 * Refs hold the latest save/discard so the registered handlers
 * always see the freshest closures — without them, every render
 * would change the handler identities and the effect's dep array
 * would churn the guard map on every keystroke.
 */

import { useEffect, useRef } from 'react'
import {
  registerNavGuard,
  type NavGuardHandlers,
} from './nav-guard'

export function useNavGuard(
  id: string,
  opts: { dirty: boolean } & NavGuardHandlers,
): void {
  const saveRef = useRef(opts.save)
  const discardRef = useRef(opts.discard)
  useEffect(() => {
    saveRef.current = opts.save
  }, [opts.save])
  useEffect(() => {
    discardRef.current = opts.discard
  }, [opts.discard])

  useEffect(() => {
    if (!opts.dirty) return
    return registerNavGuard(id, {
      label: opts.label,
      save: () => saveRef.current(),
      discard: () => discardRef.current(),
    })
  }, [id, opts.label, opts.dirty])
}
