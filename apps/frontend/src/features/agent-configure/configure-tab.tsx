/**
 * Configure tab — composes the editable agent sections (Identity +
 * Provider via BuildTab, then Memory via MemoryTab) plus the
 * read-only Context Budget summary.
 *
 * Each editable section registers a nav-guard while dirty; the
 * <SaveDock /> at the bottom surfaces the cross-section dirty
 * state and offers Save all / Discard all without forcing the user
 * to navigate away to trigger persistence.
 */

import { BuildTab } from '../agent-builder/build-tab'
import { MemoryTab } from '../agent-memory/memory-tab'
import { SaveDock } from './save-dock'

export function ConfigureTab({ agentId }: { agentId: string }) {
  return (
    <div className="ab-configure-tab">
      <BuildTab agentId={agentId} />
      <MemoryTab agentId={agentId} />
      <SaveDock />
    </div>
  )
}
