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
