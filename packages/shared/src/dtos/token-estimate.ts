/**
 * Per-call context-budget breakdown for an agent. Computed by the
 * backend (`@agent-bridge/agents/token-estimate`) and rendered by the
 * Configure-tab "Context budget" card.
 */

import { z } from 'zod'

const skillEntry = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
})

const toolEntry = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  source: z.enum(['gitnexus', 'mcp', 'custom']),
})

export const tokenEstimateSchema = z.object({
  model: z.string().nullable(),
  encoding: z.string(),
  modelContextLimit: z.number().int().positive().nullable(),
  parts: z.object({
    systemPrompt: z.number().int().nonnegative(),
    skills: z.array(skillEntry),
    skillsTotal: z.number().int().nonnegative(),
    attachedReposHint: z.number().int().nonnegative(),
    repoEdgesHint: z.number().int().nonnegative(),
    tools: z.array(toolEntry),
    toolsTotal: z.number().int().nonnegative(),
  }),
  baselineTotal: z.number().int().nonnegative(),
})
export type TokenEstimate = z.infer<typeof tokenEstimateSchema>

export const tokenEstimateResponseSchema = z.object({
  ok: z.literal(true),
  estimate: tokenEstimateSchema,
})
export type TokenEstimateResponse = z.infer<typeof tokenEstimateResponseSchema>
