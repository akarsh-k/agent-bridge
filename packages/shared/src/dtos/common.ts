/**
 * Cross-cutting DTOs reused by every REST handler. Browser-safe — no Node APIs.
 *
 * Shape discipline:
 *   - Success responses are `{ ok: true, ...payload }`.
 *   - Error responses are `{ ok: false, error: { code, message, details? } }`.
 *   - `code` is a finite enum so the frontend can switch on it without parsing
 *     human strings. `message` is for humans; `details` is optional structured
 *     context (e.g. Zod issues).
 *
 * Adding a new code: add it to `errorCodes`, add a matching HTTP status in
 * `DEFAULT_STATUS_FOR_CODE` (see backend/src/lib/errors.ts), done.
 */

import { z } from 'zod'

export const errorCodes = [
  'validation_failed',
  'not_found',
  'conflict',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'internal',
] as const

export type ErrorCode = (typeof errorCodes)[number]

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(errorCodes),
    message: z.string(),
    /** Optional structured context (e.g. Zod issue list). */
    details: z.unknown().optional(),
  }),
})

export type ApiError = z.infer<typeof apiErrorSchema>

/**
 * Helper type for a successful response body. Endpoints compose this with
 * their payload type: `OkResponse<{ agent: AgentResponse }>`.
 */
export type OkResponse<T> = { ok: true } & T

export type ApiResult<T> = OkResponse<T> | ApiError

/** Tiny type-guard you can use from the frontend to narrow `ApiResult`. */
export function isApiError(value: ApiResult<unknown>): value is ApiError {
  return value.ok === false
}
