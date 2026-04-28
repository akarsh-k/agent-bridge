/**
 * Per-agent MCP tool allowlist DTOs. Browser-safe.
 *
 * Shape of the resource:
 *
 *   agent
 *     └─ allowlist entry: (mcpConnectionId, toolName, enabled)
 *
 * Only tool names present in this list are ever exposed to the agent, and
 * `enabled=false` is equivalent to "listed but off" — the schema keeps the
 * row so the UI can show unchecked rows without losing history. This matches
 * the schema comment: "Users must explicitly opt in — never 'everything on
 * by default'."
 *
 * The only mutating verb is `PUT` (set-replace). No POST/PATCH/DELETE per
 * tool — the frontend builds the full list then sends one write. Rationale
 * in `PLAN.md` §1C.3.
 *
 * MCP tool names are validated with a conservative charset: upstream MCP
 * servers name tools as JS identifiers in practice, and this subset also
 * works as MCP tool identifiers.
 */

import { z } from 'zod'

/**
 * MCP tool names follow MCP's id conventions: letters, digits, underscore,
 * dash, and dot. Upper bound is generous; servers typically pick short
 * `snake_case` or `camelCase` names.
 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.\-]{0,127}$/

export const mcpToolNameSchema = z
  .string()
  .regex(TOOL_NAME_RE, {
    message:
      'toolName must match ^[A-Za-z][A-Za-z0-9_.-]{0,127}$ (MCP tool id)',
  })

// ─── PUT body ────────────────────────────────────────────────────────────

export const allowlistEntrySchema = z
  .object({
    mcpConnectionId: z.uuid(),
    toolName: mcpToolNameSchema,
    enabled: z.boolean().optional(),
  })
  .strict()

export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>

/**
 * PUT /api/agents/:agentId/mcp-tools body.
 *
 * Invariants enforced here (before the DB txn ever runs):
 *   - No duplicate `(mcpConnectionId, toolName)` pairs. The DB would reject
 *     them with a 23505 anyway, but catching at the schema is a clearer
 *     error for callers.
 *   - Cap of 1 000 entries per agent — defensive, far above real use.
 *
 * The empty array is valid and means "clear this agent's allowlist".
 */
export const setAllowlistInputSchema = z
  .object({
    tools: z.array(allowlistEntrySchema).max(1_000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>()
    for (let i = 0; i < v.tools.length; i += 1) {
      const entry = v.tools[i]!
      const key = `${entry.mcpConnectionId}::${entry.toolName}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i],
          message: `duplicate allowlist entry (${entry.mcpConnectionId}, ${entry.toolName})`,
        })
      }
      seen.add(key)
    }
  })

export type SetAllowlistInput = z.infer<typeof setAllowlistInputSchema>

// ─── GET response ────────────────────────────────────────────────────────

/**
 * Each row joins the allowlist entry against its `mcp_connections` parent so
 * the UI doesn't need a second roundtrip to render "GitHub → `create_issue`".
 */
export const allowlistEntryResponseSchema = z.object({
  mcpConnectionId: z.uuid(),
  mcpConnectionName: z.string(),
  toolName: z.string(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
})

export type AllowlistEntryResponse = z.infer<
  typeof allowlistEntryResponseSchema
>

// ─── URL params ──────────────────────────────────────────────────────────

export const agentMcpToolsAgentParamSchema = z.object({
  agentId: z.uuid(),
})
export type AgentMcpToolsAgentParam = z.infer<
  typeof agentMcpToolsAgentParamSchema
>
