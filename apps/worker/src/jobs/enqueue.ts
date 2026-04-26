/**
 * Worker-side producer helpers. The worker is both a consumer (via the
 * `Worker` instances registered in `src/index.ts`) and a producer — e.g.
 * the clone handler auto-chains into `indexRepo` on success without a
 * round-trip through the backend.
 *
 * Lazy `Queue` instance behind a singleton so unit tests that exercise
 * the handler without real Redis don't need to mock out the BullMQ import
 * graph; the queue is only created on the first `enqueue*` call.
 *
 * Closed by `closeProducerQueues()` during shutdown.
 */

import { Queue } from 'bullmq'
import {
  QUEUE_NAMES,
  indexRepoJobSchema,
  type IndexRepoJob,
} from '@agent-bridge/shared'
import { createRedisConnection } from '../redis.js'

let cachedIndexRepoQueue: Queue | null = null

function getIndexRepoQueue(): Queue {
  if (!cachedIndexRepoQueue) {
    cachedIndexRepoQueue = new Queue(QUEUE_NAMES.indexRepo, {
      connection: createRedisConnection({ role: 'queue' }),
      defaultJobOptions: {
        // Matches the index-repo worker's config in index.ts. Analyze is
        // CPU-heavy and deterministic-on-input — retrying a failure is
        // almost always going to fail the same way, so keep attempts low.
        attempts: 1,
        removeOnComplete: { age: 24 * 3_600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    })
  }
  return cachedIndexRepoQueue
}

/**
 * Enqueue an `indexRepo` job. Called from the clone handler on success
 * (`mode='initial'`), and — for parity with the backend pattern — any
 * future worker-side flow that wants to trigger an index pass.
 */
export async function enqueueIndexRepo(
  input: IndexRepoJob,
): Promise<{ jobId: string }> {
  const payload = indexRepoJobSchema.parse(input)
  const queue = getIndexRepoQueue()
  const job = await queue.add(`index:${payload.repoId}`, payload, {
    attempts: 1,
    removeOnComplete: { age: 24 * 3_600, count: 200 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  })
  return { jobId: String(job.id ?? 'unknown') }
}

/** Close producer-side queues during shutdown. Safe to call multiple times. */
export async function closeProducerQueues(): Promise<void> {
  const q = cachedIndexRepoQueue
  cachedIndexRepoQueue = null
  if (q) await q.close()
}
