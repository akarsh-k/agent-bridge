/**
 * Internal types shared by every per-kind connector.
 *
 * The wire-format result (`LlmProviderTestResponse`) lives in
 * `@agent-bridge/shared/dtos/llm-providers`; the connector-level shape
 * below is a lighter version — the dispatcher fills in `durationMs` and
 * `kind` so each connector can stay focused on the probe itself.
 *
 * Errors always carry a `code` from the fixed taxonomy so the UI can map
 * to user-facing copy without parsing `message`. If a connector sees
 * something it can't classify, it uses `unknown` — never `throw`.
 */

import type { LlmProviderTestResponse } from '@agent-bridge/shared'

/** Input every connector takes. `apiKey` is already-decrypted plaintext. */
export interface ConnectorInput {
  readonly baseUrl: string
  readonly apiKey: string | null
  /**
   * Model to smoke-test with. When `null`, connectors fall back to a
   * reachability probe (e.g. "list models") instead of a completion.
   */
  readonly model: string | null
  /**
   * Which API surface to exercise. Defaults to `'chat'` — the historical
   * behavior. `'embedding'` flips the connector to `/v1/embeddings`,
   * used so users can verify the embedding model semantic-recall picks.
   */
  readonly capability?: 'chat' | 'embedding'
}

/**
 * Connector return shape. The dispatcher stamps `durationMs` and `kind`
 * onto this to produce the wire-format response.
 */
export type ConnectorResult =
  | {
      readonly ok: true
      readonly stage: 'reachable' | 'inference'
      readonly model: string | null
      readonly message: string
      readonly sample: string | null
    }
  | {
      readonly ok: false
      readonly code: Extract<LlmProviderTestResponse, { ok: false }>['code']
      readonly message: string
    }

/** Uniform request timeout across every connector. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * One-shot chat prompt sent when `model` is set. Kept deliberately short:
 *   - `Reply with OK` is well-known to most instruct-tuned models so the
 *     response is predictable (surfaces "auth works but model refuses to
 *     generate" class of failures that a pure reachability probe misses).
 *   - `max_tokens: 8` bounds cost at ~fractions of a cent.
 */
export const SMOKE_PROMPT = 'Reply with OK.'
export const SMOKE_MAX_TOKENS = 8

/** Truncate a sample reply for display. Keeps the JSON payload tidy. */
export function truncateSample(s: string, max = 120): string {
  const cleaned = s.trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Classify a `fetch`-side exception. Keeps each connector from repeating
 * the DNS/abort/connect-refused plumbing.
 */
export function classifyFetchError(err: unknown): ConnectorResult {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return {
      ok: false,
      code: 'timeout',
      message: `request exceeded ${REQUEST_TIMEOUT_MS / 1_000}s timeout`,
    }
  }
  // Node's `fetch` wraps low-level errors in a generic TypeError with a
  // `.cause`. Inspect the cause to produce a useful message without
  // leaking internal stack traces.
  if (err instanceof TypeError) {
    const cause = (err as TypeError & { cause?: unknown }).cause
    const code = typeof cause === 'object' && cause && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : null
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { ok: false, code: 'unreachable', message: 'DNS lookup failed' }
    }
    if (code === 'ECONNREFUSED') {
      return { ok: false, code: 'unreachable', message: 'connection refused' }
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return { ok: false, code: 'unreachable', message: 'connection reset' }
    }
    return {
      ok: false,
      code: 'unreachable',
      message: err.message || 'network error',
    }
  }
  return {
    ok: false,
    code: 'unknown',
    message: err instanceof Error ? err.message : 'unknown error',
  }
}

/**
 * Classify an HTTP non-2xx. The connector has already observed the
 * status and typically peeked at the body — pass the status in, the body
 * (truncated) as context, and get a ConnectorResult back.
 */
export function classifyHttpError(
  status: number,
  bodySnippet: string,
): ConnectorResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: 'auth',
      message: status === 401 ? 'unauthorized (bad API key)' : 'forbidden',
    }
  }
  if (status === 429) {
    return { ok: false, code: 'rate_limited', message: 'rate limited' }
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'invalid_model',
      message: 'model or endpoint not found',
    }
  }
  if (status === 400) {
    // Most OpenAI-family servers return 400 when the model name is bad.
    const hay = bodySnippet.toLowerCase()
    if (hay.includes('model')) {
      return {
        ok: false,
        code: 'invalid_model',
        message: 'model rejected by server',
      }
    }
    return {
      ok: false,
      code: 'upstream',
      message: `bad request: ${truncateSample(bodySnippet)}`,
    }
  }
  if (status >= 500) {
    return {
      ok: false,
      code: 'upstream',
      message: `upstream ${status}`,
    }
  }
  return {
    ok: false,
    code: 'unknown',
    message: `unexpected status ${status}`,
  }
}

/**
 * Strip trailing slashes. URL-joining helper — every vendor endpoint is
 * a suffix off the base; joining with a trailing slash produces
 * `//v1/...` double-slashes that some reverse proxies dislike.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  const p = path.startsWith('/') ? path : `/${path}`
  return b + p
}
