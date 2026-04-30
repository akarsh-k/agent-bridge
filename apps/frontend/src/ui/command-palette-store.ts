/**
 * Tiny event bus for the global command palette. Pages can call
 * `openPalette()` from anywhere; the host listens.
 */

const listeners = new Set<() => void>()
let isOpen = false
const stateListeners = new Set<(open: boolean) => void>()

function notify() {
  for (const l of listeners) l()
}
function notifyState() {
  for (const l of stateListeners) l(isOpen)
}

export function openPalette(): void {
  isOpen = true
  notify()
  notifyState()
}
export function closePalette(): void {
  isOpen = false
  notifyState()
}
export function subscribePaletteOpen(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export function subscribePaletteState(
  cb: (open: boolean) => void,
): () => void {
  stateListeners.add(cb)
  return () => {
    stateListeners.delete(cb)
  }
}
export function getPaletteOpen(): boolean {
  return isOpen
}
