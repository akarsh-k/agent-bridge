/**
 * Loader for the skill files gitnexus ships inside its npm package.
 *
 * Source: `node_modules/.../gitnexus/skills/*.md` (the package's
 * `files` array includes the `skills` dir, so they're present after
 * `pnpm install` regardless of any repo being indexed).
 *
 * Each file has the shape:
 *
 *     ---
 *     name: gitnexus-impact-analysis
 *     description: "Use when the user wants to know what will break..."
 *     ---
 *
 *     # Impact Analysis with GitNexus
 *     ...
 *
 * We parse the frontmatter for `name` + `description` (used by the
 * UI catalog), strip it from the body (gitnexus's skill-discovery
 * metadata is noise to our LLM), and return the cleaned body for
 * concatenation into the agent's instructions.
 *
 * Module-level cache, keyed by gitnexus version. A version bump
 * (handled at install time via the repo-wide `pnpm-overrides` pin)
 * causes the next `loadGitnexusLibrarySkills()` call to read fresh
 * content; intra-process invalidation isn't needed because the
 * gitnexus version can't change without restarting the process.
 *
 * Fail-open: any FS / parse error returns an empty array. The
 * agent still functions without the library skills, just without
 * gitnexus's tool-call recipes.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  EXPECTED_GITNEXUS_VERSION,
  resolveGitnexusSkillsDir,
} from '@agent-bridge/shared/gitnexus'

export interface GitnexusLibrarySkill {
  /** Filename slug (no extension), e.g. `gitnexus-impact-analysis`. */
  readonly slug: string
  /** From frontmatter; falls back to slug when absent. */
  readonly name: string
  /** From frontmatter; empty string when absent. */
  readonly description: string
  /** Markdown body with frontmatter stripped, leading whitespace trimmed. */
  readonly body: string
  /** Token-rough byte count for the budget card. */
  readonly bytes: number
}

export interface GitnexusLibrarySkillsLoaded {
  /** Mirrors `EXPECTED_GITNEXUS_VERSION` for cache-key + UI display. */
  readonly version: string
  readonly skills: ReadonlyArray<GitnexusLibrarySkill>
}

let cached: Promise<GitnexusLibrarySkillsLoaded> | null = null

export function loadGitnexusLibrarySkills(): Promise<GitnexusLibrarySkillsLoaded> {
  if (cached) return cached
  cached = (async () => {
    let dir: string
    try {
      dir = resolveGitnexusSkillsDir(import.meta.url)
    } catch (err) {
      console.warn(
        '[gitnexus-library-skills] cannot resolve skills dir:',
        (err as Error).message,
      )
      return { version: EXPECTED_GITNEXUS_VERSION, skills: [] }
    }

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      console.warn(
        `[gitnexus-library-skills] cannot read ${dir}:`,
        (err as Error).message,
      )
      return { version: EXPECTED_GITNEXUS_VERSION, skills: [] }
    }

    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()
    const skills: GitnexusLibrarySkill[] = []
    for (const file of mdFiles) {
      const slug = file.slice(0, -3)
      try {
        const raw = await readFile(path.join(dir, file), 'utf8')
        const parsed = parseSkillFile(raw, slug)
        skills.push(parsed)
      } catch (err) {
        console.warn(
          `[gitnexus-library-skills] cannot read ${file}:`,
          (err as Error).message,
        )
      }
    }
    return { version: EXPECTED_GITNEXUS_VERSION, skills }
  })()
  // On rejection (which the inner try/catch shouldn't allow, but just
  // in case). clear the cache so a future call can retry.
  cached.catch(() => {
    cached = null
  })
  return cached
}

// ─── Frontmatter parsing ────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/

/**
 * Strip and parse the YAML frontmatter at the top of a skill file.
 * We only care about two fields (`name` + `description`) and don't
 * pull in a YAML library for those. a flat key:value scan is safe
 * for gitnexus's known shape and saves a dep. Anything weirder
 * (multi-line strings beyond the simple double-quoted case, lists,
 * nested maps) is ignored; the body strip still works.
 */
function parseSkillFile(
  raw: string,
  slug: string,
): GitnexusLibrarySkill {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) {
    const body = raw.trim()
    return {
      slug,
      name: slug,
      description: '',
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
    }
  }
  const fmText = match[1] ?? ''
  const body = raw.slice(match[0].length).trim()
  const meta = parseFlatYamlSubset(fmText)
  return {
    slug,
    name: typeof meta['name'] === 'string' && meta['name'].length > 0 ? meta['name'] : slug,
    description: typeof meta['description'] === 'string' ? meta['description'] : '',
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
  }
}

/**
 * Parse `key: value` lines, with optional double-quoted values.
 * Skips lines that don't match. Sufficient for gitnexus's two-field
 * frontmatter; not a real YAML parser.
 */
function parseFlatYamlSubset(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.length === 0) continue
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
    }
    out[key] = value
  }
  return out
}
