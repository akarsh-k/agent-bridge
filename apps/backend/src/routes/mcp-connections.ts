/**
 * `/api/mcp-connections` — CRUD for external MCP servers the operator wants
 * to expose to their Mastra agents.
 *
 * This is the only route that stores TWO encrypted envelopes on the same
 * row (`env_envelope`, `headers_envelope`). It also re-runs the DTO's
 * transport-policy refine against the merged PATCH + DB row so that a
 * partial update can't escape the invariants (e.g. setting `headers` on a
 * stdio connection).
 *
 * Secrets pipeline:
 *   - Input map (`Record<string, string>`) → JSON.stringify → encrypt → envelope.
 *   - Response always sentinels each envelope through `envelopeToSentinel`.
 *     Plaintext never appears on the wire.
 *
 * Delete cascades to `agent_mcp_tools` via FK.
 */

import { zValidator } from '@hono/zod-validator'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  applyTransportPolicy,
  mcpConnectionCreateInputSchema,
  mcpConnectionIdParamSchema,
  mcpConnectionResponseSchema,
  mcpConnectionUpdateInputSchema,
  type McpConnectionResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import {
  applySecretMapInput,
  applySecretMapInputForCreate,
  envelopeToSentinel,
  SECRET_UNCHANGED,
} from '../lib/secrets.js'

type McpConnectionRow = typeof schema.mcpConnections.$inferSelect

function toMcpConnectionResponse(
  row: McpConnectionRow,
): McpConnectionResponse {
  return mcpConnectionResponseSchema.parse({
    id: row.id,
    name: row.name,
    transport: row.transport,
    commandOrUrl: row.commandOrUrl,
    argsJson: row.argsJson,
    allowHostHome: row.allowHostHome,
    env: envelopeToSentinel(row.envEnvelope),
    headers: envelopeToSentinel(row.headersEnvelope),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export const mcpConnectionsRouter = new Hono()
  // ─── POST /api/mcp-connections ───────────────────────────────────────────
  .post(
    '/',
    zValidator('json', mcpConnectionCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const body = c.req.valid('json')
      const { db } = getDb()

      const envEnvelope = applySecretMapInputForCreate(body.env)
      const headersEnvelope = applySecretMapInputForCreate(body.headers)

      try {
        const [row] = await db
          .insert(schema.mcpConnections)
          .values({
            name: body.name,
            transport: body.transport,
            commandOrUrl: body.commandOrUrl,
            argsJson: body.argsJson ?? [],
            envEnvelope,
            headersEnvelope,
            allowHostHome: body.allowHostHome ?? false,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        return c.json(
          {
            ok: true as const,
            mcpConnection: toMcpConnectionResponse(row),
          },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `mcp connection name "${body.name}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/mcp-connections ────────────────────────────────────────────
  .get('/', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select()
      .from(schema.mcpConnections)
      .orderBy(asc(schema.mcpConnections.createdAt))

    return c.json({
      ok: true as const,
      mcpConnections: rows.map(toMcpConnectionResponse),
    })
  })
  // ─── GET /api/mcp-connections/:id ────────────────────────────────────────
  .get(
    '/:id',
    zValidator('param', mcpConnectionIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .select()
        .from(schema.mcpConnections)
        .where(eq(schema.mcpConnections.id, id))
        .limit(1)

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `mcp connection ${id} not found`,
        })
      }

      return c.json({
        ok: true as const,
        mcpConnection: toMcpConnectionResponse(row),
      })
    },
  )
  // ─── PATCH /api/mcp-connections/:id ──────────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', mcpConnectionIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', mcpConnectionUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      // Load existing row so we can merge+refine: the transport is
      // immutable and lives only on the DB, so we need it to know whether
      // the patched `headers` / `env` are valid for this connection.
      const [existing] = await db
        .select()
        .from(schema.mcpConnections)
        .where(eq(schema.mcpConnections.id, id))
        .limit(1)

      if (!existing) {
        return httpError(c, {
          code: 'not_found',
          message: `mcp connection ${id} not found`,
        })
      }

      // Re-run the transport policy against the effective post-patch shape.
      // If the caller set `headers` on a stdio row, or `env` on an http
      // row, this rejects with the same message as on create.
      const refineResult = refineMergedPatch(existing.transport, body)
      if (!refineResult.success) {
        return httpValidationError(c, refineResult.error)
      }

      const patch: Partial<typeof schema.mcpConnections.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('commandOrUrl' in body) patch.commandOrUrl = body.commandOrUrl
      if ('argsJson' in body) patch.argsJson = body.argsJson ?? []
      if ('allowHostHome' in body) patch.allowHostHome = body.allowHostHome

      const nextEnv = applySecretMapInput(body.env)
      if (nextEnv !== SECRET_UNCHANGED) patch.envEnvelope = nextEnv

      const nextHeaders = applySecretMapInput(body.headers)
      if (nextHeaders !== SECRET_UNCHANGED) {
        patch.headersEnvelope = nextHeaders
      }

      try {
        const [row] = await db
          .update(schema.mcpConnections)
          .set(patch)
          .where(eq(schema.mcpConnections.id, id))
          .returning()

        if (!row) {
          // Concurrent delete between our SELECT and UPDATE.
          return httpError(c, {
            code: 'not_found',
            message: `mcp connection ${id} not found`,
          })
        }

        return c.json({
          ok: true as const,
          mcpConnection: toMcpConnectionResponse(row),
        })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `mcp connection name "${patch.name}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/mcp-connections/:id ─────────────────────────────────────
  .delete(
    '/:id',
    zValidator('param', mcpConnectionIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      // `agent_mcp_tools.mcp_connection_id` → `ON DELETE CASCADE`: any
      // allowlist entries pointing here are removed atomically.
      const [row] = await db
        .delete(schema.mcpConnections)
        .where(eq(schema.mcpConnections.id, id))
        .returning({ id: schema.mcpConnections.id })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `mcp connection ${id} not found`,
        })
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type McpConnectionsRouter = typeof mcpConnectionsRouter

// ─── Local helper ────────────────────────────────────────────────────────

type PatchBody = z.infer<typeof mcpConnectionUpdateInputSchema>

/**
 * Mimics `mcpConnectionCreateInputSchema.superRefine` by running the shared
 * `applyTransportPolicy` helper against a PATCH body merged with the stored
 * transport. We don't re-parse the whole row — we just need the fields the
 * policy reads (`transport`, `commandOrUrl`, `argsJson`, `env`, `headers`).
 *
 * The policy's `enforceUrlFormat` is conditional: we only check URL format
 * when the caller is actually patching `commandOrUrl`, otherwise the rule
 * would fire against an untouched stored value.
 */
function refineMergedPatch(
  transport: (typeof schema.mcpConnections.$inferSelect)['transport'],
  body: PatchBody,
):
  | { success: true }
  | { success: false; error: { issues: readonly unknown[] } } {
  const issues: unknown[] = []
  const ctx: z.RefinementCtx = {
    addIssue: (issue: unknown) => {
      issues.push(issue)
    },
  } as unknown as z.RefinementCtx

  applyTransportPolicy(
    {
      transport,
      commandOrUrl: body.commandOrUrl,
      argsJson: body.argsJson,
      env: body.env,
      headers: body.headers,
    },
    ctx,
    { enforceUrlFormat: body.commandOrUrl !== undefined },
  )

  if (issues.length > 0) {
    return { success: false, error: { issues } }
  }
  return { success: true }
}
