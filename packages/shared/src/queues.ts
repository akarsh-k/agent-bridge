/**
 * Canonical BullMQ queue names. Shared between producers (backend) and
 * consumers (worker) so the two processes can never drift out of sync.
 *
 * Naming convention: `agent-bridge.<queue>`. BullMQ v5 disallows `:` in queue
 * names (reserved for its internal key structure); we use `.` instead.
 *
 * Adding a queue: add an entry here, then wire a matching `Queue` in the
 * worker's `src/index.ts` and an `enqueue*` helper in the backend's
 * `src/lib/queues.ts`. No other caller should hardcode the raw string.
 *
 * Browser-safe (no imports).
 */

export const QUEUE_NAMES = {
  ping: 'agent-bridge.ping',
  cloneRepo: 'agent-bridge.clone-repo',
  pullRepo: 'agent-bridge.pull-repo',
  indexRepo: 'agent-bridge.index-repo',
  generateWiki: 'agent-bridge.generate-wiki',
  deleteRepo: 'agent-bridge.delete-repo',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]
