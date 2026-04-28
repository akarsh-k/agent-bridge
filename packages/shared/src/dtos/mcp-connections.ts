/**
 * MCP connection DTOs. Browser-safe; shared between frontend and backend.
 *
 * An MCP connection is a global (single-operator) pointer to an external MCP
 * server that the Mastra agent may consume tools from. Transport-driven
 * field policy — enforced by `.superRefine` — keeps the schema honest:
 *
 *   stdio   → `commandOrUrl` is an executable + `argsJson`; `env` allowed,
 *             `headers` forbidden.
 *   http/sse→ `commandOrUrl` is a URL; `argsJson` must be `[]`; `env`
 *             forbidden, `headers` allowed.
 *
 * Two secret envelopes on one resource (`env`, `headers`) exercise the
 * `SecretMapInput` pipeline. Each is a separate three-state input with its
 * own sentinel in the response — you can rotate one without touching the
 * other, and `describeSecret` stays cheap for list reads.
 *
 * `transport` is immutable post-creation — same rationale as `kind` on
 * llm-providers. A transport flip silently invalidates `commandOrUrl`,
 * argsJson, and the meaning of each envelope. Caller re-creates instead.
 */

import { z } from 'zod'
import { mcpTransports, type McpTransport } from '../domain.js'
import { secretMapInputSchema, secretSentinelSchema } from './secrets.js'
import { mcpToolNameSchema } from './agent-mcp-tools.js'

const transportSchema = z.enum(mcpTransports)

const HTTP_TRANSPORTS: readonly McpTransport[] = ['http', 'sse']
function isHttpTransport(t: McpTransport): boolean {
  return HTTP_TRANSPORTS.includes(t)
}

// ─── Auth discriminator ──────────────────────────────────────────────────

/**
 * Inbound auth selector. No per-kind parameters for now — OAuth uses the
 * MCP auth spec's defaults (dynamic client registration + whatever scopes
 * the upstream advertises), and `headers` draws from the existing
 * `headers` envelope. Future extensions (explicit scopes, PKCE flavor
 * overrides, resource indicators) can be added per branch without
 * breaking the on-wire shape.
 */
export const mcpAuthInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('oauth') }).strict(),
  z.object({ kind: z.literal('headers') }).strict(),
])

export type McpAuthInput = z.infer<typeof mcpAuthInputSchema>

/**
 * Outbound auth descriptor. `oauth` carries a presence flag so the UI
 * can render "Authorize" (no tokens yet) vs "Re-authorize" (cached
 * tokens on file) without a separate round-trip. All other kinds are
 * pure discriminators.
 */
export const mcpAuthResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({ kind: z.literal('oauth'), hasTokens: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('headers') }).strict(),
])

export type McpAuthResponse = z.infer<typeof mcpAuthResponseSchema>

// ─── Shared field fragments ──────────────────────────────────────────────

const nameSchema = z.string().trim().min(1).max(120)

/**
 * `commandOrUrl` is overloaded by transport. For stdio we accept any
 * non-empty printable string (the spawn call will fail loudly if the path
 * is wrong). For http/sse we want a URL; we validate that in the refine
 * below rather than at the field level so the error carries `commandOrUrl`
 * in its path.
 */
const commandOrUrlSchema = z.string().trim().min(1).max(1_000)

/**
 * NB: no `.default([])` here. Zod's `.default()` applied to an optional
 * field still materialises the default value even when the input omits the
 * key, which defeats the "PATCH only the keys you sent" logic in route
 * handlers (they use `'argsJson' in body` to detect caller intent). Create
 * handler applies `?? []` explicitly instead.
 */
const argsJsonSchema = z.array(z.string().max(1_000)).max(128)

// ─── Create ──────────────────────────────────────────────────────────────

const createBase = z
  .object({
    name: nameSchema,
    transport: transportSchema,
    commandOrUrl: commandOrUrlSchema,
    argsJson: argsJsonSchema.optional(),
    env: secretMapInputSchema.optional(),
    headers: secretMapInputSchema.optional(),
    /**
     * Defaults to `{ kind: 'none' }` when omitted. `superRefine` runs
     * after this so the transport-auth compatibility check sees the
     * resolved value.
     */
    auth: mcpAuthInputSchema.optional(),
    allowHostHome: z.boolean().optional(),
  })
  .strict()

export const mcpConnectionCreateInputSchema = createBase.superRefine(
  (v, ctx) => {
    applyTransportPolicy(v, ctx, { enforceUrlFormat: true })
  },
)

export type McpConnectionCreateInput = z.infer<
  typeof mcpConnectionCreateInputSchema
>

// ─── Update ──────────────────────────────────────────────────────────────

/**
 * PATCH body. Transport is NOT patchable. Everything else is optional and
 * the transport-policy refine runs after the patch is merged with the
 * existing row (server-side), so a PATCH that sets `headers` on an http
 * row passes and one that sets `headers` on a stdio row fails with a clear
 * message. The Zod schema alone can't reach the DB, so the merge+refine
 * lives in the route handler; here we only validate shape.
 */
export const mcpConnectionUpdateInputSchema = z
  .object({
    name: nameSchema.optional(),
    commandOrUrl: commandOrUrlSchema.optional(),
    argsJson: argsJsonSchema.optional(),
    env: secretMapInputSchema.optional(),
    headers: secretMapInputSchema.optional(),
    auth: mcpAuthInputSchema.optional(),
    allowHostHome: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type McpConnectionUpdateInput = z.infer<
  typeof mcpConnectionUpdateInputSchema
>

// ─── Response ────────────────────────────────────────────────────────────

export const mcpConnectionResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  transport: transportSchema,
  commandOrUrl: z.string(),
  argsJson: z.array(z.string()),
  allowHostHome: z.boolean(),
  /** Presence-only sentinel for the env-vars envelope. */
  env: secretSentinelSchema,
  /** Presence-only sentinel for the headers envelope. */
  headers: secretSentinelSchema,
  auth: mcpAuthResponseSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type McpConnectionResponse = z.infer<typeof mcpConnectionResponseSchema>

export const mcpConnectionIdParamSchema = z.object({ id: z.uuid() })
export type McpConnectionIdParam = z.infer<typeof mcpConnectionIdParamSchema>

// ─── Transport policy helper (re-used by create + PATCH merge) ───────────

interface TransportPolicyShape {
  transport: McpTransport
  commandOrUrl?: string | undefined
  argsJson?: readonly string[] | undefined
  env?: { action: 'set' | 'clear' | 'unchanged' } | undefined
  headers?: { action: 'set' | 'clear' | 'unchanged' } | undefined
  auth?: McpAuthInput | undefined
  /**
   * `allow_host_home` only clamps subprocess env, so it's meaningful on
   * `stdio` only. Setting it to `true` on http/sse is silent
   * misconfiguration — the refine rejects it loudly instead.
   */
  allowHostHome?: boolean | undefined
}

interface TransportPolicyOptions {
  /**
   * For create, `commandOrUrl` is always present; we run URL validation for
   * http/sse. For merge-on-patch the same check runs against the merged
   * effective value.
   */
  enforceUrlFormat: boolean
}

/**
 * Exported so the backend route can re-run the same rules after merging a
 * PATCH against the stored row. Any drift between create-time and patch-
 * time validation would let a PATCH escape the invariants.
 */
export function applyTransportPolicy(
  v: TransportPolicyShape,
  ctx: z.RefinementCtx,
  opts: TransportPolicyOptions,
): void {
  if (isHttpTransport(v.transport)) {
    // http/sse
    if (v.commandOrUrl !== undefined && opts.enforceUrlFormat) {
      try {
        // eslint-disable-next-line no-new
        new URL(v.commandOrUrl)
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['commandOrUrl'],
          message: `commandOrUrl must be a URL for transport="${v.transport}"`,
        })
      }
    }
    if (v.argsJson && v.argsJson.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['argsJson'],
        message: `argsJson must be empty for transport="${v.transport}"`,
      })
    }
    if (v.env && v.env.action === 'set') {
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: `env is not applicable to transport="${v.transport}"; use headers`,
      })
    }
    if (v.allowHostHome === true) {
      // There is no subprocess on http/sse, so there is no HOME env var
      // to clamp. Accepting the flag silently would store a bit that does
      // nothing — confusing for operators reviewing the row later. Reject
      // loudly. Explicit `false` is fine (it's the default).
      ctx.addIssue({
        code: 'custom',
        path: ['allowHostHome'],
        message: `allowHostHome is only meaningful for transport="stdio"`,
      })
    }
    // When OAuth is selected the tokens come from the OAuth cache, not
    // from headers. Allowing both would silently combine a bearer token
    // with the MCP-level Authorization header and produce a 401 with no
    // obvious cause. Make the mutual exclusion explicit here.
    if (v.auth?.kind === 'oauth' && v.headers?.action === 'set') {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message:
          'headers are not applicable when auth.kind="oauth"; tokens come from the OAuth cache',
      })
    }
  } else {
    // stdio
    if (v.headers && v.headers.action === 'set') {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `headers are not applicable to transport="stdio"; use env`,
      })
    }
    // Stdio has no HTTP handshake, so neither OAuth nor static HTTP
    // headers are meaningful. `env` covers the "inject a token into the
    // subprocess" story. Reject anything else explicitly so we don't
    // silently ship a stdio row whose auth_kind column will never be
    // honored.
    if (v.auth && v.auth.kind !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['auth'],
        message: `auth.kind="${v.auth.kind}" is not applicable to transport="stdio"; use env`,
      })
    }
  }
}

// ─── Tool discovery ──────────────────────────────────────────────────────

/**
 * POST /api/mcp-connections/:id/test body — all fields optional. Mirrors
 * `llmProviderTestInputSchema`:
 *
 *   - Missing field → "use the saved value on the row"
 *   - `env` / `headers` with `action: 'set'` → override the saved envelope
 *     for this one test call only (lets the form test a draft before
 *     persisting).
 *   - `env` / `headers` with `action: 'clear'` → test as if the envelope
 *     weren't set. Useful for confirming that an auth-required MCP
 *     actually rejects a no-creds probe.
 *
 * The transport-policy refine re-runs against the merged shape on the
 * backend (mirroring the PATCH-merge pattern): the saved row supplies
 * the `transport` + defaults, the body supplies overrides.
 */
export const mcpConnectionDiscoverInputSchema = z
  .object({
    commandOrUrl: commandOrUrlSchema.optional(),
    argsJson: argsJsonSchema.optional(),
    env: secretMapInputSchema.optional(),
    headers: secretMapInputSchema.optional(),
    auth: mcpAuthInputSchema.optional(),
    allowHostHome: z.boolean().optional(),
  })
  .strict()

export type McpConnectionDiscoverInput = z.infer<
  typeof mcpConnectionDiscoverInputSchema
>

/**
 * Stable taxonomy so UI copy doesn't depend on the humanised `message`.
 *
 * `'authorize_required'` is a *pending* state, not a terminal failure —
 * probe is alive server-side and waiting for the user to finish OAuth
 * approval. The UI should render the `authorizeUrl` (a Notion-style
 * consent page) and poll `/test/poll` with the returned `sessionId`
 * until the state flips to a terminal `ok: true` / `ok: false`. Carried
 * in the `ok: false` shape strictly for wire economy — the UI treats it
 * as an actionable state, not an error.
 */
const discoverErrorCodes = [
  'unreachable',
  'auth',
  'spawn_failed',
  'timeout',
  'authorize_required',
  'unknown',
] as const

export type McpConnectionDiscoverErrorCode = (typeof discoverErrorCodes)[number]

/**
 * Per-tool descriptor the UI renders in the picker. `inputSchema` is
 * whatever JSON Schema the MCP advertises — we pass it through verbatim
 * so the form can later auto-render argument widgets. Keep typing loose:
 * MCP servers vary widely on whether `type`, `required`, and `properties`
 * are even present.
 */
export const discoveredMcpToolSchema = z.object({
  name: mcpToolNameSchema,
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()),
})

export type DiscoveredMcpTool = z.infer<typeof discoveredMcpToolSchema>

/**
 * Discriminated on `ok`. Smoke-test failures (unreachable / auth /
 * spawn_failed / …) stay 2xx with `{ ok: false, code, message }` so the
 * UI only parses a single success envelope and handles transport errors
 * via the generic `ApiError`. Matches the llm-provider test contract.
 */
export const mcpConnectionDiscoverResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      durationMs: z.number().int().nonnegative(),
      transport: z.enum(mcpTransports),
      /** How many tools the MCP advertised total (pre-allowlist). */
      toolCount: z.number().int().nonnegative(),
      tools: z.array(discoveredMcpToolSchema),
      serverVersion: z.string().nullable(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      durationMs: z.number().int().nonnegative(),
      transport: z.enum(mcpTransports),
      code: z.enum(discoverErrorCodes),
      message: z.string(),
      /**
       * Only populated when `code === 'authorize_required'`. `sessionId`
       * is the opaque token the UI uses to long-poll `/test/poll`;
       * `authorizeUrl` is the upstream consent page to open in a new
       * tab.
       */
      sessionId: z.string().min(1).optional(),
      authorizeUrl: z.url().optional(),
    })
    .strict(),
])

export type McpConnectionDiscoverResponse = z.infer<
  typeof mcpConnectionDiscoverResponseSchema
>

// ─── Test-session polling ────────────────────────────────────────────────

/**
 * `GET /api/mcp-connections/:id/test/poll?sessionId=…` envelope. Terminal
 * outcomes (`ok: true`, `ok: false` with any non-pending code) mean the
 * session is done and the server has freed its resources — the UI stops
 * polling. `code: 'authorize_required'` means the user still hasn't
 * approved in the upstream consent UI; keep polling.
 *
 * Shares the same wire shape as the discover response above so the UI
 * can reuse the same reducer for both, and a single `McpTestStrip`
 * state machine covers the lifecycle.
 */
export const mcpConnectionTestPollResponseSchema =
  mcpConnectionDiscoverResponseSchema

export type McpConnectionTestPollResponse =
  McpConnectionDiscoverResponse
