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
import { agentExportRouter } from './routes/agent-export.js'
import { agentMcpToolsRouter } from './routes/agent-mcp-tools.js'
import { agentReposRouter } from './routes/agent-repos.js'
import { agentRunsRouter } from './routes/agent-runs.js'
import { agentsRouter } from './routes/agents.js'
import { bridgeRouter } from './routes/bridge.js'
import { bridgeToolsRouter } from './routes/bridge-tools.js'
import { eventsRouter } from './routes/events.js'
import { healthRouter } from './routes/health.js'
import { llmProvidersRouter } from './routes/llm-providers.js'
import { mcpConnectionsRouter } from './routes/mcp-connections.js'
import { oauthRouter } from './routes/oauth.js'
import { repoEdgesRouter } from './routes/repo-edges.js'
import { repoJobsRouter } from './routes/repo-jobs.js'
import { repoWikiStaticRouter } from './routes/repo-wiki-static.js'
import { reposRouter } from './routes/repos.js'
import { runsRouter } from './routes/runs.js'
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

// Default body-limit for the API group. Phase 6e's `/agents/import`
// endpoint legitimately accepts larger bundles (skill markdown +
// configJson can reach hundreds of KB across many rows), so we route
// the larger cap through that one path and keep the conservative
// 64 KiB cap for everything else. See `1c-skills-tools` lesson in
// `docs/PLAN.md` — the cap is set defensively so per-field Zod errors
// surface before the global 413 ever fires.
const SMALL_BODY_LIMIT = 64 * 1024
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024
const onBodyLimitError: Parameters<typeof bodyLimit>[0]['onError'] = (c) =>
  httpError(c, {
    code: 'validation_failed',
    message: 'Payload too large',
    status: 413,
  })
const smallBodyLimit = bodyLimit({
  maxSize: SMALL_BODY_LIMIT,
  onError: onBodyLimitError,
})
const importBodyLimit = bodyLimit({
  maxSize: IMPORT_BODY_LIMIT,
  onError: onBodyLimitError,
})

const api = new Hono()
  .use('*', async (c, next) => {
    // Path-aware body-limit dispatcher. `c.req.path` includes the `/api`
    // prefix because we mount this Hono router under that path on the
    // outer app — match against the suffix to stay decoupled from the
    // mount point.
    if (
      c.req.path === '/api/agents/import' ||
      c.req.path.endsWith('/agents/import')
    ) {
      return importBodyLimit(c, next)
    }
    return smallBodyLimit(c, next)
  })
  .route('/health', healthRouter)
  .route('/agents', agentsRouter)
  .route('/agents', agentExportRouter)
  .route('/agents/:agentId/repos', agentReposRouter)
  .route('/agents/:agentId/repo-edges', repoEdgesRouter)
  .route('/agents/:agentId/mcp-tools', agentMcpToolsRouter)
  .route('/agents/:agentId/skills', skillsRouter)
  .route('/agents/:agentId/tools', toolsRouter)
  .route('/agents/:agentId/bridge-tools', bridgeToolsRouter)
  .route('/agents/:agentId/runs', agentRunsRouter)
  .route('/llm-providers', llmProvidersRouter)
  .route('/mcp-connections', mcpConnectionsRouter)
  .route('/repos', reposRouter)
  .route('/repos', repoJobsRouter)
  .route('/repos', repoWikiStaticRouter)
  .route('/runs', runsRouter)
  .route('/bridge', bridgeRouter)
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
