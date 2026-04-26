/**
 * Skill DTOs. Browser-safe.
 *
 * A skill is a free-form markdown fragment that the agent's system prompt
 * composer concatenates (in `position` order) ahead of user input. No
 * secrets, no kind discriminator — just name, body, position.
 *
 * Contract invariants:
 *   - `name` is unique per agent (DB `(agent_id, name)` unique index).
 *     Global uniqueness would be wrong: two different agents can have a
 *     "code-review" skill with different bodies.
 *   - `position` is client-managed. Server accepts any non-negative int;
 *     no auto-reflow on delete. The UI owns ordering.
 *   - `markdownBody` is size-bounded at the API layer so a rogue caller
 *     can't stuff a multi-MB blob into a jsonb-neighbouring column.
 */

import { z } from 'zod'

const SKILL_NAME_MAX = 120
/**
 * Intentionally below the backend's 64 KiB global body-limit middleware so
 * this per-field refine can fire with a descriptive error instead of being
 * pre-empted by a generic 413 "Payload too large" from the global limiter.
 * If we ever need longer skill bodies, raise the global cap too.
 */
const MARKDOWN_BODY_MAX = 32 * 1024

/** Loose, UI-friendly. Strict slug rules are overkill for display names. */
const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_NAME_MAX)
  .refine((v) => !/[\r\n\t]/.test(v), {
    message: 'name cannot contain tabs or newlines',
  })

const markdownBodySchema = z
  .string()
  .max(MARKDOWN_BODY_MAX, `markdownBody exceeds ${MARKDOWN_BODY_MAX}-byte limit`)

const positionSchema = z.number().int().nonnegative().max(1_000_000)

// ─── Create ──────────────────────────────────────────────────────────────

export const skillCreateInputSchema = z
  .object({
    name: skillNameSchema,
    markdownBody: markdownBodySchema.optional(),
    position: positionSchema.optional(),
  })
  .strict()

export type SkillCreateInput = z.infer<typeof skillCreateInputSchema>

// ─── Update ──────────────────────────────────────────────────────────────

export const skillUpdateInputSchema = z
  .object({
    name: skillNameSchema.optional(),
    markdownBody: markdownBodySchema.optional(),
    position: positionSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type SkillUpdateInput = z.infer<typeof skillUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const skillResponseSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  name: z.string(),
  markdownBody: z.string(),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type SkillResponse = z.infer<typeof skillResponseSchema>

// ─── URL params ──────────────────────────────────────────────────────────

export const skillAgentParamSchema = z.object({ agentId: z.uuid() })
export type SkillAgentParam = z.infer<typeof skillAgentParamSchema>

export const skillItemParamSchema = z.object({
  agentId: z.uuid(),
  id: z.uuid(),
})
export type SkillItemParam = z.infer<typeof skillItemParamSchema>
