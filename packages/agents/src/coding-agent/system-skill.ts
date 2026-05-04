/**
 * Coding-agent system skill. auto-attached to every agent's
 * instructions (alongside the gitnexus repo inventory and repo edges
 * that already get auto-attached). The body lives next to this file
 * as `system-skill.md` so it gets editor syntax highlighting and
 * isn't trapped behind backtick-escaping.
 *
 * Why a sibling .md and not an inline TS string:
 *   The markdown body is dense with code-span backticks. Inlining
 *   would force escaping every one of them; the .md keeps the
 *   editing experience clean and the body diffable. The build
 *   script copies the .md into `dist/coding-agent/` so production
 *   reads work without falling back to the source tree.
 *
 * Cache strategy:
 *   - First call reads the file (async, off the event loop).
 *   - Subsequent calls return the resolved promise. file size is
 *     a few KB, so caching as a string is fine.
 *   - The read NEVER reads from a network mount or refreshes; the
 *     content is a build-time artifact. To pick up edits during
 *     `pnpm dev`, restart the watcher (or bump
 *     `CODING_AGENT_SYSTEM_SKILL_VERSION` and rely on the BuiltAgent
 *     cache invalidation hash to force a rebuild).
 *
 * Versioning:
 *   `CODING_AGENT_SYSTEM_SKILL_VERSION` is a semver string baked
 *   into the BuiltAgent cache hash (`built-agent-cache.ts`). When
 *   you edit the .md body, bump this. Cached agents on long-running
 *   backend processes will rebuild on next access.
 */

import { readFile } from 'node:fs/promises'

/**
 * Pre-release working version. Bump on every substantive edit to
 * `system-skill.md`. The BuiltAgent cache uses string equality, not
 * semver-aware compare. any change forces a rebuild.
 */
export const CODING_AGENT_SYSTEM_SKILL_VERSION = '0.16.3' as const

/**
 * Heading marker used by `composeInstructions` to detect operator
 * overrides. If the operator authored a `skills` row whose
 * `markdownBody` already contains this exact heading, we skip the
 * auto-attach so we don't append the same section twice.
 */
export const CODING_AGENT_SYSTEM_SKILL_HEADING =
  '# Coding-agent toolkit guidance' as const

let cached: Promise<string> | null = null

/**
 * Read + cache the markdown body. The path resolves to
 * `system-skill.md` colocated with this module. same dir in
 * `src/coding-agent/` (dev) and `dist/coding-agent/` (prod, after
 * the build script copies the .md alongside the compiled .js).
 */
export function loadCodingAgentSystemSkill(): Promise<string> {
  if (cached) return cached
  const url = new URL('./system-skill.md', import.meta.url)
  cached = readFile(url, 'utf8').then(
    (text) => text.trim(),
    (err) => {
      // Reset the cache on failure so a transient FS hiccup (or a
      // bad build that didn't copy the .md into dist) doesn't pin
      // a rejected promise for the lifetime of the process.
      cached = null
      throw new Error(
        `[coding-agent system skill] failed to load system-skill.md: ` +
          (err instanceof Error ? err.message : String(err)),
      )
    },
  )
  return cached
}
