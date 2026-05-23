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
 * Per-skill body size caps (see `docs/ARCHITECTURE.md §10`).
 *
 * The wrapper-tool architecture intentionally keeps the system prompt
 * tiny (`inspector/system-prompt.md` is ~70 lines). Operator-authored
 * skills augment that prompt and ride into every chat turn, so they
 * need their own ceiling — without one, a single oversized skill can
 * dominate every prompt and crowd out actual reasoning context.
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

/**
 * Short summary the LLM sees in the system prompt's skill catalog when
 * a skill is set to lazy-load. 280 chars is enough for a useful "use
 * this when…" pitch without bloating the catalog when an agent has
 * many skills.
 */
export const SKILL_DESCRIPTION_MAX_BYTES = 280

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
    `markdownBody exceeds ${SKILL_BODY_MAX_BYTES}-byte limit (per-skill cap)`,
  )
  .refine(
    (v) => v.split('\n').length <= SKILL_BODY_MAX_LINES,
    `markdownBody exceeds ${SKILL_BODY_MAX_LINES}-line limit (per-skill cap)`,
  )

const descriptionSchema = z
  .string()
  .max(
    SKILL_DESCRIPTION_MAX_BYTES,
    `description exceeds ${SKILL_DESCRIPTION_MAX_BYTES}-byte limit`,
  )
  .refine((v) => !/[\r\n]/.test(v), {
    message: 'description must be a single line',
  })

const positionSchema = z.number().int().nonnegative().max(1_000_000)

// ─── Create ──────────────────────────────────────────────────────────────

export const skillCreateInputSchema = z
  .object({
    name: skillNameSchema,
    description: descriptionSchema.optional(),
    markdownBody: markdownBodySchema.optional(),
    alwaysInclude: z.boolean().optional(),
    position: positionSchema.optional(),
  })
  .strict()

export type SkillCreateInput = z.infer<typeof skillCreateInputSchema>

// ─── Update ──────────────────────────────────────────────────────────────

export const skillUpdateInputSchema = z
  .object({
    name: skillNameSchema.optional(),
    description: descriptionSchema.optional(),
    markdownBody: markdownBodySchema.optional(),
    alwaysInclude: z.boolean().optional(),
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
  description: z.string(),
  markdownBody: z.string(),
  alwaysInclude: z.boolean(),
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
