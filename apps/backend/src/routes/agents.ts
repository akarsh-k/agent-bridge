/**
 * `/api/agents` — CRUD for user-facing agent rows.
 *
 * - Responses always use the `{ ok: true, ... }` / `{ ok: false, error }`
 *   envelope from `@agent-bridge/shared`.
 * - Secrets never appear on this resource (agents have no secret fields).
 *   Phase 1C routes for `llm-providers`, `repos`, `mcp-connections` will be
 *   where `SecretInput` / `SecretSentinel` actually enter the picture.
 * - Slug uniqueness is enforced by the DB (`agents_slug_uq`). We catch the
 *   Postgres `23505` SQLSTATE and return a friendly `conflict` error.
 */

import { zValidator } from '@hono/zod-validator'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  agentCreateInputSchema,
  agentIdParamSchema,
  agentResponseSchema,
  agentUpdateInputSchema,
  defaultMemoryConfig,
  type AgentResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type AgentRow = typeof schema.agents.$inferSelect

/**
 * Convert a Drizzle row to the wire shape. Dates become ISO strings so the
 * response round-trips through JSON unambiguously.
 */
function toAgentResponse(row: AgentRow): AgentResponse {
  return agentResponseSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    llmProviderId: row.llmProviderId,
    model: row.model,
    memoryEnabled: row.memoryEnabled,
    memoryConfig: row.memoryConfig,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export const agentsRouter = new Hono()
  // ─── POST /api/agents ────────────────────────────────────────────────────
  .post(
    '/',
    zValidator('json', agentCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const body = c.req.valid('json')
      const { db } = getDb()

      try {
        const [row] = await db
          .insert(schema.agents)
          .values({
            slug: body.slug,
            name: body.name,
            description: body.description ?? null,
            systemPrompt: body.systemPrompt ?? '',
            llmProviderId: body.llmProviderId ?? null,
            model: body.model ?? null,
            memoryEnabled: body.memoryEnabled ?? false,
            memoryConfig: body.memoryConfig ?? null,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        return c.json({ ok: true as const, agent: toAgentResponse(row) }, 201)
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `slug "${body.slug}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents ─────────────────────────────────────────────────────
  .get('/', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select()
      .from(schema.agents)
      .orderBy(asc(schema.agents.createdAt))

    return c.json({
      ok: true as const,
      agents: rows.map(toAgentResponse),
    })
  })
  // ─── GET /api/agents/:id ─────────────────────────────────────────────────
  .get(
    '/:id',
    zValidator('param', agentIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, id))
        .limit(1)

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${id} not found`,
        })
      }

      return c.json({ ok: true as const, agent: toAgentResponse(row) })
    },
  )
  // ─── PATCH /api/agents/:id ───────────────────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', agentIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', agentUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      // Build the update object from *only* keys the client sent. Zod's
      // `.strict()` guarantees no extra keys slipped in; missing keys become
      // "leave unchanged" while explicit `null` becomes "clear this field".
      const patch: Partial<typeof schema.agents.$inferInsert> = {}
      if ('slug' in body) patch.slug = body.slug
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description ?? null
      if ('systemPrompt' in body) patch.systemPrompt = body.systemPrompt
      if ('llmProviderId' in body) patch.llmProviderId = body.llmProviderId ?? null
      if ('model' in body) patch.model = body.model ?? null
      if ('memoryEnabled' in body) patch.memoryEnabled = body.memoryEnabled
      if ('memoryConfig' in body) patch.memoryConfig = body.memoryConfig ?? null

      // Phase 6b — when the operator flips `memoryEnabled` true without
      // simultaneously authoring a `memoryConfig`, seed Mastra's
      // documented defaults so the agent works on the next turn without
      // a second PATCH. We re-read the current row to confirm the
      // transition (`false → true`) and to honor any existing config —
      // we never overwrite something the operator already saved.
      if (patch.memoryEnabled === true && !('memoryConfig' in body)) {
        const [current] = await db
          .select({
            memoryEnabled: schema.agents.memoryEnabled,
            memoryConfig: schema.agents.memoryConfig,
          })
          .from(schema.agents)
          .where(eq(schema.agents.id, id))
          .limit(1)
        if (current && !current.memoryEnabled && current.memoryConfig === null) {
          patch.memoryConfig = defaultMemoryConfig()
        }
      }

      try {
        const [row] = await db
          .update(schema.agents)
          .set(patch)
          .where(eq(schema.agents.id, id))
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `agent ${id} not found`,
          })
        }

        return c.json({ ok: true as const, agent: toAgentResponse(row) })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `slug "${patch.slug}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:id ──────────────────────────────────────────────
  .delete(
    '/:id',
    zValidator('param', agentIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.agents)
        .where(eq(schema.agents.id, id))
        .returning({ id: schema.agents.id })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${id} not found`,
        })
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type AgentsRouter = typeof agentsRouter
