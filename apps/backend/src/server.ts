import { serve } from '@hono/node-server'
import { builtAgentCache } from '@agent-bridge/agents'
import { runMigrations } from '@agent-bridge/db'
import {
  getSecretKeyPath,
  loadOrCreateMasterKey,
} from '@agent-bridge/shared/crypto'
import { getAgentBridgeVersion } from '@agent-bridge/shared/version'
import { env } from './env.js'
import { app } from './app.js'
import { closeDb, getDb } from './db.js'
import { closeEventBus } from './event-bus.js'
import { closeQueues } from './lib/queues.js'

// Print version + commit before anything else so bug reports always
// have a usable identifier even when the boot fails downstream.
const buildInfo = getAgentBridgeVersion()
console.info(
  `[server] Agent Bridge v${buildInfo.version} (commit ${buildInfo.commit})`,
)

// Eagerly materialise the data-encryption key on boot so:
//   (a) the one-time "generated new key" log appears before the first HTTP
//       request instead of interleaved with a user action, and
//   (b) any permission / env-var misconfiguration surfaces as a startup
//       failure, not as a stray 500 the first time someone saves a secret.
loadOrCreateMasterKey()
console.info(`[server] data-encryption key ready at ${getSecretKeyPath()}`)

// Apply any pending schema migrations BEFORE accepting traffic. Dev
// keeps migrations manual (`pnpm db:migrate`) so contributors control
// timing; production auto-applies on every boot. Drizzle is idempotent
// — usually a no-op after the first run. A migration failure here is
// fatal: we'd rather refuse to serve than answer requests against a
// half-migrated schema.
if (env.isProd) {
  try {
    const result = await runMigrations(getDb())
    console.info(
      `[server] migrations applied in ${result.durationMs}ms from ${result.migrationsFolder}`,
    )
  } catch (err) {
    console.error('[server] migration failed; refusing to start:', err)
    process.exit(1)
  }
}

async function closeResources(): Promise<void> {
  // Tear down cached BuiltAgents FIRST so their MCP subprocesses
  // disconnect cleanly while the DB pool + event bus are still alive
  // (some teardowns may emit final stderr/audit events). After that
  // close everything else.
  await builtAgentCache.dispose()
  await Promise.allSettled([closeEventBus(), closeQueues(), closeDb()])
}

const server = serve(
  { fetch: app.fetch, port: env.PORT, hostname: env.HOST },
  (info) => {
    console.info(`[server] listening on http://${env.HOST}:${info.port}`)
  },
)

const SHUTDOWN_TIMEOUT_MS = 10_000
let shuttingDown = false

function shutdown(signal: NodeJS.Signals | 'uncaughtException'): void {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[server] ${signal} received — closing HTTP server…`)

  const forceExit = setTimeout(() => {
    console.error(
      `[server] shutdown did not complete in ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`,
    )
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceExit.unref()

  server.close((err) => {
    if (err) {
      console.error('[server] error during close:', err)
      void closeResources().finally(() => process.exit(1))
      return
    }
    console.info('[server] closed cleanly')
    void closeResources().finally(() => process.exit(0))
  })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown(sig))
}

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err)
  shutdown('uncaughtException')
})

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason)
})
