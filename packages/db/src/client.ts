import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type PostgresClient = ReturnType<typeof postgres>

export interface CreateDbOptions {
  /** Postgres connection string (e.g. `postgres://user:pass@host:port/db`). */
  readonly connectionString: string
  /** Maximum pool size. Default 10 for backend, tune per workspace. */
  readonly maxConnections?: number
  /** Set to `true` to log every query (dev only — will include PII). */
  readonly debug?: boolean
}

export interface AgentBridgeDb {
  readonly db: ReturnType<typeof drizzle<typeof schema>>
  readonly sql: PostgresClient
  close(): Promise<void>
}

export function createDb(options: CreateDbOptions): AgentBridgeDb {
  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    onnotice: () => {},
    prepare: false,
  })

  const db = drizzle(sql, {
    schema,
    logger: options.debug ?? false,
  })

  return {
    db,
    sql,
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}
