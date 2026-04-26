/**
 * Error-envelope helpers. Every backend route uses these so the frontend
 * always gets the same shape on success / failure:
 *
 *   success:  { ok: true, …payload }
 *   failure:  { ok: false, error: { code, message, details? } }
 *
 * HTTP status codes are derived from `ErrorCode`, not hand-rolled per route,
 * so we never accidentally return `200 { ok: false }` (which breaks
 * client-side switches) or `500` for a validation bug.
 */

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type ApiError, type ErrorCode } from '@agent-bridge/shared'
import { env } from '../env.js'

/**
 * Structural subset of `ZodError` we rely on. Declared locally so we don't
 * couple to the `ZodError` vs `$ZodError` split between Zod v4 and
 * `@hono/zod-validator`'s internal types.
 */
interface ZodErrorLike {
  readonly issues: readonly unknown[]
}

const DEFAULT_STATUS_FOR_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  internal: 500,
}

export interface ErrorOptions {
  code: ErrorCode
  message: string
  details?: unknown
  /** Override the default HTTP status for this code. Rarely needed. */
  status?: ContentfulStatusCode
}

/**
 * Serialize an error response. Prefer `httpError()` in handlers (returns a
 * Hono response directly).
 */
export function buildApiError(options: ErrorOptions): ApiError {
  return {
    ok: false,
    error: {
      code: options.code,
      message: options.message,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  }
}

/**
 * Return a `{ ok: false, error }` response with the right HTTP status code.
 * Use this as the *only* way routes surface errors.
 */
export function httpError(c: Context, options: ErrorOptions) {
  const status = options.status ?? DEFAULT_STATUS_FOR_CODE[options.code]
  return c.json(buildApiError(options), status)
}

/** Shorthand for Zod validation failures. */
export function httpValidationError(c: Context, err: ZodErrorLike) {
  return httpError(c, {
    code: 'validation_failed',
    message: 'Request validation failed',
    details: err.issues,
  })
}

/**
 * Global `onError` handler. Keeps prod responses free of stack traces while
 * still logging them server-side. Use in `app.onError(...)`.
 */
export function onUnhandledError(err: unknown, c: Context) {
  console.error('[onError]', err)

  const message = err instanceof Error ? err.message : 'Unknown error'

  return httpError(c, {
    code: 'internal',
    message: env.isProd ? 'Internal server error' : message,
  })
}
