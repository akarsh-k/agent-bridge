import { Queue, Worker } from 'bullmq'
import { env } from './env.js'
import { assertExpectedGitnexusVersion } from '@agent-bridge/shared/gitnexus'
import { ensureDataDirs } from '@agent-bridge/shared/paths'
import { loadOrCreateMasterKey } from '@agent-bridge/shared/crypto'
import { createRedisConnection } from './redis.js'
import { QUEUE_NAMES } from './queues.js'
import { handlePingJob } from './jobs/ping.js'

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

  const workers = [pingWorker] as const
  const queues = [pingQueue] as const

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
