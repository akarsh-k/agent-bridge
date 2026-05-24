import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { env } from './env.js'
import { zValidator } from '@hono/zod-validator'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { onUnhandledError, httpError } from './lib/errors.js'
import { agentConfigEventsRouter } from './routes/agent-config-events.js'
import { agentTokenEstimateRouter } from './routes/agent-token-estimate.js'
import { agentWorkingMemoryRouter } from './routes/agent-working-memory.js'
import { agentMcpToolsRouter } from './routes/agent-mcp-tools.js'
import { agentReposRouter } from './routes/agent-repos.js'
import { agentRunsRouter } from './routes/agent-runs.js'
import { agentThreadsRouter } from './routes/agent-threads.js'
import { agentFilesRouter } from './routes/agent-files.js'
import { agentsRouter } from './routes/agents.js'
import { systemSkillRouter } from './routes/system-skill.js'
import { systemToolsRouter } from './routes/system-tools.js'
import { systemVersionRouter } from './routes/system-version.js'
import { bridgeRouter } from './routes/bridge.js'
import { bridgeToolsRouter } from './routes/bridge-tools.js'
import { eventsRouter } from './routes/events.js'
import { healthRouter } from './routes/health.js'
import { llmProvidersRouter } from './routes/llm-providers.js'
import { mcpConnectionsRouter } from './routes/mcp-connections.js'
import { oauthRouter } from './routes/oauth.js'
import { repoRelationshipsRouter } from './routes/repo-relationships.js'
import { repoGraphRouter } from './routes/repo-graph.js'
import { repoJobsRouter } from './routes/repo-jobs.js'
import { repoWikiStaticRouter } from './routes/repo-wiki-static.js'
import { filesRouter } from './routes/files.js'
import { reposRouter } from './routes/repos.js'
import { runsRouter } from './routes/runs.js'
import { skillsRouter } from './routes/skills.js'
import { toolsRouter } from './routes/tools.js'
import { workerJobsRouter } from './routes/worker-jobs.js'

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

// Default body-limit for the API group. The `/agents/import` endpoint
// legitimately accepts larger bundles (skill markdown + configJson can
// reach hundreds of KB across many rows), and `/api/files` uploads
// multipart bytes up to MAX_FILE_BYTES (50 MiB). Each gets its own
// dispatched cap; everything else stays at the conservative 64 KiB
// default. The cap is set defensively so per-field Zod errors surface
// before the global 413 ever fires.
const SMALL_BODY_LIMIT = 64 * 1024
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024
// 50 MiB upload cap + ~256 KiB of multipart framing + form fields.
// `MAX_FILE_BYTES` is the per-file ceiling; this is the transport one.
const UPLOAD_BODY_LIMIT = 50 * 1024 * 1024 + 256 * 1024
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
const uploadBodyLimit = bodyLimit({
  maxSize: UPLOAD_BODY_LIMIT,
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
    // File uploads are multipart and can be up to MAX_FILE_BYTES.
    // Match POST /api/files exactly (not the GET / PATCH / DELETE
    // siblings) so the small limit still guards the metadata routes.
    if (
      c.req.method === 'POST' &&
      (c.req.path === '/api/files' || c.req.path.endsWith('/api/files'))
    ) {
      return uploadBodyLimit(c, next)
    }
    return smallBodyLimit(c, next)
  })
  .route('/health', healthRouter)
  .route('/agents', agentsRouter)
  .route('/agents/:agentId/repos', agentReposRouter)
  .route('/agents/:agentId/repo-relationships', repoRelationshipsRouter)
  .route('/agents/:agentId/mcp-tools', agentMcpToolsRouter)
  .route('/agents/:agentId/skills', skillsRouter)
  .route('/agents/:agentId/files', agentFilesRouter)
  .route('/agents/:agentId/tools', toolsRouter)
  .route('/agents/:agentId/bridge-tools', bridgeToolsRouter)
  .route('/agents/:agentId/runs', agentRunsRouter)
  .route('/agents/:agentId/threads', agentThreadsRouter)
  .route('/agents/:agentId/config-events', agentConfigEventsRouter)
  .route('/agents/:agentId/token-estimate', agentTokenEstimateRouter)
  .route('/agents/:agentId/working-memory', agentWorkingMemoryRouter)
  .route('/system/tools', systemToolsRouter)
  .route('/system/skill', systemSkillRouter)
  .route('/system/version', systemVersionRouter)
  .route('/llm-providers', llmProvidersRouter)
  .route('/mcp-connections', mcpConnectionsRouter)
  .route('/files', filesRouter)
  .route('/repos', reposRouter)
  .route('/repos', repoJobsRouter)
  .route('/repos', repoGraphRouter)
  .route('/repos', repoWikiStaticRouter)
  .route('/runs', runsRouter)
  .route('/worker-jobs', workerJobsRouter)
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

// ─── Frontend statics in production ──────────────────────────────────────
//
// In dev, the React app is served by Vite on port 5173 and talks to this
// backend on 3001 via CORS. In production, we serve the frontend's
// pre-built bundle from this same Hono server so the operator only has
// one URL to remember (and no CORS dance). The bundle lives at
// `apps/frontend/dist/` after `pnpm build` (which the start orchestrator
// runs before booting). At runtime we compute the absolute path from
// this module's location, then express it as a path RELATIVE to
// `process.cwd()` because `@hono/node-server/serve-static`'s `root`
// option requires that. The empty-string fallback covers the corner case
// where cwd is exactly the frontend dist dir (shouldn't happen in
// practice, but the relative-path math wants `.` not `''`).
const FRONTEND_DIST_ABS = computeFrontendDistAbs()
const FRONTEND_DIST_REL = (() => {
  const rel = path.relative(process.cwd(), FRONTEND_DIST_ABS)
  return rel.length === 0 ? '.' : rel
})()
const FRONTEND_INDEX_PATH = path.join(FRONTEND_DIST_ABS, 'index.html')

function computeFrontendDistAbs(): string {
  // `import.meta.url` points at either `apps/backend/src/app.ts` (dev) or
  // `apps/backend/dist/app.js` (prod). Walking two directories up lands
  // on `apps/backend/`, then over to `apps/frontend/dist/`. Same
  // relative-path math either way because `dist/` is a sibling of `src/`.
  const here = fileURLToPath(import.meta.url)
  return path.resolve(
    path.dirname(here),
    '..',
    '..',
    'frontend',
    'dist',
  )
}

/**
 * Cache the SPA's `index.html` in memory so the notFound fallback
 * doesn't read from disk on every miss. The file is baked in by Vite at
 * build time and never changes at runtime. `null` means the read failed
 * (frontend wasn't built) and the fallback should degrade to the
 * existing JSON 404.
 */
let cachedIndexHtml: string | null | undefined
async function loadIndexHtml(): Promise<string | null> {
  if (cachedIndexHtml !== undefined) return cachedIndexHtml
  try {
    cachedIndexHtml = await fs.readFile(FRONTEND_INDEX_PATH, 'utf8')
  } catch {
    cachedIndexHtml = null
  }
  return cachedIndexHtml
}

async function notFoundHandler(c: Context): Promise<Response> {
  // SPA fallback: any non-API, non-OAuth GET in production returns the
  // React entry HTML so the client-side router can handle deep links
  // (e.g. `/logs/<runId>` typed into the address bar, or a refresh
  // mid-route). The asset middleware below would have served a real
  // file if one existed; reaching notFound means there's nothing on
  // disk, so the SPA is the right answer. In dev we always return JSON
  // 404 because Vite owns frontend routing on its own port.
  const apiOrOauth =
    c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/')
  if (env.isProd && c.req.method === 'GET' && !apiOrOauth) {
    const html = await loadIndexHtml()
    if (html !== null) return c.html(html)
  }
  return httpError(c, { code: 'not_found', message: 'Route not found' })
}

const app = new Hono()
  .onError(onUnhandledError)
  .notFound(notFoundHandler)
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

// Static asset middleware runs AFTER the API + OAuth routes so a real
// API path always wins. For unmatched paths, `serveStatic` reads from
// the frontend dist if a matching file exists, or calls `next()` and
// hands off to `notFoundHandler` (which serves the SPA index in prod).
// We mount this in both dev and prod — it's a no-op in dev because the
// frontend's `dist/` directory doesn't exist until `pnpm build` runs.
if (env.isProd) {
  app.use('/*', serveStatic({ root: FRONTEND_DIST_REL }))
}

export type AppType = typeof app
export { app }
