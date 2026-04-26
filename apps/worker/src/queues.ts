/**
 * Thin re-export of the canonical queue-name map from `@agent-bridge/shared`.
 *
 * Producer (backend) and consumer (worker) share a single source of truth
 * for queue names so a rename can't split them apart. Local callers in the
 * worker keep importing from `./queues` so the import sites don't change
 * when new queues get added.
 */

export { QUEUE_NAMES, type QueueName } from '@agent-bridge/shared/queues'
