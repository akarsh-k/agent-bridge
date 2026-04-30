/**
 * Manual sidebar collapse state, persisted in localStorage.
 *
 * Defaults to `null` ("auto") which means: follow the
 * `@media (max-width: 1080px)` rule. When the user explicitly
 * toggles, the choice is sticky across reloads.
 */

import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'ab.sidebar.collapsed'
const EVENT = 'agentbridge:sidebar'

type Stored = 'collapsed' | 'expanded' | null

function read(): Stored {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'collapsed' || v === 'expanded') return v
  } catch {
    // ignore
  }
  return null
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useSidebarState(): {
  override: Stored
  setOverride: (next: Stored) => void
  toggle: () => void
} {
  const override = useSyncExternalStore(subscribe, read, () => null)
  const setOverride = useCallback((next: Stored) => {
    try {
      if (next === null) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  const toggle = useCallback(() => {
    setOverride(read() === 'collapsed' ? 'expanded' : 'collapsed')
  }, [setOverride])
  return { override, setOverride, toggle }
}
