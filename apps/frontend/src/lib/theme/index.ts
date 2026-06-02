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

/* -------------------------------------------------------------------------
 * Accent
 *
 * The accent ramp is derived in OKLCH from `--accent-h` / `--accent-c`
 * (see tokens.css), so a pick is just two numbers written to <html>. The
 * zero-flicker bootstrap in index.html applies the stored choice before
 * paint; this store keeps React in sync and persists changes.
 * ------------------------------------------------------------------------- */

export interface AccentPreset {
  key: string
  label: string
  /** OKLCH hue (deg) + chroma the whole ramp derives from. */
  h: number
  c: number
}

/**
 * Curated, presets-only palette. Deliberately NON-violet (the agentic-AI
 * reflex), spanning cool -> warm -> neutral. Every preset is WCAG-AA verified
 * in both themes. KEEP IN SYNC with the ACCENTS map in index.html.
 */
export const ACCENTS: readonly AccentPreset[] = [
  { key: 'teal', label: 'Teal', h: 195, c: 0.125 },
  { key: 'cyan', label: 'Cyan', h: 208, c: 0.115 },
  { key: 'cobalt', label: 'Cobalt', h: 248, c: 0.15 },
  { key: 'amber', label: 'Amber', h: 82, c: 0.135 },
  { key: 'coral', label: 'Coral', h: 32, c: 0.15 },
  { key: 'slate', label: 'Slate', h: 245, c: 0.035 },
]
export const DEFAULT_ACCENT: AccentPreset = ACCENTS[0]!

const ACCENT_KEY = 'ab.accent'
const ACCENT_EVENT = 'agentbridge:accent'

/** Resolve the stored accent to a palette entry. Returns the same stable
 *  object reference for a given key, so it is safe as a store snapshot. */
export function readStoredAccent(): AccentPreset {
  try {
    const v = localStorage.getItem(ACCENT_KEY)
    const found = ACCENTS.find((a) => a.key === v)
    if (found) return found
  } catch {
    // ignore
  }
  return DEFAULT_ACCENT
}

function applyAccent(a: AccentPreset) {
  const root = document.documentElement
  root.style.setProperty('--accent-h', String(a.h))
  root.style.setProperty('--accent-c', String(a.c))
}

export function setAccent(key: string) {
  const a = ACCENTS.find((x) => x.key === key) ?? DEFAULT_ACCENT
  try {
    localStorage.setItem(ACCENT_KEY, a.key)
  } catch {
    // ignore
  }
  applyAccent(a)
  window.dispatchEvent(new Event(ACCENT_EVENT))
}

function subscribeAccent(cb: () => void): () => void {
  window.addEventListener(ACCENT_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(ACCENT_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useAccent(): {
  accent: AccentPreset
  setAccent: (key: string) => void
} {
  const accent = useSyncExternalStore(
    subscribeAccent,
    readStoredAccent,
    () => DEFAULT_ACCENT,
  )
  const set = useCallback((key: string) => setAccent(key), [])
  return { accent, setAccent: set }
}
