/**
 * Subset of the backend's env shape — the bridge only needs DB + Redis
 * connectivity. Loads `.env` from the repo root via the shared helper
 * so the IDE can spawn `node apps/mcp-bridge/dist/index.js` without
 * inheriting any env from the operator's shell.
 */

import {
  baseEnvSchema,
  loadRootDotenv,
  parseEnv,
} from '@agent-bridge/shared/env'
import { z } from 'zod'

loadRootDotenv(import.meta.url)

const envSchema = baseEnvSchema.extend({
  REDIS_URL: z.string().trim().url().default('redis://127.0.0.1:6379'),
  DATABASE_URL: z
    .string()
    .trim()
    .url()
    .default(
      'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge',
    ),
  /**
   * Pool size is intentionally tiny — each bridge spawn handles ~one
   * agent at a time per IDE invocation. Five connections leaves plenty
   * of headroom for parallel `tools/list` + `tools/call` exchanges
   * without saturating the Postgres pool.
   */
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  DATABASE_DEBUG: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
})

const data = parseEnv(envSchema)
const isProd = data.NODE_ENV === 'production'

export const env = {
  ...data,
  isProd,
} as const

export type Env = typeof env
