/**
 * Toast event store. Lives in its own module so toast.tsx can be a
 * components-only file (Vite fast-refresh rule).
 */

export type ToastKind = 'success' | 'error' | 'info'
export interface ToastEntry {
  id: number
  kind: ToastKind
  msg: string
}

let nextId = 1
const listeners = new Set<(entries: readonly ToastEntry[]) => void>()
let entries: ToastEntry[] = []

function notify() {
  for (const l of listeners) l(entries)
}

export function pushToast(kind: ToastKind, msg: string): void {
  const id = nextId++
  entries = [...entries, { id, kind, msg }]
  notify()
  setTimeout(() => {
    entries = entries.filter((e) => e.id !== id)
    notify()
  }, 4000)
}

export function dismissToast(id: number): void {
  entries = entries.filter((e) => e.id !== id)
  notify()
}

export function subscribeToasts(
  cb: (entries: readonly ToastEntry[]) => void,
): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const toast = {
  success: (msg: string) => pushToast('success', msg),
  error: (msg: string) => pushToast('error', msg),
  info: (msg: string) => pushToast('info', msg),
}
