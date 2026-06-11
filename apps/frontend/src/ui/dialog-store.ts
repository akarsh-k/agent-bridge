/**
 * Imperative confirm-dialog API. Mounted via <DialogHost />.
 * Replaces every window.confirm() call.
 */

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /**
   * Visual treatment.
   * - `default`  — neutral primary. "Are you sure you want to do X?"
   * - `warning`  — amber primary, used when the action is non-
   *                destructive but has downstream consequences
   *                (e.g. agent slug change → IDEs need to reconnect).
   * - `destructive` — coral/red, used for deletes.
   *
   * Backwards-compat: callers can keep passing `destructive: true`
   * which is normalised to `kind: 'destructive'`.
   */
  kind?: 'default' | 'warning' | 'destructive'
  destructive?: boolean
  /**
   * If set, the dialog renders an Input field and the confirm
   * button stays disabled until the user types this exact string.
   * Used for high-blast-radius deletes.
   */
  confirmText?: string
  /**
   * Optional safety hold — number of seconds to disable the confirm
   * button after the dialog opens. The button counts down: "Delete
   * (2)", "Delete (1)", then becomes clickable. Used to slow down
   * reflexive double-clicks on destructive actions.
   */
  confirmDelaySec?: number
  /**
   * Optional checkbox rendered between the body and the buttons. Its
   * final state comes back on `confirmDialogEx`'s result (`checked`
   * is false when the dialog is cancelled). Used for "do X, and also
   * Y?" choices like the upload dialog's context-notes opt-in.
   */
  checkbox?: { label: string; hint?: string; initial?: boolean }
}

export interface ConfirmResult {
  ok: boolean
  checked: boolean
}

interface PendingConfirm {
  id: number
  req: ConfirmRequest
  resolve: (result: ConfirmResult) => void
}

let nextId = 1
const listeners = new Set<(pending: readonly PendingConfirm[]) => void>()
let pending: PendingConfirm[] = []

function notify() {
  for (const l of listeners) l(pending)
}

export function subscribeDialogs(
  cb: (pending: readonly PendingConfirm[]) => void,
): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function resolveDialog(id: number, ok: boolean, checked = false): void {
  const entry = pending.find((p) => p.id === id)
  if (!entry) return
  // Replace `pending` with a fresh array reference (NOT splice) so
  // React's setState detects the change. Mutating in place left the
  // listener seeing the same array identity and skipping the
  // re-render — the dialog never unmounted.
  pending = pending.filter((p) => p.id !== id)
  entry.resolve({ ok, checked })
  notify()
}

/** Confirm dialog that also reports the `checkbox` state. */
export function confirmDialogEx(req: ConfirmRequest): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    const id = nextId++
    pending = [...pending, { id, req, resolve }]
    notify()
  })
}

export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return confirmDialogEx(req).then((r) => r.ok)
}

export type { PendingConfirm }
