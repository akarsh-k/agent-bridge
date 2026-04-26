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
 *     `openai_compatible`) and forbidden for vendor kinds (`openai`,
 *     `anthropic`, `gemini`). Enforced by `.superRefine` so the error message
 *     can reference `kind`.
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
 * intentionally NOT updatable — a `gemini` row turning into an `ollama` row
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
