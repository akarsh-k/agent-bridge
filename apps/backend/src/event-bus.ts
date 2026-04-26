import { createEventBus, type EventBus } from '@agent-bridge/shared/event-bus'
import { env } from './env.js'

/**
 * Process-wide Redis event bus. Lazily constructed so a backend boot without
 * Redis (e.g. during unit tests) doesn't open a dangling publisher socket.
 * Closed from `server.ts` on shutdown.
 */

let cachedBus: EventBus | null = null

export function getEventBus(): EventBus {
  if (!cachedBus) {
    cachedBus = createEventBus({ redisUrl: env.REDIS_URL })
  }
  return cachedBus
}

export async function closeEventBus(): Promise<void> {
  if (cachedBus) {
    const bus = cachedBus
    cachedBus = null
    await bus.close()
  }
}
