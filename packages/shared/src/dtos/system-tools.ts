/**
 * Read-only enumeration of the system-mounted MCP tools — currently
 * just the gitnexus catalog. Frontend uses this to display a
 * "System defaults" section in the Tools tab so users can see what
 * their agent has access to without reading source.
 */

import { z } from 'zod'

export const systemToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
})
export type SystemToolDefinition = z.infer<typeof systemToolDefinitionSchema>

export const gitnexusSystemToolsResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    cliVersion: z.string(),
    tools: z.array(systemToolDefinitionSchema),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
  }),
])
export type GitnexusSystemToolsResponse = z.infer<
  typeof gitnexusSystemToolsResponseSchema
>
