import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  ALL_AGENTS_STREAM_ID,
  runEventSchema,
  type RunEvent,
} from '@agent-bridge/shared'
import { getEventBus } from '../event-bus.js'

/**
 * `GET  /api/events/:streamId`                 — SSE tail of a stream.
 * `POST /api/events/:streamId/publish`         — emit a RunEvent (dev helper;
 *                                                 the worker will be the
 *                                                 normal producer).
 *
 * Stream IDs are validated as URL-safe slugs so they round-trip cleanly
 * through the Redis channel name.
 */

const STREAM_ID = /^[a-zA-Z0-9_\-:.]{1,128}$/
const streamIdParamSchema = z.object({
  streamId: z.string().regex(STREAM_ID, 'invalid streamId'),
})

const HEARTBEAT_INTERVAL_MS = 15_000

export const eventsRouter = new Hono()
  .get('/:streamId', zValidator('param', streamIdParamSchema), (c) => {
    const { streamId } = c.req.valid('param')

    return streamSSE(
      c,
      async (stream) => {
        const bus = getEventBus()

        const onEvent = (event: RunEvent) => {
          void stream.writeSSE({
            event: event.kind,
            data: JSON.stringify(event),
            id: `${event.ts}`,
          })
        }

        // The aggregator sentinel pattern-subscribes to every `agent:*`
        // channel so the browser opens ONE connection for all agents instead
        // of one per agent (which saturates the HTTP/1.1 per-host cap).
        const unsubscribe =
          streamId === ALL_AGENTS_STREAM_ID
            ? await bus.subscribeAllAgents(onEvent)
            : await bus.subscribe(streamId, onEvent)

        stream.onAbort(() => {
          void unsubscribe().catch((err: unknown) => {
            console.error(
              `[sse:${streamId}] unsubscribe error:`,
              (err as Error).message,
            )
          })
        })

        await stream.writeSSE({
          event: 'connected',
          data: JSON.stringify({ streamId, ts: Date.now() }),
        })

        while (!stream.aborted) {
          await stream.sleep(HEARTBEAT_INTERVAL_MS)
          if (stream.aborted) break
          await stream.writeSSE({ event: 'ping', data: '{}' })
        }
      },
      async (err, stream) => {
        console.error(`[sse:${streamId}] stream error:`, err)
        await stream.writeSSE({
          event: 'run.error',
          data: JSON.stringify({
            kind: 'run.error',
            ts: Date.now(),
            streamId,
            data: { message: 'stream terminated' },
          } satisfies RunEvent),
        })
      },
    )
  })
  .post(
    '/:streamId/publish',
    zValidator('param', streamIdParamSchema),
    zValidator('json', runEventSchema.omit({ streamId: true, ts: true })),
    async (c) => {
      const { streamId } = c.req.valid('param')
      const body = c.req.valid('json')
      const event: RunEvent = { ...body, streamId, ts: Date.now() }
      const receivers = await getEventBus().publish(event)
      return c.json({ ok: true as const, receivers })
    },
  )

export type EventsRouter = typeof eventsRouter
