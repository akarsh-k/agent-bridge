/**
 * `GET /api/system/tools/gitnexus`
 *   → list the auto-mounted gitnexus MCP tools (names + descriptions).
 *
 * Powers the "System defaults" section of the Tools tab. The actual
 * subprocess is spawned + listed once, then cached for the lifetime
 * of the process — see `loadGitnexusToolDefinitions` in
 * `@agent-bridge/agents` for the cache rationale.
 *
 * Doesn't take an agent id: the gitnexus tool catalog is identical
 * across agents (only the data they query differs).
 */

import { Hono } from 'hono'
import { loadGitnexusToolDefinitions } from '@agent-bridge/agents'

export const systemToolsRouter = new Hono().get('/gitnexus', async (c) => {
  const result = await loadGitnexusToolDefinitions()
  return c.json(result)
})

export type SystemToolsRouter = typeof systemToolsRouter
