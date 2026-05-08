/**
 * Agent CRUD DTOs. Browser-safe; shared between frontend (`apps/frontend`)
 * and backend (`apps/backend`).
 *
 * Design notes:
 *   - `slug` is user-visible (it becomes part of the Phase 5 MCP tool name
 *     `query_<slug>`). We constrain it tightly: lowercase alnum + dashes.
 *   - `id`, `createdAt`, `updatedAt` are server-owned and never appear in
 *     input DTOs. They only come back in responses.
 *   - `agentUpdateInputSchema` is `.partial()` over the input fields plus a
 *     `.refine(…)` that rejects the empty object — PATCH with no fields is
 *     probably a client bug.
 *   - Dates round-trip as ISO strings over JSON (Zod `coerce.date()` on the
 *     *input* path would accept strings, but we intentionally keep input
 *     schemas date-free; only the response schema stringifies dates).
 */

import { z } from 'zod'
import { agentMemoryConfigSchema } from './memory.js'

/**
 * URL-safe slug: starts and ends with alnum, dashes allowed in the middle.
 * 1–64 chars. Case-sensitive (we lowercase at the UI; server doesn't rewrite).
 */
const AGENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const baseFields = {
  slug: z.string().regex(AGENT_SLUG_RE, 'slug must be a URL-safe kebab string'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  systemPrompt: z.string().max(50_000),
  llmProviderId: z.uuid().nullable().optional(),
  memoryEnabled: z.boolean(),
  memoryConfig: agentMemoryConfigSchema.nullable().optional(),
} as const

/**
 * POST /api/agents body. Fields with defaults in the DB are optional here;
 * server applies the default on insert.
 */
export const agentCreateInputSchema = z
  .object({
    slug: baseFields.slug,
    name: baseFields.name,
    description: baseFields.description,
    /** Defaults to `''` on the server. */
    systemPrompt: baseFields.systemPrompt.optional(),
    llmProviderId: baseFields.llmProviderId,
    /** Defaults to `false` on the server. */
    memoryEnabled: baseFields.memoryEnabled.optional(),
    memoryConfig: baseFields.memoryConfig,
  })
  .strict()

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>

/**
 * PATCH /api/agents/:id body. All fields optional; at least one must be
 * present (enforced by `.refine`).
 */
export const agentUpdateInputSchema = z
  .object({
    slug: baseFields.slug.optional(),
    name: baseFields.name.optional(),
    description: baseFields.description,
    systemPrompt: baseFields.systemPrompt.optional(),
    llmProviderId: baseFields.llmProviderId,
    memoryEnabled: baseFields.memoryEnabled.optional(),
    memoryConfig: baseFields.memoryConfig,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>

/**
 * Shape returned from every agent-producing endpoint. Dates are ISO strings
 * over the wire; the frontend parses them on consumption if needed.
 */
export const agentResponseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  systemPrompt: z.string(),
  llmProviderId: z.uuid().nullable(),
  memoryEnabled: z.boolean(),
  memoryConfig: agentMemoryConfigSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type AgentResponse = z.infer<typeof agentResponseSchema>

/** `:id` URL param. */
export const agentIdParamSchema = z.object({ id: z.uuid() })
export type AgentIdParam = z.infer<typeof agentIdParamSchema>
