/**
 * `/api/llm-providers` — CRUD for user-configured LLM providers.
 *
 * This is the first route on the secret-handling critical path. It funnels
 * every plaintext through `applySecretInput(...)` (which is the ONLY function
 * in the backend allowed to call `encryptSecret`) and returns only a
 * presence sentinel. If you're porting a future route and your grep for
 * "encryptSecret" shows multiple call sites, something has drifted —
 * fix it at the helper, not at the call site.
 *
 * Invariants enforced here:
 *   - POST never persists `apiKey: { action: 'unchanged' }` as anything other
 *     than `null`. The DB column stays clean.
 *   - PATCH `{ apiKey: { action: 'unchanged' } }` and PATCH omitting `apiKey`
 *     are both no-ops on `api_key_envelope`.
 *   - PATCH `{ apiKey: { action: 'clear' } }` sets the column to `null`
 *     explicitly so the trigger still fires `updated_at`.
 *   - Duplicate `label` → `409 conflict` (uniqueness enforced by the DB).
 *   - `kind` is immutable once created (see DTO rationale).
 */

import { zValidator } from '@hono/zod-validator'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  llmProviderCreateInputSchema,
  llmProviderIdParamSchema,
  llmProviderResponseSchema,
  llmProviderUpdateInputSchema,
  type LlmProviderResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import {
  applySecretInput,
  applySecretInputForCreate,
  envelopeToSentinel,
  SECRET_UNCHANGED,
} from '../lib/secrets.js'

type LlmProviderRow = typeof schema.llmProviders.$inferSelect

function toLlmProviderResponse(row: LlmProviderRow): LlmProviderResponse {
  return llmProviderResponseSchema.parse({
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    apiKey: envelopeToSentinel(row.apiKeyEnvelope),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export const llmProvidersRouter = new Hono()
  // ─── POST /api/llm-providers ─────────────────────────────────────────────
  .post(
    '/',
    zValidator('json', llmProviderCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const body = c.req.valid('json')
      const { db } = getDb()

      const apiKeyEnvelope = applySecretInputForCreate(body.apiKey)

      try {
        const [row] = await db
          .insert(schema.llmProviders)
          .values({
            kind: body.kind,
            label: body.label,
            baseUrl: body.baseUrl ?? null,
            defaultModel: body.defaultModel ?? null,
            apiKeyEnvelope,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        return c.json(
          { ok: true as const, llmProvider: toLlmProviderResponse(row) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `label "${body.label}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/llm-providers ──────────────────────────────────────────────
  .get('/', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select()
      .from(schema.llmProviders)
      .orderBy(asc(schema.llmProviders.createdAt))

    return c.json({
      ok: true as const,
      llmProviders: rows.map(toLlmProviderResponse),
    })
  })
  // ─── GET /api/llm-providers/:id ──────────────────────────────────────────
  .get(
    '/:id',
    zValidator('param', llmProviderIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .select()
        .from(schema.llmProviders)
        .where(eq(schema.llmProviders.id, id))
        .limit(1)

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `llm provider ${id} not found`,
        })
      }

      return c.json({
        ok: true as const,
        llmProvider: toLlmProviderResponse(row),
      })
    },
  )
  // ─── PATCH /api/llm-providers/:id ────────────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', llmProviderIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', llmProviderUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.llmProviders.$inferInsert> = {}
      if ('label' in body) patch.label = body.label
      if ('baseUrl' in body) patch.baseUrl = body.baseUrl ?? null
      if ('defaultModel' in body) patch.defaultModel = body.defaultModel ?? null

      const nextEnvelope = applySecretInput(body.apiKey)
      if (nextEnvelope !== SECRET_UNCHANGED) {
        patch.apiKeyEnvelope = nextEnvelope
      }

      try {
        const [row] = await db
          .update(schema.llmProviders)
          .set(patch)
          .where(eq(schema.llmProviders.id, id))
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `llm provider ${id} not found`,
          })
        }

        return c.json({
          ok: true as const,
          llmProvider: toLlmProviderResponse(row),
        })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `label "${patch.label}" is already in use`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/llm-providers/:id ───────────────────────────────────────
  .delete(
    '/:id',
    zValidator('param', llmProviderIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      // `agents.llm_provider_id` → `ON DELETE SET NULL`, so deleting a
      // provider is always safe (agents just become "unconfigured"). We
      // rely on the FK action instead of pre-nulling in application code.
      const [row] = await db
        .delete(schema.llmProviders)
        .where(eq(schema.llmProviders.id, id))
        .returning({ id: schema.llmProviders.id })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `llm provider ${id} not found`,
        })
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type LlmProvidersRouter = typeof llmProvidersRouter
