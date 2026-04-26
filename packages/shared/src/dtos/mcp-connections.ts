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
import {
  secretMapInputSchema,
  secretSentinelSchema,
} from './secrets.js'

const transportSchema = z.enum(mcpTransports)

const HTTP_TRANSPORTS: readonly McpTransport[] = ['http', 'sse']
function isHttpTransport(t: McpTransport): boolean {
  return HTTP_TRANSPORTS.includes(t)
}

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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type McpConnectionResponse = z.infer<
  typeof mcpConnectionResponseSchema
>

export const mcpConnectionIdParamSchema = z.object({ id: z.uuid() })
export type McpConnectionIdParam = z.infer<
  typeof mcpConnectionIdParamSchema
>

// ─── Transport policy helper (re-used by create + PATCH merge) ───────────

interface TransportPolicyShape {
  transport: McpTransport
  commandOrUrl?: string | undefined
  argsJson?: readonly string[] | undefined
  env?: { action: 'set' | 'clear' | 'unchanged' } | undefined
  headers?: { action: 'set' | 'clear' | 'unchanged' } | undefined
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
  } else {
    // stdio
    if (v.headers && v.headers.action === 'set') {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `headers are not applicable to transport="stdio"; use env`,
      })
    }
  }
}
