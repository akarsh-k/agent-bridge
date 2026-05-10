import { createDb, type AgentBridgeDb } from '@agent-bridge/db'
import { env } from './env.js'

/**
 * Worker-owned Postgres pool. Lazy so a boot without DB (e.g. smoke)
 * doesn't open a dangling pool, and closed from `index.ts` during
 * shutdown so the process exits cleanly.
 *
 * Kept small by default: clone/index jobs hold a connection for the job's
 * full duration, and the worker also owns BullMQ + Redis sockets —
 * exhausting the pool is much worse here than a bit of serialisation.
 */

let cachedDb: AgentBridgeDb | null = null

export function getDb(): AgentBridgeDb {
  if (!cachedDb) {
    cachedDb = createDb({
      connectionString: env.DATABASE_URL,
      maxConnections: env.DATABASE_POOL_SIZE,
    })
  }
  return cachedDb
}

export async function closeDb(): Promise<void> {
  if (cachedDb) {
    const handle = cachedDb
    cachedDb = null
    await handle.close()
  }
}
