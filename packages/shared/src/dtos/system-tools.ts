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

/**
 * Coding-agent system skill. the markdown body Agent Bridge
 * auto-attaches to every agent's instructions, plus its version
 * (drives BuiltAgent cache invalidation) and heading marker
 * (operators authoring an override skill use this exact heading
 * to suppress the auto-attach). Surfaced read-only on the
 * Resources tab.
 */
export const codingAgentSystemSkillResponseSchema = z.discriminatedUnion(
  'ok',
  [
    z.object({
      ok: z.literal(true),
      version: z.string(),
      heading: z.string(),
      body: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      message: z.string(),
    }),
  ],
)
export type CodingAgentSystemSkillResponse = z.infer<
  typeof codingAgentSystemSkillResponseSchema
>

/**
 * GitNexus library skills response. The same vendor-shipped
 * markdown files (gitnexus-guide, -impact-analysis, -debugging,
 * etc.) the agent's instructions auto-attach. Surfaced read-only
 * on the Resources tab so the operator can see what's contributing
 * to the prompt without re-reading the npm package.
 */
const gitnexusLibrarySkillEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type GitnexusLibrarySkillEntry = z.infer<
  typeof gitnexusLibrarySkillEntrySchema
>

export const gitnexusLibrarySkillsResponseSchema = z.discriminatedUnion(
  'ok',
  [
    z.object({
      ok: z.literal(true),
      version: z.string(),
      skills: z.array(gitnexusLibrarySkillEntrySchema),
    }),
    z.object({
      ok: z.literal(false),
      message: z.string(),
    }),
  ],
)
export type GitnexusLibrarySkillsResponse = z.infer<
  typeof gitnexusLibrarySkillsResponseSchema
>
