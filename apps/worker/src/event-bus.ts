import { createEventBus, type EventBus } from '@agent-bridge/shared/event-bus'
import { env } from './env.js'

/**
 * Worker-owned Redis publisher. Mirrors the backend's helper so clone/index
 * jobs can `publish(event)` to the same channel the backend's SSE handler
 * is subscribing on — a browser tailing `/api/events/repo:<id>` will see
 * the worker's events in real time.
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
