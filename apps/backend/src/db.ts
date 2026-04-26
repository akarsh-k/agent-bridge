import { createDb, type AgentBridgeDb } from '@agent-bridge/db'
import { env } from './env.js'

/**
 * Process-wide Drizzle client. Lazily constructed so unit tests that don't
 * touch the DB don't open a pool. Closed from `server.ts` on shutdown.
 *
 * Pool size + query-logging are env-driven (see `DATABASE_POOL_SIZE`,
 * `DATABASE_DEBUG`). Never enable debug outside dev — the log stream will
 * contain encrypted envelopes, user prompts, and anything else we query.
 */

let cachedDb: AgentBridgeDb | null = null

export function getDb(): AgentBridgeDb {
  if (!cachedDb) {
    cachedDb = createDb({
      connectionString: env.DATABASE_URL,
      maxConnections: env.DATABASE_POOL_SIZE,
      debug: env.DATABASE_DEBUG && !env.isProd,
    })
  }
  return cachedDb
}

export async function closeDb(): Promise<void> {
  if (cachedDb) {
    const h = cachedDb
    cachedDb = null
    await h.close()
  }
}
