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
  llmProviderRefreshModelsInputSchema,
  llmProviderResponseSchema,
  llmProviderTestInputSchema,
  llmProviderUpdateInputSchema,
  type LlmProviderResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { wipeAllSemanticVectors } from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import {
  refreshProviderModels,
  testProvider,
} from '../lib/llm-providers/index.js'
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
    role: row.role,
    label: row.label,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    apiKey: envelopeToSentinel(row.apiKeyEnvelope),
    models: row.modelsJson ?? null,
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
            role: body.role,
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
          // 23505 covers both label uniqueness and the embedding-role
          // singleton index. Differentiate by whichever index the
          // error references — Postgres surfaces it as `constraint`.
          const constraint =
            err && typeof err === 'object' && 'constraint' in err
              ? (err as { constraint?: string }).constraint
              : undefined
          if (constraint === 'llm_providers_embedding_singleton_uq') {
            return httpError(c, {
              code: 'conflict',
              message:
                'an embedding provider already exists — delete it first to register a different one',
            })
          }
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
      const handle = getDb()
      const { db } = handle

      const [before] = await db
        .select()
        .from(schema.llmProviders)
        .where(eq(schema.llmProviders.id, id))
        .limit(1)
      if (!before) {
        return httpError(c, {
          code: 'not_found',
          message: `llm provider ${id} not found`,
        })
      }

      const patch: Partial<typeof schema.llmProviders.$inferInsert> = {}
      if ('label' in body) patch.label = body.label
      if ('baseUrl' in body) patch.baseUrl = body.baseUrl ?? null
      if ('defaultModel' in body) patch.defaultModel = body.defaultModel ?? null

      const nextEnvelope = applySecretInput(body.apiKey)
      if (nextEnvelope !== SECRET_UNCHANGED) {
        patch.apiKeyEnvelope = nextEnvelope
      }

      // Vector wipe trigger: this row is the embedding provider AND
      // its `defaultModel` is moving to a different value. Old vectors
      // sit in the previous model's geometry and would produce garbage
      // recall. The client must opt-in via `wipeSemanticVectors=true`.
      const embeddingModelChanged =
        before.role === 'embedding' &&
        'defaultModel' in body &&
        (before.defaultModel ?? null) !== (body.defaultModel ?? null)

      if (embeddingModelChanged && body.wipeSemanticVectors !== true) {
        return httpError(c, {
          code: 'validation_failed',
          message:
            'embedding model is changing — set wipeSemanticVectors=true to confirm',
        })
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

        if (embeddingModelChanged) {
          await wipeAllSemanticVectors(handle)
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
  // ─── POST /api/llm-providers/:id/test ────────────────────────────────────
  //
  // Live smoke check against the saved row. Optional body lets the caller
  // override any of `baseUrl`, `apiKey`, or `defaultModel` for this one
  // call — used by future "edit draft" flows so the user can verify
  // changes before persisting. Omitted fields fall through to the stored
  // values; `apiKey: { action: 'unchanged' }` and a missing `apiKey`
  // behave identically (use the saved envelope).
  //
  // Decrypt happens inside `testProvider` — this handler never touches
  // plaintext. 2xx always carries a `LlmProviderTestResponse`; 4xx/5xx
  // are reserved for envelope-level errors (404, validation). A failed
  // *smoke test* against a reachable-but-broken provider is still 200
  // with `{ ok: false, code, message }`, so clients have a single
  // success-path parser and only the transport-level errors to handle
  // via `ApiError`.
  .post(
    '/:id/test',
    zValidator('param', llmProviderIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', llmProviderTestInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
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

      const result = await testProvider(
        {
          kind: row.kind,
          baseUrl: row.baseUrl,
          defaultModel: row.defaultModel,
          apiKeyEnvelope: row.apiKeyEnvelope,
        },
        body,
      )

      return c.json({ ok: true as const, result })
    },
  )
  // ─── POST /api/llm-providers/:id/models/refresh ──────────────────────────
  //
  // Re-fetch `/v1/models` and persist the result on `models_json`.
  // Same secret-handling discipline as the test endpoint: any
  // `baseUrl` / `apiKey` overrides apply only to this one call. 2xx
  // always carries an `LlmProviderRefreshModelsResponse`; a failed
  // probe returns `{ ok: false, code, message }` (not 4xx) so the UI
  // has one envelope to parse for both success and reachability errors.
  // The DB write is best-effort (failure is logged + ignored) — the
  // operator can retry, and we don't want a transient DB hiccup to
  // mask a successful upstream probe.
  .post(
    '/:id/models/refresh',
    zValidator('param', llmProviderIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', llmProviderRefreshModelsInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
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

      const result = await refreshProviderModels(
        {
          kind: row.kind,
          baseUrl: row.baseUrl,
          defaultModel: row.defaultModel,
          apiKeyEnvelope: row.apiKeyEnvelope,
        },
        body,
      )

      // Persist on success so subsequent reads of `/api/llm-providers`
      // surface the refreshed list without re-probing. Any DB failure
      // doesn't fail the request — the operator already has the data
      // they asked for in the response, and the next refresh will
      // overwrite cleanly.
      if (result.ok) {
        try {
          await db
            .update(schema.llmProviders)
            .set({ modelsJson: result.models })
            .where(eq(schema.llmProviders.id, id))
        } catch (err) {
          console.error(
            `[llm-providers] failed to persist models_json for ${id}:`,
            err instanceof Error ? err.message : err,
          )
        }
      }

      return c.json({ ok: true as const, result })
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
      const handle = getDb()
      const { db } = handle

      // Deleting the embedding provider orphans every stored vector
      // (no row left to embed queries against). Wipe them so a future
      // re-attached embedder doesn't query against alien geometry.
      // Chat-role deletes go through `ON DELETE SET NULL` on
      // `agents.llm_provider_id` and need no extra cleanup.
      const [row] = await db
        .delete(schema.llmProviders)
        .where(eq(schema.llmProviders.id, id))
        .returning({
          id: schema.llmProviders.id,
          role: schema.llmProviders.role,
        })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `llm provider ${id} not found`,
        })
      }

      if (row.role === 'embedding') {
        await wipeAllSemanticVectors(handle)
      }

      return c.json({ ok: true as const, id: row.id })
    },
  )

export type LlmProvidersRouter = typeof llmProvidersRouter
