/**
 * LLM provider CRUD DTOs. Browser-safe; shared between frontend and backend.
 *
 * This is the first DTO to exercise the `SecretInput` / `SecretSentinel`
 * split. The input side accepts three-state action envelopes for `apiKey`;
 * the response side returns only a presence sentinel. Plaintext NEVER flows
 * in the response shape.
 *
 * Design notes:
 *   - `baseUrl` is required for self-hosted kinds (`llama_cpp`, `ollama`,
 *     `openai_compatible`) and forbidden for the `openai` cloud kind, which
 *     routes to `https://api.openai.com`. Enforced by `.superRefine` so the
 *     error message can reference `kind`.
 *   - `apiKey` is optional on create (some local endpoints need no auth) and
 *     optional on update (absence = leave alone).
 *   - `label` is unique at the DB level; duplicate `POST` → 409 conflict.
 */

import { z } from 'zod'
import {
  llmProviderKinds,
  llmProviderRoles,
  type LlmProviderKind,
  type LlmProviderModelsCache,
} from '../domain.js'
import { secretInputSchema, secretSentinelSchema } from './secrets.js'

const kindSchema = z.enum(llmProviderKinds)
const roleSchema = z.enum(llmProviderRoles)

const LOCAL_KINDS: readonly LlmProviderKind[] = [
  'llama_cpp',
  'ollama',
  'openai_compatible',
]

/**
 * Per-kind base-URL policy. Kept as a function so the Zod refinement and any
 * future UI hint (e.g. "this kind requires a base URL") read the same rule.
 */
function isLocalKind(kind: LlmProviderKind): boolean {
  return LOCAL_KINDS.includes(kind)
}

const baseFields = {
  kind: kindSchema,
  role: roleSchema,
  label: z.string().trim().min(1).max(120),
  baseUrl: z.url({ message: 'baseUrl must be a valid URL' }).nullable().optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: secretInputSchema.optional(),
} as const

// ─── Create ──────────────────────────────────────────────────────────────

export const llmProviderCreateInputSchema = z
  .object({
    kind: baseFields.kind,
    role: baseFields.role,
    label: baseFields.label,
    baseUrl: baseFields.baseUrl,
    defaultModel: baseFields.defaultModel,
    apiKey: baseFields.apiKey,
  })
  .strict()
  .superRefine((v, ctx) => {
    // Local kinds require a base URL; vendor kinds don't accept one.
    if (isLocalKind(v.kind) && !v.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: `baseUrl is required for kind="${v.kind}"`,
      })
    }
    if (!isLocalKind(v.kind) && v.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: `baseUrl is not supported for kind="${v.kind}"`,
      })
    }
  })

export type LlmProviderCreateInput = z.infer<typeof llmProviderCreateInputSchema>

// ─── Update ──────────────────────────────────────────────────────────────

/**
 * PATCH body. All fields optional; at least one must be present. Kind
 * and role are intentionally NOT updatable — flipping `kind` silently
 * flips the auth/URL policy, and flipping `role` reinterprets every
 * stored vector or every chat call against the same `default_model`
 * string. If the operator wants a different kind or role, they create
 * a new provider row.
 */
export const llmProviderUpdateInputSchema = z
  .object({
    label: baseFields.label.optional(),
    baseUrl: baseFields.baseUrl,
    defaultModel: baseFields.defaultModel,
    apiKey: baseFields.apiKey,
    /**
     * Confirmation flag from the embedding-model-change dialog. Set
     * by the UI when the operator confirms changing the embedding
     * provider's `defaultModel` — old vectors live in the previous
     * model's geometry and produce garbage retrieval otherwise. The
     * backend wipes every stored vector when this is `true`.
     */
    wipeSemanticVectors: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type LlmProviderUpdateInput = z.infer<typeof llmProviderUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

/**
 * Snapshot of `/v1/models` for this provider, refreshed via
 * `POST /api/llm-providers/:id/models/refresh`. `null` when the operator
 * has never refreshed; the model-picker UIs render as plain free-text
 * inputs in that case.
 */
export const llmProviderModelsCacheSchema = z.object({
  models: z.array(z.string().min(1).max(200)),
  fetchedAt: z.iso.datetime(),
}) satisfies z.ZodType<LlmProviderModelsCache>

export const llmProviderResponseSchema = z.object({
  id: z.uuid(),
  kind: kindSchema,
  /** What this provider serves: `'chat'` or `'embedding'`. */
  role: roleSchema,
  label: z.string(),
  baseUrl: z.string().nullable(),
  /**
   * The model id this provider serves. Interpretation depends on
   * `role` — chat-role rows feed `/v1/chat/completions`,
   * embedding-role rows feed `/v1/embeddings`.
   */
  defaultModel: z.string().nullable(),
  /** Presence-only sentinel. Never contains plaintext. */
  apiKey: secretSentinelSchema,
  /** Cached `/v1/models` response or `null` if never refreshed. */
  models: llmProviderModelsCacheSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type LlmProviderResponse = z.infer<typeof llmProviderResponseSchema>

/** `:id` URL param. */
export const llmProviderIdParamSchema = z.object({ id: z.uuid() })
export type LlmProviderIdParam = z.infer<typeof llmProviderIdParamSchema>

// ─── Test connection ─────────────────────────────────────────────────────
//
// `POST /api/llm-providers/:id/test` runs a live smoke check against the
// provider's endpoint. By default it uses the saved row as-is; a caller
// can optionally override any of `baseUrl`, `apiKey`, or `defaultModel`
// for this one call (e.g. from a future "edit draft" UI) without
// persisting the overrides. Omitted fields fall through to the saved
// values — the server never invents defaults the user didn't configure.
//
// `apiKey` reuses the same three-state `SecretInput` shape, so
// `{ action: 'unchanged' }` (and an absent field) both mean "use the
// saved envelope"; `{ action: 'clear' }` means "test anonymously" even
// if the saved row has a key; `{ action: 'set', plaintext }` swaps in a
// new key for the test without writing it back.

export const llmProviderTestInputSchema = z
  .object({
    baseUrl: baseFields.baseUrl,
    defaultModel: baseFields.defaultModel,
    apiKey: baseFields.apiKey,
    /**
     * Which API surface to probe. Defaults to `chat` (POST
     * /v1/chat/completions). When set to `embedding`, the connector
     * POSTs to /v1/embeddings instead — used to verify embedding
     * models that semantic-recall depends on.
     */
    capability: z.enum(['chat', 'embedding']).optional(),
  })
  .strict()
  .partial()

export type LlmProviderTestInput = z.infer<typeof llmProviderTestInputSchema>

/**
 * Two-tier result. `stage: 'inference'` means we sent a token-bounded
 * chat request and got something back — proves the full auth + model
 * path works. `stage: 'reachable'` means we only confirmed the endpoint
 * answers (model-list endpoint / tags endpoint) — used when the caller
 * hasn't set `defaultModel` yet and we fall back to a cheaper probe.
 * Errors carry a stable `code` so the UI can map to user-facing copy.
 */
export const llmProviderTestResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      stage: z.enum(['reachable', 'inference']),
      durationMs: z.number().int().nonnegative(),
      /** What the server hit (kind/model) — echoes back for the UI. */
      kind: kindSchema,
      model: z.string().nullable(),
      /** Free-form human summary; trimmed to a display-safe length. */
      message: z.string(),
      /**
       * For `stage: 'inference'`: the first chunk of the model's reply
       * (truncated to ~120 chars). `null` for `stage: 'reachable'`.
       */
      sample: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      durationMs: z.number().int().nonnegative(),
      kind: kindSchema,
      code: z.enum([
        'unreachable',
        'auth',
        'rate_limited',
        'invalid_model',
        'upstream',
        'timeout',
        'unknown',
      ]),
      message: z.string(),
    })
    .strict(),
])

export type LlmProviderTestResponse = z.infer<
  typeof llmProviderTestResponseSchema
>

// ─── Refresh models ──────────────────────────────────────────────────────
//
// `POST /api/llm-providers/:id/models/refresh` re-fetches `/v1/models`
// from the provider and updates the cached row. Same secret-handling
// discipline as the test endpoint: any `baseUrl` / `apiKey` overrides
// the caller passes apply only to this one call (not persisted), and
// the saved envelope is the default. The response shape mirrors
// `LlmProviderTestResponse` so the UI can render success / failure
// from one rendering path.

export const llmProviderRefreshModelsInputSchema = z
  .object({
    baseUrl: baseFields.baseUrl,
    apiKey: baseFields.apiKey,
  })
  .strict()
  .partial()

export type LlmProviderRefreshModelsInput = z.infer<
  typeof llmProviderRefreshModelsInputSchema
>

export const llmProviderRefreshModelsResponseSchema = z.discriminatedUnion(
  'ok',
  [
    z
      .object({
        ok: z.literal(true),
        durationMs: z.number().int().nonnegative(),
        kind: kindSchema,
        models: llmProviderModelsCacheSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        durationMs: z.number().int().nonnegative(),
        kind: kindSchema,
        code: z.enum([
          'unreachable',
          'auth',
          'rate_limited',
          'upstream',
          'timeout',
          'unknown',
        ]),
        message: z.string(),
      })
      .strict(),
  ],
)

export type LlmProviderRefreshModelsResponse = z.infer<
  typeof llmProviderRefreshModelsResponseSchema
>
