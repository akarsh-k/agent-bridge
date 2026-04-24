import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

/**
 * Runtime-agnostic Zod schemas + a Node-only `.env` loader and validator.
 * This module is Node-only (it imports `dotenv` and calls `process.exit`)
 * and should NOT be imported from browser code.
 */

/**
 * Load the repo-root `.env` file. Safe to call multiple times;
 * `dotenv` does not override existing `process.env` values.
 *
 * Pass `import.meta.url` from the caller so we can locate the repo root
 * relative to the caller's compiled position.
 *
 * @param options.depth number of directories above the caller where `.env`
 *   lives. Default 3 (covers `apps/<app>/dist/env.js` and
 *   `apps/<app>/src/env.ts`).
 */
export function loadRootDotenv(
  callerImportMetaUrl: string,
  options: { depth?: number } = {},
): void {
  const depth = options.depth ?? 3
  const callerDir = path.dirname(fileURLToPath(callerImportMetaUrl))
  const repoRoot = path.resolve(callerDir, ...Array<string>(depth).fill('..'))
  loadDotenv({ path: path.join(repoRoot, '.env') })
}

/**
 * Zod schema every Agent Bridge service should share.
 * Each app should `.extend()` it with its own service-specific fields.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_URL: z.string().trim().url().optional(),
  REDIS_URL: z.string().trim().url().optional(),
})

export type BaseEnv = z.infer<typeof baseEnvSchema>

/**
 * Convenience helper: comma-separated string → trimmed, non-empty string[].
 * Used for things like `CORS_ORIGIN=a,b,c`.
 */
export const commaSeparatedList = z
  .string()
  .trim()
  .transform((raw) =>
    raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )

/**
 * Validate `process.env` (or any source) against a Zod schema.
 * On failure, prints a readable list of issues and exits the process.
 */
export function parseEnv<T>(
  schema: z.ZodType<T>,
  source: unknown = process.env,
): T {
  const parsed = schema.safeParse(source)
  if (parsed.success) return parsed.data

  console.error('[env] Invalid environment variables:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  process.exit(1)
}
