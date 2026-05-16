/**
 * Programmatic migration runner. Wraps Drizzle's `migrate()` so the
 * backend + worker can apply pending schema changes on boot in
 * production. Mirrors what `pnpm db:migrate` does on the CLI, just
 * callable from a long-running process.
 *
 * Idempotent: Drizzle records applied migrations in
 * `__drizzle_migrations` and skips re-runs. Safe to call on every
 * boot — usually a no-op after the first.
 *
 * Concurrency: the start orchestrator runs this once before spawning
 * backend + worker, so racing is rare. When both processes call it
 * anyway (e.g. someone invoked `node dist/server.js` directly), the
 * Drizzle `migrate()` path serialises through the migrations table —
 * the second caller observes the first's writes and runs zero
 * statements.
 *
 * Failure: throws synchronously on any error. Callers should treat
 * a migration failure as fatal — the schema may be in a partial state
 * and serving traffic against it is worse than not booting.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import type { AgentBridgeDb } from './client.js'

/**
 * Resolve the absolute path to `packages/db/migrations/`. We can't
 * rely on the caller's `process.cwd()` because the backend / worker
 * may be launched from different working directories (the dev
 * orchestrator runs from the repo root; a user invoking `node
 * dist/server.js` directly might be anywhere).
 *
 * `import.meta.url` lands on one of:
 *   - packages/db/src/migrate.ts   (development condition)
 *   - packages/db/dist/migrate.js  (built output)
 * Both are two directories under the package root, so the same walk
 * works either way.
 */
function resolveMigrationsFolder(): string {
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..', 'migrations')
}

export interface RunMigrationsResult {
  /** Absolute path of the folder we read migrations from. */
  readonly migrationsFolder: string
  /** Wall-clock duration of the migrate call, in ms. */
  readonly durationMs: number
}

export async function runMigrations(
  db: AgentBridgeDb,
): Promise<RunMigrationsResult> {
  const migrationsFolder = resolveMigrationsFolder()
  const startedAt = Date.now()
  await migrate(db.db, { migrationsFolder })
  return { migrationsFolder, durationMs: Date.now() - startedAt }
}
