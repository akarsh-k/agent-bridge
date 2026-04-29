/**
 * Bridge-tool CRUD DTOs (Phase 7).
 *
 * One row in `bridge_tools` ↔ one outbound MCP tool the IDE sees.
 * Every field is operator-authored — there's no auto-generation —
 * which means the input DTOs do most of the validation work that the
 * DB CHECK constraints back-stop:
 *
 *   - `name` must be a valid MCP identifier and must NOT start with
 *     `query_` (reserved by Phase 5 for the auto-derived 1:1 default
 *     tool — `BRIDGE_TOOL_RESERVED_PREFIX`). Two layers of defence:
 *     this DTO rejects with a friendly message, the DB CHECK rejects
 *     with `23514` if a future caller bypasses validation.
 *   - `inputSchema` is stored verbatim. We require it to be a JSON
 *     object (`{ type: 'object', properties: ... }` shape) because that
 *     is what MCP `tools/list` clients consume; arbitrary primitives
 *     would confuse the IDE's tool picker.
 *   - `promptTemplate` is plain text with `{{ argName }}` placeholders.
 *     We don't pre-validate the template against the schema here — the
 *     UI surfaces a live preview, and the bridge renders at invocation
 *     time. A missing placeholder yields an empty interpolation, which
 *     is the operator's bug to fix.
 */

import { z } from 'zod'
import { BRIDGE_TOOL_RESERVED_PREFIX } from '../domain.js'

// ─── Field schemas ───────────────────────────────────────────────────────

/**
 * MCP-safe tool identifier. Mirrors the DB CHECK constraint
 * `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` — leading letter, then 0–63 of
 * `[A-Za-z0-9_]`. Total length capped at 64 because some MCP clients
 * truncate longer identifiers in their pickers.
 */
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    NAME_RE,
    'name must start with a letter and contain only letters, digits, and underscores',
  )
  .refine((v) => !v.startsWith(BRIDGE_TOOL_RESERVED_PREFIX), {
    message: `"${BRIDGE_TOOL_RESERVED_PREFIX}" prefix is reserved for the auto-derived default tool`,
  })

const descriptionSchema = z.string().trim().max(1_000)
const promptTemplateSchema = z.string().max(20_000)

/**
 * Input schema must serialise as a JSON-Schema-shaped object. We don't
 * validate the JSON-Schema spec itself — we just refuse arrays /
 * primitives so a sloppy paste can't flow into MCP `tools/list` where
 * IDEs will reject it with a much less actionable error.
 */
const inputSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) =>
      typeof v === 'object' && v !== null && !Array.isArray(v),
    { message: 'inputSchema must be a JSON object' },
  )

// ─── Create ──────────────────────────────────────────────────────────────

export const bridgeToolCreateInputSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    inputSchema: inputSchemaSchema.optional(),
    promptTemplate: promptTemplateSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export type BridgeToolCreateInput = z.infer<typeof bridgeToolCreateInputSchema>

// ─── Update ──────────────────────────────────────────────────────────────

/**
 * `name` IS updatable on PATCH (unlike `kind` on tools). Renaming a
 * bridge tool is a legitimate authoring action — IDE clients pick up
 * the new name on the next `tools/list`. The reserved-prefix check
 * still applies; the unique-name check is enforced by the DB.
 */
export const bridgeToolUpdateInputSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    inputSchema: inputSchemaSchema.optional(),
    promptTemplate: promptTemplateSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type BridgeToolUpdateInput = z.infer<typeof bridgeToolUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const bridgeToolResponseSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  promptTemplate: z.string(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type BridgeToolResponse = z.infer<typeof bridgeToolResponseSchema>

// ─── URL params ──────────────────────────────────────────────────────────

export const bridgeToolItemParamSchema = z.object({
  agentId: z.uuid(),
  id: z.uuid(),
})

export type BridgeToolItemParam = z.infer<typeof bridgeToolItemParamSchema>

export const bridgeToolAgentParamSchema = z.object({
  agentId: z.uuid(),
})

export type BridgeToolAgentParam = z.infer<typeof bridgeToolAgentParamSchema>
