/**
 * Backend-side BullMQ producer helpers. One lazy `Queue` per queue name
 * keyed off `QUEUE_NAMES` so producer and worker stay in sync; the worker's
 * `Worker` instances subscribe to the same names (see
 * `apps/worker/src/index.ts`).
 *
 * Why lazy:
 *   - Tests that don't hit the queue don't open a Redis socket.
 *   - CI environments without Redis can still exercise the read-only routes.
 *   - Boots that miss the queue-owning route path pay no socket cost.
 *
 * `enqueueCloneRepo` is the only enqueue function today; other jobs
 * (index, wiki) will slot in here next to it.
 */

import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import {
  QUEUE_NAMES,
  cloneRepoJobSchema,
  deleteRepoJobSchema,
  generateWikiJobSchema,
  indexRepoJobSchema,
  type CloneRepoJob,
  type DeleteRepoJob,
  type GenerateWikiJob,
  type IndexRepoJob,
  type QueueName,
} from '@agent-bridge/shared'
import { env } from '../env.js'

let cachedConnection: Redis | null = null
const cachedQueues = new Map<QueueName, Queue>()

function getConnection(): Redis {
  if (!cachedConnection) {
    cachedConnection = new Redis(env.REDIS_URL, {
      // Producer-side: retries-per-request doesn't need the blocking-safe
      // defaults the worker uses; we want retry budgets here.
      maxRetriesPerRequest: 2,
    })
    cachedConnection.on('error', (err: Error) => {
      console.error('[queues] redis error:', err.message)
    })
  }
  return cachedConnection
}

function getQueue(name: QueueName): Queue {
  let queue = cachedQueues.get(name)
  if (!queue) {
    queue = new Queue(name, { connection: getConnection() })
    cachedQueues.set(name, queue)
  }
  return queue
}

/**
 * Enqueue a clone-repo job. Validates the payload via Zod so a schema drift
 * between producer and consumer shows up at the call site, not as a cryptic
 * worker-side parse error hours later.
 *
 * Returns the BullMQ job id so the route can surface it to the client — the
 * client mostly just needs the SSE stream id, but the job id is useful for
 * admin UIs and debugging.
 */
export async function enqueueCloneRepo(
  input: CloneRepoJob,
): Promise<{ jobId: string }> {
  const payload = cloneRepoJobSchema.parse(input)
  const queue = getQueue(QUEUE_NAMES.cloneRepo)
  const job = await queue.add(`clone:${payload.repoId}`, payload, {
    // One retry on transient failures; matches the worker's default config.
    // Long backoff gives git credential helpers time to re-settle.
    attempts: 2,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 24 * 3_600, count: 200 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  })
  return { jobId: String(job.id ?? 'unknown') }
}

/**
 * Enqueue an `indexRepo` job from the HTTP layer. Used for manual
 * re-index (`mode='reindex'`) and retry-after-error flows. The initial
 * clone→index auto-chain happens inside the worker (see
 * `apps/worker/src/jobs/clone-repo.ts`) and does NOT go through here.
 *
 * Retries = 1 because `gitnexus analyze` is deterministic on its input:
 * failures almost always fail the same way, and a long retry window
 * leaves the UI stuck on `indexing` past the point where the user
 * deserves an error banner.
 */
export async function enqueueIndexRepo(
  input: IndexRepoJob,
): Promise<{ jobId: string }> {
  const payload = indexRepoJobSchema.parse(input)
  const queue = getQueue(QUEUE_NAMES.indexRepo)
  const job = await queue.add(`index:${payload.repoId}`, payload, {
    attempts: 1,
    removeOnComplete: { age: 24 * 3_600, count: 200 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  })
  return { jobId: String(job.id ?? 'unknown') }
}

/**
 * Enqueue a `generateWiki` job from the HTTP layer. Wiki generation is
 * always user-initiated — no auto-chain off the index worker — because
 * each run charges the configured LLM provider per page.
 *
 * Retries = 2 with exponential backoff: a transient 429 / upstream 5xx
 * is worth one auto-retry, but beyond that the cost-per-attempt is real
 * money and the failure mode is usually a config issue (bad model name,
 * missing apiKey) that retry can't fix. Matches the worker's queue
 * config in `apps/worker/src/index.ts`.
 */
export async function enqueueGenerateWiki(
  input: GenerateWikiJob,
): Promise<{ jobId: string }> {
  const payload = generateWikiJobSchema.parse(input)
  const queue = getQueue(QUEUE_NAMES.generateWiki)
  const job = await queue.add(`wiki:${payload.repoId}`, payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 24 * 3_600, count: 200 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  })
  return { jobId: String(job.id ?? 'unknown') }
}

/**
 * Enqueue a `deleteRepo` job. Triggered by `DELETE /api/repos/:id` after
 * the row is soft-marked `deletion_pending=true` and `agent_repos`
 * detached. The worker waits for any in-flight clone/index/wiki for
 * this repo to drain, `rm -rf`s the on-disk source dir, then
 * hard-deletes the row.
 *
 * Retries = 2 — a transient `EBUSY`/`ENOTEMPTY` against a still-open
 * file handle is worth one auto-retry; beyond that the failure is
 * usually a permissions / disk issue that retry can't fix. Concurrency
 * 1 in the worker (see `apps/worker/src/index.ts`) so two delete jobs
 * for the same repo never race the rm.
 */
export async function enqueueDeleteRepo(
  input: DeleteRepoJob,
): Promise<{ jobId: string }> {
  const payload = deleteRepoJobSchema.parse(input)
  const queue = getQueue(QUEUE_NAMES.deleteRepo)
  const job = await queue.add(`delete:${payload.repoId}`, payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 24 * 3_600, count: 200 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  })
  return { jobId: String(job.id ?? 'unknown') }
}

/** Close all cached queues and the shared Redis connection. */
export async function closeQueues(): Promise<void> {
  const queues = [...cachedQueues.values()]
  cachedQueues.clear()
  await Promise.all(queues.map((q) => q.close()))
  if (cachedConnection) {
    const conn = cachedConnection
    cachedConnection = null
    conn.disconnect()
  }
}
