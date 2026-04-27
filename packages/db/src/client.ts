import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

/**
 * The `pg` (node-postgres) driver is used instead of postgres-js because
 * Mastra's `PostgresStore` (agent memory, vector search) expects a
 * `pg.Pool`. Standardizing on one driver means the Mastra storage layer
 * can reuse this exact pool — no double-pooling, no query-level driver
 * translation — which is what the plan calls for in Phase 3b.
 *
 * Connection pool size defaults to 10; tune per deployment via
 * `DATABASE_POOL_SIZE`. Mastra's memory workload is modest (one INSERT
 * per agent turn, occasional SELECTs for context retrieval) so the
 * shared pool is comfortable at this size.
 */

export type PgPool = pg.Pool

export interface CreateDbOptions {
  /** Postgres connection string (e.g. `postgres://user:pass@host:port/db`). */
  readonly connectionString: string
  /** Maximum pool size. Default 10 for backend, tune per workspace. */
  readonly maxConnections?: number
  /** Set to `true` to log every query (dev only — will include PII). */
  readonly debug?: boolean
}

export interface AgentBridgeDb {
  /** Drizzle handle with the full schema typed in. */
  readonly db: ReturnType<typeof drizzle<typeof schema>>
  /**
   * Raw pg pool. Consumers outside the DB package should prefer `db`;
   * `pool` is an intentional escape hatch for code that needs to hand
   * a native pg client to a third-party library (notably Mastra's
   * `PostgresStore` in `packages/agents`).
   */
  readonly pool: PgPool
  close(): Promise<void>
}

export function createDb(options: CreateDbOptions): AgentBridgeDb {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  })

  const db = drizzle(pool, {
    schema,
    logger: options.debug ?? false,
  })

  return {
    db,
    pool,
    async close() {
      await pool.end()
    },
  }
}
