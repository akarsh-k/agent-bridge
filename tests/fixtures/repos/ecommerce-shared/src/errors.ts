/**
 * Wire-level error envelope shared by frontend + backend.
 *
 * The backend serialises any uncaught exception as `{ code, message }`;
 * the frontend's `api.ts` parses non-2xx responses into an `ApiError`.
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }

  static fromResponse(status: number, body: unknown): ApiError {
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>
      const code = typeof b['code'] === 'string' ? b['code'] : 'unknown_error'
      const message = typeof b['message'] === 'string' ? b['message'] : `HTTP ${status}`
      return new ApiError(code, message, status)
    }
    return new ApiError('unknown_error', `HTTP ${status}`, status)
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}
