import {
  baseEnvSchema,
  loadRootDotenv,
  parseEnv,
} from '@agent-bridge/shared/env'
import { z } from 'zod'

loadRootDotenv(import.meta.url)

const envSchema = baseEnvSchema.extend({
  REDIS_URL: z.string().trim().url().default('redis://127.0.0.1:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
})

const data = parseEnv(envSchema)

export const env = {
  ...data,
  isProd: data.NODE_ENV === 'production',
} as const

export type Env = typeof env
