import { count, getTableName } from 'drizzle-orm'
import { Hono } from 'hono'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'

/**
 * `GET /api/health`     — liveness probe. Cheap, no dependencies.
 * `GET /api/health/db`  — readiness probe. Verifies Drizzle can reach Postgres
 *                         and returns a row count per table. Used by smoke
 *                         tests and, later, by any process
 *                         manager that wants to know the DB is reachable.
 *
 * The row-count query is one round-trip *per table* (executed in parallel).
 * Tables are small in the expected workload (thousands of rows at most, with
 * `run_events` being the only potential outlier), so `count(*)` is cheap.
 */

export const healthRouter = new Hono()
  .get('/', (c) => c.json({ ok: true as const }))
  .get('/db', async (c) => {
    try {
      const { db } = getDb()

      const entries = await Promise.all(
        schema.allTables.map(async (table) => {
          const [row] = await db.select({ value: count() }).from(table)
          return [getTableName(table), Number(row?.value ?? 0)] as const
        }),
      )

      const tables = Object.fromEntries(entries) as Record<
        (typeof schema.tableNames)[number],
        number
      >

      return c.json({ ok: true as const, tables })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      console.error('[health:db] query failed:', message)
      return c.json({ ok: false as const, error: message }, 503)
    }
  })

export type HealthRouter = typeof healthRouter
