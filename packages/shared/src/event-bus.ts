import { Redis, type RedisOptions } from 'ioredis'
import { runEventSchema, type RunEvent } from './events.js'

/**
 * Redis pub/sub bridge for `RunEvent`s.
 *
 * Worker process → `publish(event)` → Redis → `subscribe(streamId, cb)` in the
 * backend's SSE handler → SSE frame to the browser.
 *
 * One Redis channel per logical stream: `agent-bridge:stream:<streamId>`. This
 * keeps fan-out scoped — a browser tailing run A never wakes up for run B's
 * traffic. The `subscribe` call is *per-connection*: each SSE client gets its
 * own ioredis subscriber so close semantics are trivial.
 *
 * This module is Node-only (imports ioredis).
 */

export const STREAM_CHANNEL_PREFIX = 'agent-bridge:stream:'

export function streamChannel(streamId: string): string {
  return `${STREAM_CHANNEL_PREFIX}${streamId}`
}

export interface EventBusOptions {
  readonly redisUrl: string
  readonly redisOptions?: RedisOptions
}

export interface EventBus {
  /** Publish a validated event. Resolves to the number of receivers. */
  publish: (event: RunEvent) => Promise<number>
  /**
   * Subscribe to one stream. Returns an async `unsubscribe` that fully closes
   * the dedicated subscriber connection. Malformed frames are logged and
   * dropped; they never reach the handler.
   */
  subscribe: (
    streamId: string,
    handler: (event: RunEvent) => void,
  ) => Promise<() => Promise<void>>
  /** Close the shared publisher connection. */
  close: () => Promise<void>
}

export function createEventBus(options: EventBusOptions): EventBus {
  const { redisUrl, redisOptions } = options

  const publisher = new Redis(redisUrl, { ...redisOptions })
  publisher.on('error', (err) => {
    console.error('[event-bus:pub] error:', err.message)
  })

  return {
    async publish(event) {
      const validated = runEventSchema.parse(event)
      return publisher.publish(
        streamChannel(validated.streamId),
        JSON.stringify(validated),
      )
    },
    async subscribe(streamId, handler) {
      const subscriber = new Redis(redisUrl, {
        ...redisOptions,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      })

      subscriber.on('error', (err) => {
        console.error(`[event-bus:sub:${streamId}] error:`, err.message)
      })

      subscriber.on('message', (_channel, payload) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch (err) {
          console.error(
            `[event-bus:sub:${streamId}] bad JSON:`,
            (err as Error).message,
          )
          return
        }
        const result = runEventSchema.safeParse(parsed)
        if (!result.success) {
          console.error(
            `[event-bus:sub:${streamId}] invalid event:`,
            result.error.issues,
          )
          return
        }
        handler(result.data)
      })

      await subscriber.subscribe(streamChannel(streamId))

      return async () => {
        try {
          await subscriber.unsubscribe(streamChannel(streamId))
        } finally {
          subscriber.disconnect()
        }
      }
    },
    async close() {
      publisher.disconnect()
    },
  }
}
