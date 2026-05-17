/**
 * Loader for the inspector toolkit's auto-attached system prompt
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Composed into every inspector agent's instructions by
 * `build-agent.ts:composeInstructions`, AFTER the operator's base
 * system prompt and BEFORE operator-authored skills, so skills get
 * the last-word position and can override wrapper-call defaults.
 *
 * Cache strategy: read once per process, cache the resolved string.
 * The file size is ~3 KB, so memory is fine.
 *
 * Idempotency: `composeInstructions` checks for the heading marker
 * below before auto-attaching. An operator skill whose body already
 * contains `# Inspector toolkit` is treated as an explicit override
 * and the auto-attach is skipped.
 *
 * Versioning: bump `INSPECTOR_SYSTEM_PROMPT_VERSION` on substantive
 * edits. The `BuiltAgent` cache hash includes this string so cached
 * agents on long-running backend processes rebuild on next access.
 */

import { readFile } from 'node:fs/promises'

export const INSPECTOR_SYSTEM_PROMPT_VERSION = '0.6.1' as const

export const INSPECTOR_SYSTEM_PROMPT_HEADING = '# Inspector toolkit' as const

let cached: Promise<string> | null = null

export function loadInspectorSystemPrompt(): Promise<string> {
  if (cached) return cached
  const url = new URL('./system-prompt.md', import.meta.url)
  cached = readFile(url, 'utf8').then(
    (text) => text.trim(),
    (err) => {
      // Reset on failure so a transient FS hiccup doesn't pin a
      // rejected promise for the lifetime of the process.
      cached = null
      throw new Error(
        `[inspector system prompt] failed to load system-prompt.md: ` +
          (err instanceof Error ? err.message : String(err)),
      )
    },
  )
  return cached
}
