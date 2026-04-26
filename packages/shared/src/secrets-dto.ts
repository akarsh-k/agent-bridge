/**
 * Pure-types DTOs for secret handling. Lives in the browser-safe entry because
 * the frontend needs this shape to render the "(set, 16 chars)" sentinel UI.
 */

export interface SecretSentinel {
  readonly set: boolean
  readonly length: number
}

/**
 * Input shape for API routes that accept a secret. Caller either sets a new
 * value or signals "leave unchanged" — plaintext never round-trips.
 */
export type SecretInput =
  | { readonly action: 'set'; readonly plaintext: string }
  | { readonly action: 'unchanged' }
  | { readonly action: 'clear' }
