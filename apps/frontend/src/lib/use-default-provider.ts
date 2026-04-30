/**
 * Workspace-preferred LLM provider — used as the initial value in
 * the New-agent flow. There's no backend setting for this; the
 * choice is local to the browser.
 */

import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'ab.default-provider-id'
const EVENT = 'agentbridge:default-provider'

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useDefaultProviderId(): {
  defaultProviderId: string | null
  setDefaultProviderId: (id: string | null) => void
} {
  const id = useSyncExternalStore(subscribe, read, () => null)
  const set = useCallback((next: string | null) => {
    try {
      if (next === null) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return { defaultProviderId: id, setDefaultProviderId: set }
}
