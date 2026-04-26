/**
 * Backend-side helpers that bridge the API's `SecretInput` / `SecretSentinel`
 * DTOs to the on-disk `v1.<iv>.<tag>.<ct>` envelopes stored in Postgres.
 *
 * Every route that accepts or returns a secret (LLM API keys, repo PATs, MCP
 * env vars / headers) funnels through THESE two functions:
 *
 *   applySecretInput(existingEnvelope, input) → new envelope (or null)
 *   envelopeToSentinel(envelope)               → `{ set: boolean }`
 *
 * Contract:
 *   - plaintext NEVER crosses `describeSecret` / `envelopeToSentinel` — they
 *     do a structural check only, so list endpoints stay cheap.
 *   - `applySecretInput` is the ONLY function in the backend allowed to call
 *     `encryptSecret`. Grep should return exactly one call site per subphase;
 *     reviewers can trust that secret ingress is gated in one place.
 *   - A missing `input` (i.e. the PATCH body omitted the field entirely) is
 *     treated identically to `{ action: 'unchanged' }` — no-op, don't touch
 *     the stored value. This is why the union has three explicit actions.
 */

import {
  describeSecret,
  encryptSecret,
} from '@agent-bridge/shared/crypto'
import type { SecretInput, SecretSentinel } from '@agent-bridge/shared'

/**
 * Reconcile a `SecretInput` against the currently-stored envelope.
 * Returns the envelope to WRITE back to the DB, OR the sentinel value
 * `undefined` meaning "don't touch this column".
 *
 * We intentionally use `undefined` (not `null`) for no-op: Drizzle's
 * `.set({})` ignores undefined fields, which is the semantics we want for
 * PATCH composition. Callers assemble their update object like:
 *
 *   const apiKey = applySecretInput(row.apiKeyEnvelope, body.apiKey)
 *   await db.update(llmProviders).set({
 *     ...(apiKey !== SECRET_UNCHANGED && { apiKeyEnvelope: apiKey }),
 *   })
 */
export const SECRET_UNCHANGED = Symbol('secret-unchanged')
export type SecretUnchanged = typeof SECRET_UNCHANGED

export function applySecretInput(
  input: SecretInput | undefined,
): string | null | SecretUnchanged {
  if (!input || input.action === 'unchanged') return SECRET_UNCHANGED
  if (input.action === 'clear') return null
  // action === 'set'
  return encryptSecret(input.plaintext)
}

/**
 * For CREATE operations, where "unchanged" doesn't make sense (there is no
 * prior value). Collapses the tri-state to a two-state: envelope-or-null.
 * Treats both 'unchanged' and missing as "don't set anything".
 */
export function applySecretInputForCreate(
  input: SecretInput | undefined,
): string | null {
  if (!input || input.action === 'unchanged' || input.action === 'clear') {
    return null
  }
  return encryptSecret(input.plaintext)
}

/**
 * Envelope → outbound sentinel. Pure structural; never decrypts.
 * Safe to call on every row in a list without perf concerns.
 */
export function envelopeToSentinel(
  envelope: string | null | undefined,
): SecretSentinel {
  return describeSecret(envelope)
}
