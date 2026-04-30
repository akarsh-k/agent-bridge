/**
 * Theme storage + hook. The actual `data-theme` attribute is set
 * synchronously by the bootstrap script in index.html before React
 * hydrates, to avoid a flash of wrong theme. This module just keeps
 * React in sync with the choice.
 */

import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
const STORAGE_KEY = 'ab.theme'
const EVENT = 'agentbridge:theme'

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // ignore
  }
  return 'system'
}

function applyToDocument(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') {
    delete root.dataset.theme
  } else {
    root.dataset.theme = theme
  }
}

export function setTheme(theme: Theme) {
  try {
    if (theme === 'system') {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, theme)
    }
  } catch {
    // ignore
  }
  applyToDocument(theme)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const theme = useSyncExternalStore(
    subscribe,
    readStored,
    () => 'system' as Theme,
  )
  const set = useCallback((t: Theme) => setTheme(t), [])
  return { theme, setTheme: set }
}
