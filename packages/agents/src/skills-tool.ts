/**
 * `read_skill` — built-in tool the agent uses to load a lazy skill's
 * full body on demand. Counterpart to the "Available skills" catalog
 * block injected into the system prompt by `composeInstructions()`.
 *
 * Operator skills marked `alwaysInclude=false` (and carrying a non-
 * empty description) appear in the catalog but stay out of the system
 * prompt until the LLM calls this tool, saving tokens on every turn
 * for skills that aren't relevant to the current message.
 *
 * Bodies are captured at build time, not fetched per-call: the
 * `builtAgentCache` invalidates the agent whenever any underlying row
 * changes, so an edit to a skill body forces a rebuild and the next
 * `read_skill` call sees the new body. Per-call DB roundtrips would
 * add latency for no gain.
 *
 * Tool name is bare (`read_skill`, not slug-prefixed) to match the
 * inspector wrappers (`find_in_codebase`, `list_repos`). External MCP
 * tools are prefixed `<slug>__` by `mergeToolDicts`, so collisions
 * can't sneak in there.
 */

import { createTool, type Tool } from '@mastra/core/tools'
import { z } from 'zod'
import type { schema } from '@agent-bridge/db'

type SkillRow = typeof schema.skills.$inferSelect

const readSkillInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Exact name of the skill to load. Must match a name listed in the "Available skills" catalog in your system prompt.',
      ),
  })
  .strict()

function readSkillDescription(skillNames: readonly string[]): string {
  const list = skillNames.map((n) => `\`${n}\``).join(', ')
  return (
    'Load the full body of one of your lazy-loaded skills. ' +
    "Call this when the user's request matches a skill listed in the " +
    '"Available skills" section of your system prompt. ' +
    `Loadable skills: ${list}.`
  )
}

export function buildReadSkillTool(
  lazySkills: readonly SkillRow[],
): Tool<any, any, any, any> | null {
  if (lazySkills.length === 0) return null

  // Frozen lookup. Stays alive for the lifetime of the BuiltAgent
  // cache entry; the cache invalidates when any skill row changes.
  const bodyByName = new Map<string, string>()
  for (const s of lazySkills) bodyByName.set(s.name, s.markdownBody)
  const names = Array.from(bodyByName.keys())

  return createTool({
    id: 'read_skill',
    description: readSkillDescription(names),
    inputSchema: readSkillInputSchema,
    execute: async (input) => {
      const name = input.name.trim()
      const body = bodyByName.get(name)
      if (body === undefined) {
        // Soft fail — return a result the LLM can recover from. A throw
        // would surface as a tool error and confuse the agent into
        // retrying or apologising. The catalog text in the system prompt
        // already constrains the LLM to known names; this branch
        // mostly catches typos.
        return {
          ok: false as const,
          error: `No skill named "${name}". Available: ${names.map((n) => `"${n}"`).join(', ')}.`,
        }
      }
      return { ok: true as const, name, body }
    },
  })
}
