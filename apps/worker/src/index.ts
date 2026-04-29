import { Queue, Worker } from 'bullmq'
import { env } from './env.js'
import { assertExpectedGitnexusVersion } from '@agent-bridge/shared/gitnexus'
import { ensureDataDirs } from '@agent-bridge/shared/paths'
import { loadOrCreateMasterKey } from '@agent-bridge/shared/crypto'
import { createRedisConnection } from './redis.js'
import { closeDb } from './db.js'
import { closeEventBus } from './event-bus.js'
import { QUEUE_NAMES } from './queues.js'
import { handlePingJob } from './jobs/ping.js'
import { handleCloneRepoJob } from './jobs/clone-repo.js'
import { handleIndexRepoJob } from './jobs/index-repo.js'
import { handleGenerateWikiJob } from './jobs/generate-wiki.js'
import { closeProducerQueues } from './jobs/enqueue.js'

/**
 * Worker process entry point.
 *
 * Boot sequence (order matters):
 *   1. Ensure the isolated data dirs exist.
 *   2. Load (or generate) the secrets master key — fail fast if key file is
 *      corrupt rather than discovering it mid-job.
 *   3. Assert GitNexus is installed at the exact pinned version. A mismatch
 *      here means the lockfile drifted; we refuse to boot rather than
 *      silently running against an unexpected build.
 *   4. Register a BullMQ Worker per queue.
 *   5. Install signal handlers for clean shutdown (close worker → close
 *      connections → exit).
 *
 * Anything here that fails exits non-zero: dev script relies on that to
 * surface boot errors immediately.
 */

async function main(): Promise<void> {
  const dirs = ensureDataDirs()
  console.info(`[worker] data dir: ${dirs.dataDir}`)

  loadOrCreateMasterKey()

  // Resolve GitNexus against the *worker's* dependency graph, not
  // @agent-bridge/shared's — shared doesn't (and shouldn't) depend on gitnexus.
  const gitnexus = assertExpectedGitnexusVersion(import.meta.url)
  console.info(
    `[worker] gitnexus pinned at ${gitnexus.packageVersion} (${gitnexus.cliEntry})`,
  )

  const pingQueue = new Queue(QUEUE_NAMES.ping, {
    connection: createRedisConnection({ role: 'queue' }),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 24 * 3_600 },
    },
  })

  const pingWorker = new Worker(QUEUE_NAMES.ping, handlePingJob, {
    connection: createRedisConnection({ role: 'worker' }),
    concurrency: env.WORKER_CONCURRENCY,
  })

  pingWorker.on('ready', () => {
    console.info(
      `[worker:${QUEUE_NAMES.ping}] ready (concurrency=${env.WORKER_CONCURRENCY})`,
    )
  })
  pingWorker.on('completed', (job) => {
    console.info(`[worker:${QUEUE_NAMES.ping}] completed job ${job.id}`)
  })
  pingWorker.on('failed', (job, err) => {
    console.error(
      `[worker:${QUEUE_NAMES.ping}] job ${job?.id ?? '<unknown>'} failed: ${err.message}`,
    )
  })

  // ── clone-repo ────────────────────────────────────────────────────────
  // Concurrency 1 on purpose: clones are disk/network heavy and indexing
  // (Phase 2B) will want its own queue with its own limits. Running two
  // clones in parallel thrashes both resources for no wall-clock win on
  // a single-user local setup.
  const cloneRepoQueue = new Queue(QUEUE_NAMES.cloneRepo, {
    connection: createRedisConnection({ role: 'queue' }),
    defaultJobOptions: {
      // One retry on transient network errors. Three would stack onto a
      // stale credential failure and multiply the user's confusion.
      attempts: 2,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3_600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  })

  const cloneRepoWorker = new Worker(
    QUEUE_NAMES.cloneRepo,
    handleCloneRepoJob,
    {
      connection: createRedisConnection({ role: 'worker' }),
      concurrency: 1,
    },
  )

  cloneRepoWorker.on('ready', () => {
    console.info(`[worker:${QUEUE_NAMES.cloneRepo}] ready (concurrency=1)`)
  })
  cloneRepoWorker.on('completed', (job) => {
    console.info(`[worker:${QUEUE_NAMES.cloneRepo}] completed job ${job.id}`)
  })
  cloneRepoWorker.on('failed', (job, err) => {
    console.error(
      `[worker:${QUEUE_NAMES.cloneRepo}] job ${job?.id ?? '<unknown>'} failed: ${err.message}`,
    )
  })

  // ── index-repo ────────────────────────────────────────────────────────
  // Concurrency 1: `gitnexus analyze` is CPU-heavy (tree-sitter, embeddings
  // when enabled later) and writes into a shared gitnexus-home cache
  // directory. Running two analyzes in parallel thrashes CPU and can race
  // on the registry file, so we serialize for now. When we scale this
  // tier we'll shard by cache dir rather than bump concurrency.
  const indexRepoQueue = new Queue(QUEUE_NAMES.indexRepo, {
    connection: createRedisConnection({ role: 'queue' }),
    defaultJobOptions: {
      // Analyze is deterministic on its input — retries rarely flip a
      // failure into a success and they lengthen the "stuck indexing"
      // window. Keep it at 1.
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  })

  const indexRepoWorker = new Worker(
    QUEUE_NAMES.indexRepo,
    handleIndexRepoJob,
    {
      connection: createRedisConnection({ role: 'worker' }),
      concurrency: 1,
    },
  )

  indexRepoWorker.on('ready', () => {
    console.info(`[worker:${QUEUE_NAMES.indexRepo}] ready (concurrency=1)`)
  })
  indexRepoWorker.on('completed', (job) => {
    console.info(`[worker:${QUEUE_NAMES.indexRepo}] completed job ${job.id}`)
  })
  indexRepoWorker.on('failed', (job, err) => {
    console.error(
      `[worker:${QUEUE_NAMES.indexRepo}] job ${job?.id ?? '<unknown>'} failed: ${err.message}`,
    )
  })

  // ── generate-wiki ─────────────────────────────────────────────────────
  // Concurrency 1: `gitnexus wiki` is LLM-bound — every page is a separate
  // chat completion against the configured provider. Two parallel wiki
  // jobs would compete for both rate-limit headroom AND the gitnexus-home
  // config file (gitnexus persists `--api-key`/`--base-url` flags into
  // `~/.gitnexus/config.json` per run). Serialising avoids both.
  const generateWikiQueue = new Queue(QUEUE_NAMES.generateWiki, {
    connection: createRedisConnection({ role: 'queue' }),
    defaultJobOptions: {
      // Wiki gen is LLM-stochastic; one auto-retry can flip a transient
      // 429/500 into a success without thrashing the budget. Beyond that
      // the cost-per-attempt is real money — keep it bounded.
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 3_600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  })

  const generateWikiWorker = new Worker(
    QUEUE_NAMES.generateWiki,
    handleGenerateWikiJob,
    {
      connection: createRedisConnection({ role: 'worker' }),
      concurrency: 1,
    },
  )

  generateWikiWorker.on('ready', () => {
    console.info(`[worker:${QUEUE_NAMES.generateWiki}] ready (concurrency=1)`)
  })
  generateWikiWorker.on('completed', (job) => {
    console.info(
      `[worker:${QUEUE_NAMES.generateWiki}] completed job ${job.id}`,
    )
  })
  generateWikiWorker.on('failed', (job, err) => {
    console.error(
      `[worker:${QUEUE_NAMES.generateWiki}] job ${job?.id ?? '<unknown>'} failed: ${err.message}`,
    )
  })

  const workers = [
    pingWorker,
    cloneRepoWorker,
    indexRepoWorker,
    generateWikiWorker,
  ] as const
  const queues = [
    pingQueue,
    cloneRepoQueue,
    indexRepoQueue,
    generateWikiQueue,
  ] as const

  await pingQueue.add(
    'boot-smoke',
    { note: 'boot-smoke-test', issuedAt: Date.now() },
    { removeOnComplete: true },
  )
  console.info('[worker] enqueued boot-smoke ping job')

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.info(`[worker] ${signal} received — draining…`)

    const forceExit = setTimeout(() => {
      console.error('[worker] shutdown timeout — forcing exit')
      process.exit(1)
    }, 10_000)
    forceExit.unref()

    try {
      await Promise.all(workers.map((w) => w.close()))
      await Promise.all(queues.map((q) => q.close()))
      await closeProducerQueues()
      await closeEventBus()
      await closeDb()
      console.info('[worker] closed cleanly')
      process.exit(0)
    } catch (err) {
      console.error('[worker] error during shutdown:', err)
      process.exit(1)
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void shutdown(sig)
    })
  }

  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaughtException:', err)
    void shutdown('SIGTERM')
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandledRejection:', reason)
  })
}

main().catch((err) => {
  console.error('[worker] fatal boot error:', err)
  process.exit(1)
})
