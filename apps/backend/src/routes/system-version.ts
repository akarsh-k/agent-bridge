/**
 * `GET /api/system/version` — returns the running Agent Bridge version
 * + git commit. Used by bug reports, the frontend's Settings page, and
 * any external tool that wants to detect which install it's talking to.
 *
 * Cheap: `getAgentBridgeVersion()` caches after first call, so this
 * endpoint is effectively a constant-time string read.
 */

import { Hono } from 'hono'
import { getAgentBridgeVersion } from '@agent-bridge/shared/version'

export const systemVersionRouter = new Hono().get('/', (c) => {
  const info = getAgentBridgeVersion()
  return c.json({
    ok: true as const,
    version: info.version,
    commit: info.commit,
  })
})

export type SystemVersionRouter = typeof systemVersionRouter
