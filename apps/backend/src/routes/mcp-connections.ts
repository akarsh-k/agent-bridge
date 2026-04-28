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
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  applyTransportPolicy,
  mcpConnectionCreateInputSchema,
  mcpConnectionDiscoverInputSchema,
  mcpConnectionIdParamSchema,
  mcpConnectionResponseSchema,
  mcpConnectionTestPollResponseSchema,
  mcpConnectionUpdateInputSchema,
  type DiscoveredMcpTool,
  type McpAuthResponse,
  type McpConnectionResponse,
  type McpConnectionTestPollResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { env } from '../env.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { testMcpConnection } from '../lib/mcp-connections/discover.js'
import {
  getTestSessionRegistry,
  type TestSessionSnapshot,
  type TestSessionStatus,
} from '../lib/mcp-connections/test-sessions.js'
import type { Context } from 'hono'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import {
  applySecretMapInput,
  applySecretMapInputForCreate,
  envelopeToSentinel,
  SECRET_UNCHANGED,
} from '../lib/secrets.js'

type McpConnectionRow = typeof schema.mcpConnections.$inferSelect

/**
 * Serialize a `mcp_connections` row to its wire shape. `hasOauthTokens`
 * is pre-computed by the caller (single lookup for the singleton
 * endpoints, one batched IN-query for the list endpoint) so this helper
 * never touches the DB — keeps serialization trivial to test.
 */
function toMcpConnectionResponse(
  row: McpConnectionRow,
  hasOauthTokens: boolean,
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
    auth: buildAuthResponse(row.authKind, hasOauthTokens),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function buildAuthResponse(
  kind: McpConnectionRow['authKind'],
  hasOauthTokens: boolean,
): McpAuthResponse {
  if (kind === 'oauth') return { kind: 'oauth', hasTokens: hasOauthTokens }
  return { kind }
}

/**
 * One-shot helper for singleton endpoints. Skips the DB round-trip for
 * non-oauth rows since those never carry tokens.
 */
async function hasOauthTokensFor(
  db: ReturnType<typeof getDb>['db'],
  row: McpConnectionRow,
): Promise<boolean> {
  if (row.authKind !== 'oauth') return false
  const [hit] = await db
    .select({ id: schema.mcpOauthState.mcpConnectionId })
    .from(schema.mcpOauthState)
    .where(
      and(
        eq(schema.mcpOauthState.mcpConnectionId, row.id),
        eq(schema.mcpOauthState.scopeKey, 'tokens'),
      ),
    )
    .limit(1)
  return Boolean(hit)
}

/**
 * Long-poll timeout for `/test/poll`. Picked to sit comfortably below
 * the 30 s default that most reverse proxies and load balancers enforce
 * on idle HTTP connections — a 25 s suspend leaves a margin for client
 * RTT without the risk of a 504.
 */
const POLL_TIMEOUT_MS = 25_000

/**
 * Translate a `TestSessionSnapshot` to the on-wire
 * `McpConnectionTestPollResponse`. Identical shape as the POST /test
 * response so the frontend uses one reducer.
 */
function snapshotToResponse(
  snap: TestSessionSnapshot,
): McpConnectionTestPollResponse {
  switch (snap.status) {
    case 'pending':
    case 'authorize_required': {
      return mcpConnectionTestPollResponseSchema.parse({
        ok: false,
        durationMs: Date.now() - snap.startedAt,
        transport: snap.transport,
        code: 'authorize_required',
        message:
          snap.status === 'authorize_required'
            ? 'waiting for the user to approve in the upstream consent UI'
            : 'probe in flight',
        sessionId: snap.sessionId,
        authorizeUrl:
          snap.status === 'authorize_required' ? snap.authorizeUrl : undefined,
      })
    }
    case 'ok': {
      const tools: DiscoveredMcpTool[] = snap.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { ...t.inputSchema },
      }))
      return mcpConnectionTestPollResponseSchema.parse({
        ok: true,
        durationMs: snap.durationMs,
        transport: snap.transport,
        tools,
        toolCount: snap.rawToolCount,
        serverVersion: snap.serverVersion,
        message:
          snap.rawToolCount === 0
            ? 'authorized but server advertised no tools'
            : `authorized · ${snap.rawToolCount} tool(s)`,
      })
    }
    case 'failed': {
      return mcpConnectionTestPollResponseSchema.parse({
        ok: false,
        durationMs: snap.durationMs,
        transport: snap.transport,
        code: snap.code,
        message: snap.message,
      })
    }
  }
}

/**
 * Absolute URL upstream authorization servers should redirect back to
 * after the user approves. Pinned to `http://localhost:${PORT}` —
 * loopback is the RFC 8252–recommended redirect target for local
 * native apps, and it's the only host the user's browser can actually
 * reach when the backend binds to `127.0.0.1`. We ignore `env.HOST`
 * deliberately: an operator running `HOST=0.0.0.0` still wants the
 * browser to land on `localhost`.
 *
 * Must match `redirect_uris` in the dynamic client registration
 * byte-for-byte; Notion is strict about this.
 */
function buildOauthCallbackUrl(_c: Context, connectionId: string): string {
  return `http://localhost:${env.PORT}/oauth/mcp/${connectionId}/callback`
}

/**
 * Batched variant used by the list endpoint — builds a `Set` of
 * connection IDs that have a cached `tokens` row. O(1) IN-query instead
 * of N LIMIT-1 SELECTs.
 */
async function oauthTokenSetFor(
  db: ReturnType<typeof getDb>['db'],
  rows: readonly McpConnectionRow[],
): Promise<ReadonlySet<string>> {
  const oauthIds = rows.filter((r) => r.authKind === 'oauth').map((r) => r.id)
  if (oauthIds.length === 0) return new Set()
  const hits = await db
    .select({ id: schema.mcpOauthState.mcpConnectionId })
    .from(schema.mcpOauthState)
    .where(
      and(
        inArray(schema.mcpOauthState.mcpConnectionId, oauthIds),
        eq(schema.mcpOauthState.scopeKey, 'tokens'),
      ),
    )
  return new Set(hits.map((h) => h.id))
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
            authKind: body.auth?.kind ?? 'none',
            allowHostHome: body.allowHostHome ?? false,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        // Fresh row can't have cached tokens yet — skip the lookup.
        return c.json(
          {
            ok: true as const,
            mcpConnection: toMcpConnectionResponse(row, false),
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

    const tokenSet = await oauthTokenSetFor(db, rows)

    return c.json({
      ok: true as const,
      mcpConnections: rows.map((r) =>
        toMcpConnectionResponse(r, tokenSet.has(r.id)),
      ),
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

      const hasTokens = await hasOauthTokensFor(db, row)
      return c.json({
        ok: true as const,
        mcpConnection: toMcpConnectionResponse(row, hasTokens),
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
      if ('auth' in body && body.auth) patch.authKind = body.auth.kind

      const nextEnv = applySecretMapInput(body.env)
      if (nextEnv !== SECRET_UNCHANGED) patch.envEnvelope = nextEnv

      const nextHeaders = applySecretMapInput(body.headers)
      if (nextHeaders !== SECRET_UNCHANGED) {
        patch.headersEnvelope = nextHeaders
      }

      // If the auth kind is flipping AWAY from 'oauth', the cached
      // tokens are suddenly dead weight — drop them so the UI's
      // `hasTokens` flag matches observable reality and the next
      // `auth: oauth` round doesn't accidentally re-use stale creds.
      if (
        'auth' in body &&
        body.auth &&
        body.auth.kind !== 'oauth' &&
        existing.authKind === 'oauth'
      ) {
        await db
          .delete(schema.mcpOauthState)
          .where(eq(schema.mcpOauthState.mcpConnectionId, id))
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

        const hasTokens = await hasOauthTokensFor(db, row)
        return c.json({
          ok: true as const,
          mcpConnection: toMcpConnectionResponse(row, hasTokens),
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
  // ─── POST /api/mcp-connections/:id/test ──────────────────────────────────
  //
  // Live smoke check against the saved row. Optional body lets the caller
  // override any of `commandOrUrl`, `argsJson`, `env`, `headers`, or
  // `allowHostHome` for this one call — used by the create/edit drawer so
  // the operator can verify a draft before persisting. Omitted fields
  // fall through to the stored values; `env: { action: 'unchanged' }`
  // and a missing `env` behave identically.
  //
  // Decrypt happens inside `testMcpConnection` — this handler never
  // touches plaintext. 2xx always carries a `McpConnectionDiscoverResponse`;
  // 4xx/5xx are reserved for envelope-level errors (404, validation).
  // A failed *smoke test* against a reachable-but-broken MCP is still
  // 200 with `{ ok: false, code, message }` so clients have a single
  // success-path parser and only transport-level errors to handle via
  // `ApiError`.
  .post(
    '/:id/test',
    zValidator('param', mcpConnectionIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', mcpConnectionDiscoverInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
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

      // Re-run the transport-policy refine against the merged draft so a
      // "test with these overrides" can't escape the invariants (e.g.
      // testing a stdio row with `allowHostHome: true` is fine, but
      // testing an http row with `allowHostHome: true` is not).
      const refineResult = refineMergedPatch(row.transport, {
        commandOrUrl: body.commandOrUrl,
        argsJson: body.argsJson,
        env: body.env,
        headers: body.headers,
        auth: body.auth,
        allowHostHome: body.allowHostHome,
      })
      if (!refineResult.success) {
        return httpValidationError(c, refineResult.error)
      }

      const result = await testMcpConnection(
        {
          id: row.id,
          transport: row.transport,
          commandOrUrl: row.commandOrUrl,
          argsJson: row.argsJson,
          envEnvelope: row.envEnvelope,
          headersEnvelope: row.headersEnvelope,
          authKind: row.authKind,
          allowHostHome: row.allowHostHome,
        },
        body,
        {
          db,
          redirectUrl: buildOauthCallbackUrl(c, row.id),
        },
      )

      return c.json({ ok: true as const, result })
    },
  )
  // ─── GET /api/mcp-connections/:id/test/poll ──────────────────────────────
  //
  // Long-poll for the next state change of the OAuth test session
  // started by `POST /.../test`. Returns immediately if the session's
  // current status differs from the caller's last-seen status, else
  // suspends for up to ~25 s waiting for a flip. Returns the same
  // wire shape as the POST endpoint (reuses the discover response
  // schema) so the frontend can run a single reducer for both.
  //
  // Clients should loop on this endpoint until they see a terminal
  // status (`ok: true`, or `ok: false` with a code that is not
  // `authorize_required`). There is no separate "done" signal; HTTP
  // 404 is returned when the session expired (TTL).
  .get(
    '/:id/test/poll',
    zValidator('param', mcpConnectionIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator(
      'query',
      z.object({
        sessionId: z.string().uuid(),
        // The status the caller last observed; if it's still the
        // current status, the endpoint suspends. Omitting defaults to
        // `pending`, which is the state a fresh caller would assume.
        lastSeen: z
          .enum(['pending', 'authorize_required'])
          .optional()
          .default('pending'),
      }),
      (result, c) => {
        if (!result.success) return httpValidationError(c, result.error)
        return
      },
    ),
    async (c) => {
      const { id } = c.req.valid('param')
      const { sessionId, lastSeen } = c.req.valid('query')
      const registry = getTestSessionRegistry()

      const current = registry.get(sessionId)
      if (!current || current.connectionId !== id) {
        return httpError(c, {
          code: 'not_found',
          message: `test session ${sessionId} not found for connection ${id}`,
          status: 404,
        })
      }

      const snap = await registry.waitForChange(
        sessionId,
        lastSeen as TestSessionStatus,
        POLL_TIMEOUT_MS,
      )

      const result: McpConnectionTestPollResponse = snapshotToResponse(snap)
      return c.json({ ok: true as const, result })
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
      auth: body.auth,
      allowHostHome: body.allowHostHome,
    },
    ctx,
    { enforceUrlFormat: body.commandOrUrl !== undefined },
  )

  if (issues.length > 0) {
    return { success: false, error: { issues } }
  }
  return { success: true }
}
