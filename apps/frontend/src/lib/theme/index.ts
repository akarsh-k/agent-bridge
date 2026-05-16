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

/**
 * Always writes a concrete `light` or `dark` value to `data-theme`,
 * never leaves it empty. Component-level `[data-theme='light']` rules
 * (chat bubble color, sidebar tuning, brand-glyph flips, …) ONLY
 * apply when the attribute is set, so leaving it empty for theme=
 * 'system' would silently disable dozens of light-theme polish rules
 * — the same trap the bootstrap script in `index.html` documents
 * inline.
 *
 * `system` means "follow the OS"; we resolve it to the current OS
 * preference here. The bootstrap script wires a live listener for
 * OS changes when no explicit choice is stored.
 */
function applyToDocument(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersLight = window.matchMedia(
      '(prefers-color-scheme: light)',
    ).matches
    root.dataset.theme = prefersLight ? 'light' : 'dark'
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
