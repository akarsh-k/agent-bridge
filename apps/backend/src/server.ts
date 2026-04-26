import { serve } from '@hono/node-server'
import {
  getSecretKeyPath,
  loadOrCreateMasterKey,
} from '@agent-bridge/shared/crypto'
import { env } from './env.js'
import { app } from './app.js'
import { closeDb } from './db.js'
import { closeEventBus } from './event-bus.js'

// Eagerly materialise the data-encryption key on boot so:
//   (a) the one-time "generated new key" log appears before the first HTTP
//       request instead of interleaved with a user action, and
//   (b) any permission / env-var misconfiguration surfaces as a startup
//       failure, not as a stray 500 the first time someone saves a secret.
loadOrCreateMasterKey()
console.info(`[server] data-encryption key ready at ${getSecretKeyPath()}`)

async function closeResources(): Promise<void> {
  await Promise.allSettled([closeEventBus(), closeDb()])
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
