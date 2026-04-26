/**
 * Canonical queue names for the worker. Keep this list tiny — each new queue
 * is a separate BullMQ `Worker` instance below. When the backend starts
 * enqueueing real jobs (Phase 1+), these names should move to
 * `@agent-bridge/shared` so producer and consumer stay in sync.
 *
 * Naming convention: `agent-bridge.<queue>`. BullMQ v5 disallows `:` in queue
 * names (reserved for its internal key structure), so we use `.` as the
 * namespace separator.
 */

export const QUEUE_NAMES = {
  ping: 'agent-bridge.ping',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]
