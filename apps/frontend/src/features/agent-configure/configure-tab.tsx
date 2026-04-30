/**
 * Configure tab — everything the agent IS: identity, prompt, model,
 * memory. Composes the existing BuildTab (Identity + Model with
 * autosave) and MemoryTab so each component continues owning its
 * own state, while the page surfaces them under one tab heading.
 */

import { BuildTab } from '../agent-builder/build-tab'
import { MemoryTab } from '../agent-memory/memory-tab'

export function ConfigureTab({ agentId }: { agentId: string }) {
  return (
    <div>
      <BuildTab agentId={agentId} />
      <MemoryTab agentId={agentId} />
    </div>
  )
}
