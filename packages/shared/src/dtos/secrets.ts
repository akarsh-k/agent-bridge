/**
 * DTOs for handling user-supplied secrets across the API boundary.
 *
 * Two shapes, and they MUST stay asymmetric by design:
 *
 *   `SecretInput`      ─── client → server ───▶  may carry plaintext
 *   `SecretSentinel`   ◀── server → client ───   never carries plaintext
 *
 * The three-state `action` enum ('set' | 'unchanged' | 'clear') exists so that
 * omitting the field in a PATCH body unambiguously means "leave alone" —
 * distinct from `null` (clear) and from a new value ('set'). A missing key
 * must never accidentally wipe a stored secret.
 *
 * Browser-safe: no Node APIs. The frontend imports both the types and the
 * Zod schemas to validate forms before POST and to render the sentinel.
 */

import { z } from 'zod'

/**
 * Server → client shape. Deliberately NO `length` field — exposing it would
 * (a) force N × decrypt on every list read, and (b) narrow an attacker's
 * guess space if the sentinel were ever visible on a shared screen. The UI
 * renders a fixed-width mask regardless of the underlying secret length.
 */
export interface SecretSentinel {
  readonly set: boolean
}

export const secretSentinelSchema = z
  .object({
    set: z.boolean(),
  })
  .strict()

/**
 * Client → server shape. The union is the API contract: callers must pick
 * exactly one action. We keep `plaintext` optional at the top level and
 * refine below so Zod rejects `{ action: 'set' }` with no plaintext, and
 * rejects `{ action: 'unchanged', plaintext: 'oops' }` to avoid confused
 * intent.
 */
export type SecretInput =
  | { readonly action: 'set'; readonly plaintext: string }
  | { readonly action: 'unchanged' }
  | { readonly action: 'clear' }

/**
 * Reasonable upper bound on a single secret. 8 KiB is well above anything
 * realistic (longest plausible JWT, SSH key material encoded as base64, etc.)
 * while still bounding memory and log-redaction cost.
 */
const MAX_SECRET_PLAINTEXT_BYTES = 8 * 1024

export const secretInputSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('set'),
        plaintext: z
          .string()
          .min(1, 'plaintext cannot be empty; use action=clear to delete')
          .max(
            MAX_SECRET_PLAINTEXT_BYTES,
            `plaintext exceeds ${MAX_SECRET_PLAINTEXT_BYTES}-byte limit`,
          ),
      })
      .strict(),
    z
      .object({
        action: z.literal('unchanged'),
      })
      .strict(),
    z
      .object({
        action: z.literal('clear'),
      })
      .strict(),
  ])

// Compile-time guard: the Zod-inferred input shape must match the TS union.
// If either side drifts, this assertion stops compiling.
const _typecheck: SecretInput = {} as z.infer<typeof secretInputSchema>
void _typecheck

// ─── Map-valued secrets (env vars, HTTP headers) ─────────────────────────

/**
 * `SecretMapInput` is the same three-state protocol as `SecretInput`, but the
 * plaintext is a string-to-string map (e.g. environment variables for an MCP
 * stdio child, or HTTP headers for an MCP HTTP endpoint). The backend
 * `JSON.stringify`s the map before calling `encryptSecret`, so the on-disk
 * envelope format is byte-for-byte identical to string secrets. The semantic
 * difference lives only in the input shape and the post-decrypt `JSON.parse`.
 *
 * Why a separate shape (rather than making callers stringify themselves):
 *   - The server can validate key/value shape at the input boundary (no CR/LF
 *     injection, no giant values) BEFORE crypto happens. After encryption the
 *     plaintext is sealed and we'd be validating on decrypt — wrong layer.
 *   - Round-tripping `{name: "X"}` through JSON in the browser and
 *     reconstructing an object on the server is brittle; let Zod handle it.
 */
export type SecretMapInput =
  | {
      readonly action: 'set'
      readonly plaintext: Readonly<Record<string, string>>
    }
  | { readonly action: 'unchanged' }
  | { readonly action: 'clear' }

/**
 * Bounds for a single entry and for the map as a whole. Env-var and header
 * worlds both live comfortably under these. Values are bounded so we reject
 * accidental multi-MB blobs before they enter the crypto path.
 */
const MAP_KEY_MIN = 1
const MAP_KEY_MAX = 100
const MAP_VALUE_MAX = 4 * 1024
const MAP_MAX_ENTRIES = 100

/**
 * Keys are conservative: printable ASCII, no whitespace, no control chars, no
 * colon/equals. This is a superset of POSIX env-var names and a subset of
 * RFC 7230 header tokens — strict enough to catch typos, loose enough that
 * both kinds of callers (stdio env, HTTP headers) fit.
 */
const MAP_KEY_RE = /^[A-Za-z0-9_.\-]+$/

const mapKeySchema = z
  .string()
  .min(MAP_KEY_MIN)
  .max(MAP_KEY_MAX)
  .regex(MAP_KEY_RE, {
    message: 'key must match [A-Za-z0-9_.-]+ (no spaces, control chars)',
  })

/**
 * Values forbid CR/LF specifically to neutralise header-injection attempts
 * and to avoid shell surprises in env-var values that get echoed somewhere.
 */
const mapValueSchema = z
  .string()
  .max(MAP_VALUE_MAX, `value exceeds ${MAP_VALUE_MAX}-byte limit`)
  .refine((v) => !/[\r\n]/.test(v), {
    message: 'value cannot contain CR or LF (injection guard)',
  })

const secretMapSchema = z
  .record(mapKeySchema, mapValueSchema)
  .refine((m) => Object.keys(m).length <= MAP_MAX_ENTRIES, {
    message: `map exceeds ${MAP_MAX_ENTRIES}-entry limit`,
  })

export const secretMapInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('set'),
      plaintext: secretMapSchema,
    })
    .strict(),
  z.object({ action: z.literal('unchanged') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
])

// Same compile-time drift guard as for `SecretInput`.
const _typecheckMap: SecretMapInput = {} as z.infer<typeof secretMapInputSchema>
void _typecheckMap
