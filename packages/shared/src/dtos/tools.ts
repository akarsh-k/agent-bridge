/**
 * Tool DTOs. Browser-safe.
 *
 * A tool is a named callable the Mastra agent may invoke directly. Unlike
 * MCP-sourced tools (those go through `agent_mcp_tools`), these are
 * configured inline per agent. The database stores `config_json` as opaque
 * `jsonb`; this file validates only shape/size at the API boundary —
 * kind-specific narrowing happens at execution time inside the agents
 * workspace (Phase 3), as the schema comment in `packages/db` documents.
 *
 * Contract invariants:
 *   - `name` is unique per agent (DB `(agent_id, name)` unique index).
 *   - `kind` is immutable post-creation. Same reasoning as `transport` on
 *     MCP connections and `kind` on LLM providers: `kind` dictates what
 *     `configJson` means; flipping it silently invalidates every other
 *     field.
 *   - `configJson` is size-bounded by serialized length so a rogue caller
 *     can't write multi-MB blobs. The refine runs JSON.stringify exactly
 *     once at validation time.
 */

import { z } from 'zod'
import { toolKinds } from '../domain.js'

const TOOL_NAME_MAX = 120
/**
 * Intentionally below the backend's 64 KiB global body-limit middleware so
 * this per-field refine can fire with a descriptive error instead of being
 * pre-empted by a generic 413 "Payload too large". Also leaves headroom
 * for the surrounding JSON envelope (`kind`, `name`, `description`, etc.).
 */
const CONFIG_JSON_MAX_BYTES = 32 * 1024
const DESCRIPTION_MAX = 2_000

const toolKindSchema = z.enum(toolKinds)

const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TOOL_NAME_MAX)
  .refine((v) => !/[\r\n\t]/.test(v), {
    message: 'name cannot contain tabs or newlines',
  })

const toolDescriptionSchema = z.string().max(DESCRIPTION_MAX).nullable()

/**
 * Bound the serialized form, not the number of keys — a single key with a
 * 10 MB value is just as bad as 100 000 small ones.
 *
 * We accept `Record<string, unknown>` because kind-specific narrowing lives
 * in `packages/agents` (see schema comment in `packages/db/src/schema.ts`).
 * This layer only guards against size blowups.
 */
const configJsonSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => {
      try {
        return JSON.stringify(v).length <= CONFIG_JSON_MAX_BYTES
      } catch {
        return false
      }
    },
    { message: `configJson exceeds ${CONFIG_JSON_MAX_BYTES}-byte limit` },
  )

const positionSchema = z.number().int().nonnegative().max(1_000_000)

// ─── Create ──────────────────────────────────────────────────────────────

export const toolCreateInputSchema = z
  .object({
    kind: toolKindSchema,
    name: toolNameSchema,
    description: toolDescriptionSchema.optional(),
    configJson: configJsonSchema.optional(),
    position: positionSchema.optional(),
  })
  .strict()

export type ToolCreateInput = z.infer<typeof toolCreateInputSchema>

// ─── Update ──────────────────────────────────────────────────────────────

/**
 * `kind` intentionally omitted — immutable post-creation.
 */
export const toolUpdateInputSchema = z
  .object({
    name: toolNameSchema.optional(),
    description: toolDescriptionSchema.optional(),
    configJson: configJsonSchema.optional(),
    position: positionSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type ToolUpdateInput = z.infer<typeof toolUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const toolResponseSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  kind: toolKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  configJson: z.record(z.string(), z.unknown()),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type ToolResponse = z.infer<typeof toolResponseSchema>

// ─── URL params ──────────────────────────────────────────────────────────

export const toolAgentParamSchema = z.object({ agentId: z.uuid() })
export type ToolAgentParam = z.infer<typeof toolAgentParamSchema>

export const toolItemParamSchema = z.object({
  agentId: z.uuid(),
  id: z.uuid(),
})
export type ToolItemParam = z.infer<typeof toolItemParamSchema>
