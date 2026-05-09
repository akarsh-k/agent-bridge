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
 * Per-skill body size caps (`docs/ARCHITECTURE.md §10` Phase F F2/F3).
 *
 * The wrapper-tool architecture intentionally keeps the system prompt
 * tiny (Phase F1's `system-prompt.md` is ~70 lines). Operator-authored
 * skills augment that prompt and ride into every chat turn, so they
 * need their own ceiling — historically the v1 toolkit shipped one
 * 860-line skill in every prompt and called it the worst failure mode
 * (`lesson_learned.md` §5.6).
 *
 * 4 KiB is enough for ~80 lines of markdown — about the same budget
 * the inspector system prompt itself uses. 200 lines is a hard line
 * cap on top so an operator can't fit an essay under the byte limit.
 *
 * Per-agent total cap of 12 KiB is enforced separately by the backend
 * route (it requires summing across the agent's existing skills + the
 * incoming change, which a per-field DTO can't see).
 */
export const SKILL_BODY_MAX_BYTES = 4 * 1024
export const SKILL_BODY_MAX_LINES = 200
export const PER_AGENT_SKILL_BUDGET_BYTES = 12 * 1024

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
  .max(
    SKILL_BODY_MAX_BYTES,
    `markdownBody exceeds ${SKILL_BODY_MAX_BYTES}-byte limit (Phase F2; per-skill cap)`,
  )
  .refine(
    (v) => v.split('\n').length <= SKILL_BODY_MAX_LINES,
    `markdownBody exceeds ${SKILL_BODY_MAX_LINES}-line limit (Phase F2; per-skill cap)`,
  )

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
