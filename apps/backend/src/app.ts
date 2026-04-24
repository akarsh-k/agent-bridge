import { env } from './env.js'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'

const corsOrigin =
  env.CORS_ORIGIN && env.CORS_ORIGIN.length > 0
    ? env.CORS_ORIGIN
    : ['http://localhost:5173', 'http://127.0.0.1:5173']

if (!env.isProd && env.CORS_ORIGIN?.includes('*')) {
  console.warn(
    '[cors] CORS_ORIGIN contains "*" — avoid this if you use cookies or sensitive APIs.',
  )
}

const requestLogger: MiddlewareHandler = env.isProd
  ? async (_c, next) => {
      await next()
    }
  : logger()

const api = new Hono()
  .use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
  )
  .get('/health', (c) => c.json({ ok: true as const }))
  .get(
    '/hello',
    zValidator('query', z.object({ name: z.string().trim().min(1).max(200) })),
    (c) => {
      const { name } = c.req.valid('query')
      return c.json({ message: `Hello, ${name}` })
    },
  )
  .post(
    '/echo',
    zValidator('json', z.object({ text: z.string().min(1).max(500) })),
    (c) => {
      const body = c.req.valid('json')
      return c.json({ text: body.text })
    },
  )

export type ApiType = typeof api

const app = new Hono()
  .onError((err, c) => {
    console.error('[onError]', err)
    const detail = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: env.isProd ? 'Internal Server Error' : detail }, 500)
  })
  .notFound((c) => c.json({ error: 'Not Found' }, 404))
  .use('*', secureHeaders())
  .use(
    '*',
    cors({
      origin: corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  )
  .use('*', requestLogger)
  .route('/api', api)

export type AppType = typeof app
export { app }
