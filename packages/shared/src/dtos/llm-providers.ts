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
import { llmProviderKinds, type LlmProviderKind } from '../domain.js'
import { secretInputSchema, secretSentinelSchema } from './secrets.js'

const kindSchema = z.enum(llmProviderKinds)

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
  label: z.string().trim().min(1).max(120),
  baseUrl: z.url({ message: 'baseUrl must be a valid URL' }).nullable().optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: secretInputSchema.optional(),
} as const

// ─── Create ──────────────────────────────────────────────────────────────

export const llmProviderCreateInputSchema = z
  .object({
    kind: baseFields.kind,
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
 * PATCH body. All fields optional; at least one must be present. Kind is
 * intentionally NOT updatable — an `openai` row turning into an `ollama` row
 * silently flips the auth/URL policy. If the user wants a different kind,
 * they create a new provider.
 */
export const llmProviderUpdateInputSchema = z
  .object({
    label: baseFields.label.optional(),
    baseUrl: baseFields.baseUrl,
    defaultModel: baseFields.defaultModel,
    apiKey: baseFields.apiKey,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type LlmProviderUpdateInput = z.infer<typeof llmProviderUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const llmProviderResponseSchema = z.object({
  id: z.uuid(),
  kind: kindSchema,
  label: z.string(),
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  /** Presence-only sentinel. Never contains plaintext. */
  apiKey: secretSentinelSchema,
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
