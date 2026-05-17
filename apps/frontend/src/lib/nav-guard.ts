/**
 * Navigation guard store. One or more dirty forms can register
 * handlers under a stable id; any subsequent in-app navigation
 * routes through `requestNavigation`, which (when any guard is
 * active) holds the navigation and notifies subscribers — the global
 * modal — so the user can choose Save / Discard / Stay across every
 * dirty section at once.
 *
 * Design notes:
 *   - Multiple guards can coexist (Identity + Memory both dirty under
 *     the same Configure tab, for example). Each registers under a
 *     unique `id`; re-registering with the same id replaces the
 *     previous handlers (used by the hook to swap stale closures).
 *   - Held navigations capture their `proceed` callback at request
 *     time. When the user resolves the modal, we call the stored
 *     callback as-is — no re-check against current guards, which
 *     keeps the post-save → proceed flow free of races.
 *   - Save iterates with `Promise.allSettled`: if any guard's save
 *     throws, the modal stays open with the failures surfaced so the
 *     user can decide. Sections that succeeded stay saved (idempotent
 *     PATCH on a different agent field is the worst case).
 *   - Browser-close is not in scope here; that's the native
 *     beforeunload prompt the dirty form sets up itself.
 *   - Browser back/forward (popstate) is also out of scope for the
 *     first cut; URL changes triggered by the user via the back
 *     button bypass `requestNavigation`.
 */

export interface NavGuardHandlers {
  /** Human label for the dirty section ("Identity", "Memory") —
   *  surfaced by the save-dock so the user can see at a glance what's
   *  still pending. Stable per-id; updating it is fine. */
  label: string
  /** Persist the in-flight edits. Must throw on failure. */
  save: () => Promise<void>
  /** Drop in-flight edits and revert the form. */
  discard: () => void
}

export interface RegisteredGuard {
  id: string
  handlers: NavGuardHandlers
}

export interface PendingNav {
  /** Snapshot of the guards at the time the nav was held. New
   *  registrations after this point don't affect the held decision. */
  guards: readonly RegisteredGuard[]
  /** Execute the held-up navigation. Idempotent (clears pending first). */
  proceed: () => void
  /** Cancel the held-up navigation. Idempotent. */
  cancel: () => void
}

const guards = new Map<string, NavGuardHandlers>()
let pending: PendingNav | null = null
const subscribers = new Set<(p: PendingNav | null) => void>()
const guardSubscribers = new Set<() => void>()

export function registerNavGuard(
  id: string,
  handlers: NavGuardHandlers,
): () => void {
  guards.set(id, handlers)
  notifyGuards()
  return () => {
    // Only unregister if no one's replaced the slot in the meantime.
    // This matters when a hook re-registers with the same id and the
    // old cleanup runs after the new effect.
    if (guards.get(id) === handlers) {
      guards.delete(id)
      notifyGuards()
    }
  }
}

export function hasNavGuards(): boolean {
  return guards.size > 0
}

/** Snapshot of currently-registered guards. The save-dock reads this
 *  to render the dirty-section list. */
export function getRegisteredGuards(): readonly RegisteredGuard[] {
  return Array.from(guards, ([id, handlers]) => ({ id, handlers }))
}

export function subscribeGuards(cb: () => void): () => void {
  guardSubscribers.add(cb)
  return () => {
    guardSubscribers.delete(cb)
  }
}

function notifyGuards() {
  for (const s of guardSubscribers) s()
}

/**
 * Run every guard's save in parallel. Returns the ids of any guards
 * whose save threw. Used by the save-dock's "Save all" button so the
 * user can persist everything without waiting for the nav-away modal.
 */
export async function saveAllGuards(): Promise<{
  failedIds: readonly string[]
}> {
  const snapshot = Array.from(guards.entries())
  const results = await Promise.allSettled(
    snapshot.map(([, h]) => h.save()),
  )
  const failedIds: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') failedIds.push(snapshot[i]![0])
  })
  return { failedIds }
}

/** Revert every registered guard back to its persisted state. */
export function discardAllGuards(): void {
  const snapshot = Array.from(guards.values())
  for (const h of snapshot) h.discard()
}

/**
 * Request to run `proceed` as a navigation. If any guard is active,
 * the navigation is held and the modal subscribers are notified;
 * otherwise it runs immediately.
 */
export function requestNavigation(proceed: () => void): void {
  if (guards.size === 0) {
    proceed()
    return
  }
  const snapshot: RegisteredGuard[] = []
  for (const [id, handlers] of guards) {
    snapshot.push({ id, handlers })
  }
  pending = {
    guards: snapshot,
    proceed: () => {
      if (!pending) return
      pending = null
      notify()
      proceed()
    },
    cancel: () => {
      if (!pending) return
      pending = null
      notify()
    },
  }
  notify()
}

export function getPendingNav(): PendingNav | null {
  return pending
}

export function subscribePendingNav(
  cb: (p: PendingNav | null) => void,
): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

function notify() {
  for (const s of subscribers) s(pending)
}
