import { env } from './env.js'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { onUnhandledError, httpError } from './lib/errors.js'
import { agentMcpToolsRouter } from './routes/agent-mcp-tools.js'
import { agentReposRouter } from './routes/agent-repos.js'
import { agentRunsRouter } from './routes/agent-runs.js'
import { agentsRouter } from './routes/agents.js'
import { eventsRouter } from './routes/events.js'
import { healthRouter } from './routes/health.js'
import { llmProvidersRouter } from './routes/llm-providers.js'
import { mcpConnectionsRouter } from './routes/mcp-connections.js'
import { oauthRouter } from './routes/oauth.js'
import { repoEdgesRouter } from './routes/repo-edges.js'
import { repoJobsRouter } from './routes/repo-jobs.js'
import { repoWikiStaticRouter } from './routes/repo-wiki-static.js'
import { reposRouter } from './routes/repos.js'
import { skillsRouter } from './routes/skills.js'
import { toolsRouter } from './routes/tools.js'

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
      onError: (c) =>
        httpError(c, {
          code: 'validation_failed',
          message: 'Payload too large',
          status: 413,
        }),
    }),
  )
  .route('/health', healthRouter)
  .route('/agents', agentsRouter)
  .route('/agents/:agentId/repos', agentReposRouter)
  .route('/agents/:agentId/repo-edges', repoEdgesRouter)
  .route('/agents/:agentId/mcp-tools', agentMcpToolsRouter)
  .route('/agents/:agentId/skills', skillsRouter)
  .route('/agents/:agentId/tools', toolsRouter)
  .route('/agents/:agentId/runs', agentRunsRouter)
  .route('/llm-providers', llmProvidersRouter)
  .route('/mcp-connections', mcpConnectionsRouter)
  .route('/repos', reposRouter)
  .route('/repos', repoJobsRouter)
  .route('/repos', repoWikiStaticRouter)
  .get(
    '/hello',
    zValidator('query', z.object({ name: z.string().trim().min(1).max(200) })),
    (c) => {
      const { name } = c.req.valid('query')
      return c.json({ ok: true as const, message: `Hello, ${name}` })
    },
  )
  .post(
    '/echo',
    zValidator('json', z.object({ text: z.string().min(1).max(500) })),
    (c) => {
      const body = c.req.valid('json')
      return c.json({ ok: true as const, text: body.text })
    },
  )
  .route('/events', eventsRouter)

export type ApiType = typeof api

const app = new Hono()
  .onError(onUnhandledError)
  .notFound((c) =>
    httpError(c, { code: 'not_found', message: 'Route not found' }),
  )
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
  // OAuth callback lives at root because the redirect URL is
  // registered with upstream providers (Notion etc.) at
  // dynamic-client-registration time and must stay stable across
  // API versions.
  .route('/oauth', oauthRouter)

export type AppType = typeof app
export { app }
