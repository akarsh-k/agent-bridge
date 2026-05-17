/**
 * `/api/agents` — CRUD for user-facing agent rows.
 *
 * - Responses always use the `{ ok: true, ... }` / `{ ok: false, error }`
 *   envelope from `@agent-bridge/shared`.
 * - Secrets never appear on this resource (agents have no secret fields).
 *   Routes for `llm-providers`, `repos`, `mcp-connections` will be
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
  ASK_AGENT_DEFAULTS,
  defaultMemoryConfig,
  type AgentResponse,
} from '@agent-bridge/shared'
import { schema, type AgentBridgeDb } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type AgentRow = typeof schema.agents.$inferSelect

/**
 * Convert an agent slug into a string that satisfies
 * `bridge_tools.name`'s CHECK regex `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`.
 * Slugs allow dashes and digit-start; bridge_tools names don't.
 *
 * - Dashes → underscores
 * - Leading digit → prepend `a`
 * - Total length capped at 64 - len("__ask_agent") = 53 to leave room
 *   for the `__ask_agent` suffix
 */
function slugToBridgeToolPrefix(slug: string): string {
  const noDashes = slug.replace(/-/g, '_')
  const safe = /^[a-zA-Z]/.test(noDashes) ? noDashes : `a${noDashes}`
  return safe.slice(0, 53)
}

/**
 * Auto-create the starter `<slug>__ask_agent` `bridge_tools` row for
 * a Build-your-own agent. No-op when one already exists (idempotent
 * for the PATCH inspector_enabled true→false case where prior runs
 * may have inserted the row).
 *
 * We swallow unique-violation on `bridge_tools.name` so a slug that
 * collides with an existing operator-authored tool name doesn't
 * block agent creation — the operator can manually add a tool with
 * a different name later.
 */
async function ensureAskAgentBridgeTool(
  db: AgentBridgeDb,
  agentId: string,
  slug: string,
): Promise<void> {
  const existing = await db.db
    .select({ id: schema.bridgeTools.id })
    .from(schema.bridgeTools)
    .where(eq(schema.bridgeTools.agentId, agentId))
    .limit(1)
  if (existing.length > 0) return // operator already has tools; don't add

  const name = `${slugToBridgeToolPrefix(slug)}__${ASK_AGENT_DEFAULTS.nameSuffix}`
  try {
    await db.db.insert(schema.bridgeTools).values({
      agentId,
      name,
      description: ASK_AGENT_DEFAULTS.description,
      inputSchema: ASK_AGENT_DEFAULTS.inputSchema,
      promptTemplate: ASK_AGENT_DEFAULTS.promptTemplate,
      enabled: true,
    })
  } catch (err) {
    if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
      // Name collision with another agent's tool. Fine — operator
      // can add their own with a unique name later.
      return
    }
    throw err
  }
}

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
    memoryEnabled: row.memoryEnabled,
    memoryConfig: row.memoryConfig,
    inspectorEnabled: row.inspectorEnabled,
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
      const dbHandle = getDb()
      const { db } = dbHandle

      try {
        const [row] = await db
          .insert(schema.agents)
          .values({
            slug: body.slug,
            name: body.name,
            description: body.description ?? null,
            systemPrompt: body.systemPrompt ?? '',
            llmProviderId: body.llmProviderId ?? null,
            memoryEnabled: body.memoryEnabled ?? false,
            memoryConfig: body.memoryConfig ?? null,
            // Defaults to true at the column level (Repo-inspector). Pass
            // through verbatim when the operator chose Build-your-own-agent
            // at creation; otherwise the schema default applies.
            ...(body.inspectorEnabled !== undefined
              ? { inspectorEnabled: body.inspectorEnabled }
              : {}),
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        // Build-your-own template: auto-create the starter
        // `<slug>__ask_agent` bridge_tools row so the IDE has a
        // tool to call out of the box. Operators edit / rename /
        // delete it from the Bridge-tools tab like any other tool.
        if (!row.inspectorEnabled) {
          await ensureAskAgentBridgeTool(dbHandle, row.id, row.slug)
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
      const dbHandle = getDb()
      const { db } = dbHandle

      // Build the update object from *only* keys the client sent. Zod's
      // `.strict()` guarantees no extra keys slipped in; missing keys become
      // "leave unchanged" while explicit `null` becomes "clear this field".
      const patch: Partial<typeof schema.agents.$inferInsert> = {}
      if ('slug' in body) patch.slug = body.slug
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description ?? null
      if ('systemPrompt' in body) patch.systemPrompt = body.systemPrompt
      if ('llmProviderId' in body) patch.llmProviderId = body.llmProviderId ?? null
      if ('memoryEnabled' in body) patch.memoryEnabled = body.memoryEnabled
      if ('memoryConfig' in body) patch.memoryConfig = body.memoryConfig ?? null
      if ('inspectorEnabled' in body) patch.inspectorEnabled = body.inspectorEnabled

      // When the operator flips `memoryEnabled` true without
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

        // Auto-create the starter ask_agent bridge_tool when the
        // operator transitions to inspector_enabled=false (so they
        // don't end up with a blank agent that exposes nothing to
        // the IDE). No-op if a tool already exists for the agent.
        if (patch.inspectorEnabled === false && !row.inspectorEnabled) {
          await ensureAskAgentBridgeTool(dbHandle, row.id, row.slug)
        }

        // Activity feed: which fields changed? List the keys the
        // operator actually edited so the card reads "name, model"
        // not "Untitled agent". Skip the auto-seeded `memoryConfig`
        // since the human edit is `memoryEnabled`, not
        // the seeded blob.
        const changedFields = Object.keys(body)
        if (changedFields.length > 0) {
          publishAgentConfig({
            agentId: id,
            action: 'updated',
            resource: 'agent',
            label: row.name,
            detail: `fields: ${changedFields.join(', ')}`,
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
