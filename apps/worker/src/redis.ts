import { Redis, type RedisOptions } from 'ioredis'
import { env } from './env.js'

/**
 * Shared ioredis factory for BullMQ. BullMQ requires
 * `maxRetriesPerRequest: null` and `enableReadyCheck: false` on connections
 * consumed by its `Worker` / `QueueEvents` classes — without them it will
 * terminate blocking calls on reconnect and throw.
 *
 * We return a fresh connection per caller so queues, workers, and events
 * each own their own socket. That avoids the cross-talk issues that come
 * from sharing one connection across roles.
 */

export interface CreateRedisOptions {
  readonly role: 'queue' | 'worker' | 'events' | 'client'
  readonly overrides?: RedisOptions
}

export function createRedisConnection(options: CreateRedisOptions): Redis {
  const { role, overrides } = options

  const needsBlockingSafeDefaults = role === 'worker' || role === 'events'

  const base: RedisOptions = needsBlockingSafeDefaults
    ? { maxRetriesPerRequest: null, enableReadyCheck: false }
    : {}

  const connection = new Redis(env.REDIS_URL, { ...base, ...overrides })
  connection.on('error', (err: Error) => {
    console.error(`[redis:${role}] error:`, err.message)
  })
  return connection
}
