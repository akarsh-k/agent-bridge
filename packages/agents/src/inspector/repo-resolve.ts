/**
 * Resolve a single-string `repo_hint` against the agent's attached repos
 * (`docs/ARCHITECTURE.md §10` Phase B). Simpler than the IDE-side
 * `coding-agent/repo-resolver.ts`. inputs are a string, not a multi-signal
 * object; outputs are a single repo or a clear "ambiguous"/"miss" reason
 * the workflow can surface to the LLM.
 *
 * We deliberately keep this lightweight: wrapper tools are called from
 * inside our own Mastra agent, which already has access to the attached
 * repo inventory and can re-prompt the user. The full resolver's score
 * table + clarification round-trip is overkill here.
 */

import type { AttachedRepo } from '@agent-bridge/shared'

import { urlTail } from '../coding-agent/url-normalize.js'

export type RepoResolveResult =
  | { ok: true; repo: AttachedRepo }
  | { ok: 'all'; repos: readonly AttachedRepo[] }
  | { ok: false; code: 'no_repos' | 'not_found' | 'ambiguous'; message: string; candidates: readonly string[] }

export interface ResolveInput {
  readonly repos: readonly AttachedRepo[]
  /** Optional hint string. Friendly label / alias / URL tail / `__all__`. */
  readonly hint: string | null | undefined
  /**
   * When `true` and `hint` is missing, allow returning the full repo
   * list. Wrappers like `find_in_codebase` opt in; single-repo wrappers
   * (`assess_change_impact`) leave this `false`.
   */
  readonly allowAll?: boolean
}

const ALL_SENTINEL = '__all__'

/**
 * String values LLMs frequently emit for "no value" instead of omitting
 * the optional field. The wrapper-tool input schema marks `repo_hint`
 * as nullable + optional, but some models stringify `null` / `undefined`
 * directly into the tool-call args. Treat these the same as no hint.
 */
const EMPTY_HINT_LITERALS = new Set(['null', 'undefined', 'none', 'n/a', '-'])

function isEffectivelyEmpty(hint: string | null | undefined): boolean {
  if (!hint) return true
  const trimmed = hint.trim()
  if (trimmed.length === 0) return true
  return EMPTY_HINT_LITERALS.has(trimmed.toLowerCase())
}

export function resolveRepoFromHint(input: ResolveInput): RepoResolveResult {
  const { repos, hint, allowAll = false } = input

  if (repos.length === 0) {
    return {
      ok: false,
      code: 'no_repos',
      message: 'this agent has no repos attached',
      candidates: [],
    }
  }

  // No hint (or LLM-emitted "no value" stringification), single repo →
  // unambiguous.
  if (isEffectivelyEmpty(hint)) {
    if (repos.length === 1) return { ok: true, repo: repos[0]! }
    if (allowAll) return { ok: 'all', repos }
    return {
      ok: false,
      code: 'ambiguous',
      message: `agent has ${repos.length} repos attached; pass repo_hint`,
      candidates: repos.map((r) => r.label),
    }
  }

  const trimmed = hint!.trim()
  const lower = trimmed.toLowerCase()

  if (trimmed === ALL_SENTINEL) {
    if (allowAll) return { ok: 'all', repos }
    return {
      ok: false,
      code: 'ambiguous',
      message: `this wrapper does not accept ${ALL_SENTINEL}`,
      candidates: repos.map((r) => r.label),
    }
  }

  const hits: AttachedRepo[] = []
  for (const r of repos) {
    const role = r.role?.trim().toLowerCase() ?? ''
    if (role && role === lower) {
      hits.push(r)
      continue
    }
    if (r.aliases.some((a) => a.toLowerCase() === lower)) {
      hits.push(r)
      continue
    }
    const tail = urlTail(r.remote_url).toLowerCase()
    if (tail.length > 0 && tail === lower) {
      hits.push(r)
      continue
    }
  }

  if (hits.length === 1) return { ok: true, repo: hits[0]! }
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `repo_hint "${trimmed}" matches ${hits.length} repos`,
      candidates: hits.map((r) => r.label),
    }
  }

  // No hits AND only one attached repo → fall back to the only repo.
  // The LLM probably typo'd or hallucinated the label; the user asking
  // a question about THE repo is the obvious intent. Better than
  // refusing and watching the LLM retry the same call N times.
  if (repos.length === 1) return { ok: true, repo: repos[0]! }

  return {
    ok: false,
    code: 'not_found',
    message: `no attached repo matches "${trimmed}"`,
    candidates: repos.map((r) => r.label),
  }
}
