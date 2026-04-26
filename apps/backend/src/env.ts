import {
  baseEnvSchema,
  commaSeparatedList,
  loadRootDotenv,
  parseEnv,
} from '@agent-bridge/shared/env'
import { z } from 'zod'

loadRootDotenv(import.meta.url)

const envSchema = baseEnvSchema.extend({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  CORS_ORIGIN: commaSeparatedList.optional(),
  REDIS_URL: z.string().trim().url().default('redis://127.0.0.1:6379'),
  DATABASE_URL: z
    .string()
    .trim()
    .url()
    .default(
      'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge',
    ),
  /** Max Postgres pool size for the backend. */
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Log every SQL query to stdout (DEV ONLY — will print PII). */
  DATABASE_DEBUG: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
})

const data = parseEnv(envSchema)
const isProd = data.NODE_ENV === 'production'

if (isProd) {
  const origins = data.CORS_ORIGIN ?? []
  if (origins.length === 0) {
    console.error(
      '[env] CORS_ORIGIN is required in production (comma-separated origins).',
    )
    process.exit(1)
  }
  if (origins.some((o) => o === '*')) {
    console.error('[env] CORS_ORIGIN must not be "*" in production.')
    process.exit(1)
  }
}

export const env = {
  ...data,
  isProd,
} as const

export type Env = typeof env
