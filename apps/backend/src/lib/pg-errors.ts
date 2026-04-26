/**
 * Helpers for turning Postgres driver errors into API-friendly error codes.
 *
 * Why this exists:
 *   Drizzle wraps the underlying `postgres.PostgresError` inside its own
 *   `DrizzleQueryError`, so the SQLSTATE we actually want to branch on
 *   (e.g. `23505` unique violation, `23503` FK violation) lives on
 *   `err.cause`, not on `err` itself. If we only check the top-level error
 *   we silently fall through to the generic 500 handler, which leaks raw
 *   SQL text to the client. Always go through this helper.
 *
 *   Walking 5 levels deep is defensive: some driver paths double-wrap, and
 *   we'd rather miss a theoretical 6-deep nesting than infinite-loop on a
 *   self-referential cause chain.
 */

/**
 * Common Postgres SQLSTATEs we actually branch on. Using a string-literal
 * union keeps call sites readable (`isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)`)
 * instead of magic numbers sprinkled through routes.
 */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
} as const

const MAX_CAUSE_DEPTH = 5

export function isPostgresErrorWithCode(err: unknown, code: string): boolean {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      (current as { code?: unknown }).code === code
    ) {
      return true
    }
    current =
      typeof current === 'object' && current && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : null
  }
  return false
}
