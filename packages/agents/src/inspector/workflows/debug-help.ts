/**
 * `debug_help` wrapper (`docs/ARCHITECTURE.md §10` Phase E E3).
 *
 * Inputs are an `error_text` (stack trace, log line, exception message)
 * plus an optional `query` (developer's free-form description of what
 * went wrong). We extract candidate symbols + file paths from the
 * error text via language-agnostic regexes, then run gitnexus_query
 * for each, fetching gitnexus_context for the top hits as suspect
 * call sites.
 *
 * No LLM call from inside this wrapper for now — Phase C's
 * `classifyAndExpand` is wired into `find_in_codebase` first; debug
 * scenarios benefit from a dedicated symbol-extractor pass that LLM
 * expansion would over-generalise (a stack frame at `cart.compute()`
 * deserves the literal `compute` more than a fanned-out list of
 * synonyms). If empirical results say otherwise, Phase F can layer
 * expansion in.
 *
 * Recent commits / git-log integration is deferred. gitnexus's
 * `cypher` tool exposes commit nodes, but the schema isn't pinned;
 * a wrong cypher just returns nothing rather than failing loudly,
 * which is the worst kind of bug. Plan's "recent_changes" lives as
 * a follow-up.
 */

import type { AttachedRepo } from '@agent-bridge/shared'
import { repoSourceDir } from '@agent-bridge/shared/paths'

import {
  callGitnexusContext,
  callGitnexusQuery,
  type GitnexusQueryHit,
  type ToolDict,
} from '../gitnexus-callers.js'
import {
  keywordSearch,
  type KeywordHit,
} from '../keyword-search.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import { resolveRepoFromHint } from '../repo-resolve.js'
import type {
  MiniRepo,
  MiniRepoChunk,
  MiniRepoFile,
} from '../types.js'
import {
  emitMinirepoBuilt,
  emitToolCalled,
  emitToolResult,
  withGitnexusCall,
  withKeywordCall,
} from '../wrapper-telemetry.js'

const MAX_CANDIDATES = 8 as const
const MAX_FILES = 10 as const

export interface DebugHelpInput {
  readonly tools: ToolDict
  readonly repos: readonly AttachedRepo[]
  readonly errorText: string
  /** Optional free-form developer query. */
  readonly query?: string
  readonly repoHint?: string | null
}

export async function runDebugHelp(input: DebugHelpInput): Promise<MiniRepo> {
  const { tools, repos, errorText, query, repoHint } = input
  const handle = await emitToolCalled('debug_help', {
    error_text_chars: errorText.length,
    query,
    repo_hint: repoHint,
  })

  const trimmedError = errorText.trim()
  if (trimmedError.length === 0) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Pass the error text or stack trace to debug.',
      warnings: ['empty error_text'],
    }))
    await emitMinirepoBuilt('debug_help', result)
    await emitToolResult({
      handle,
      wrapperName: 'debug_help',
      status: 'error',
      message: 'empty error_text',
    })
    return result
  }

  const resolution = resolveRepoFromHint({ repos, hint: repoHint, allowAll: true })
  if (resolution.ok === false) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: `Could not resolve repo: ${resolution.message}`,
      warnings: [resolution.message],
    }))
    await emitMinirepoBuilt('debug_help', result)
    await emitToolResult({
      handle,
      wrapperName: 'debug_help',
      status: 'error',
      message: resolution.message,
    })
    return result
  }
  const targets: readonly AttachedRepo[] =
    resolution.ok === true ? [resolution.repo] : resolution.repos

  const candidates = extractCandidates(trimmedError, query?.trim() ?? '')
  if (candidates.length === 0) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Could not extract any file paths or symbol names from the error text.',
      warnings: ['no candidates extracted'],
    }))
    await emitMinirepoBuilt('debug_help', result)
    await emitToolResult({
      handle,
      wrapperName: 'debug_help',
      status: 'fallback',
      message: 'no candidates extracted',
    })
    return result
  }

  const warnings: string[] = []
  type Hit = { repo: AttachedRepo; hit: GitnexusQueryHit; candidate: string }
  const allHits: Hit[] = []
  for (const r of targets) {
    for (const candidate of candidates) {
      try {
        const hits = await withGitnexusCall(
          'debug_help',
          'gitnexus_query',
          { repo: r.label, query: candidate, limit: 6 },
          () =>
            callGitnexusQuery({
              tools,
              repo: r.label,
              query: candidate,
              limit: 6,
            }),
        )
        for (const hit of hits) allHits.push({ repo: r, hit, candidate })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `gitnexus_query failed for repo "${r.label}", candidate "${candidate}": ${message}`,
        )
      }
    }
  }

  // Phase I: in parallel with the gitnexus loop above, fan out one
  // ripgrep spawn per repo with all stack-trace-extracted candidates
  // OR'd together. Stack traces are exactly the case where literal
  // identifier matching dominates (`cart.compute`, `Cart.tsx`); the
  // semantic arm of gitnexus_query embeds those as fuzzy
  // payment-y vibes which isn't what we want. Deletable when
  // gitnexus#1287 lands. Errors fold into warnings, never block.
  const keywordTasks = targets.map(async (r) => {
    const sourceDir = repoSourceDir({
      id: r.repo_id,
      remoteUrl: r.remote_url,
      branch: r.branch,
    })
    const result = await withKeywordCall(
      'debug_help',
      r.label,
      candidates,
      () =>
        keywordSearch({
          sourceDir,
          repoLabel: r.label,
          queries: candidates,
          limit: MAX_FILES,
        }),
    )
    if (!result.ok) {
      warnings.push(
        `keyword_search failed for repo "${r.label}": ${result.error ?? 'unknown'}`,
      )
      return { repo: r, hits: [] as readonly KeywordHit[] }
    }
    return { repo: r, hits: result.value ?? [] }
  })
  const keywordSettled = await Promise.all(keywordTasks)
  for (const { repo, hits } of keywordSettled) {
    for (const k of hits) {
      // Best-effort candidate attribution: pick the first candidate that
      // appears in the keyword hit's `reason` field (we put matched
      // terms there). Fall back to the first candidate so the row
      // still has a label.
      const matchedCandidate =
        candidates.find((c) => k.reason.includes(c)) ?? candidates[0] ?? ''
      allHits.push({
        repo,
        hit: k as GitnexusQueryHit,
        candidate: matchedCandidate,
      })
    }
  }

  // Highest-score wins per (repo, path). Stable sort then dedupe.
  const sorted = allHits.sort((a, b) => b.hit.score - a.hit.score)
  const seen = new Set<string>()
  const picked: Hit[] = []
  for (const h of sorted) {
    if (picked.length >= MAX_FILES) break
    const key = `${h.repo.repo_id}::${h.hit.path}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(h)
  }

  // Fetch context for each suspect site so the LLM has the actual
  // function body / surrounding code to reason about, not just a path.
  const files: MiniRepoFile[] = []
  for (const h of picked) {
    let chunks: MiniRepoChunk[] = []
    try {
      const ctx = await withGitnexusCall(
        'debug_help',
        'gitnexus_context',
        { repo: h.repo.label, path: h.hit.path },
        () =>
          callGitnexusContext({
            tools,
            repo: h.repo.label,
            path: h.hit.path,
          }),
      )
      if (ctx) {
        chunks = [
          {
            start_line: ctx.startLine ?? h.hit.line ?? 1,
            end_line:
              ctx.endLine ??
              (ctx.startLine ?? h.hit.line ?? 1) +
                Math.max(0, ctx.content.split('\n').length - 1),
            content: ctx.content,
          },
        ]
      } else if (h.hit.snippet) {
        chunks = [
          {
            start_line: h.hit.line ?? 1,
            end_line: h.hit.line ?? 1,
            content: h.hit.snippet,
          },
        ]
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`gitnexus_context failed for ${h.hit.path}: ${message}`)
      if (h.hit.snippet) {
        chunks = [
          {
            start_line: h.hit.line ?? 1,
            end_line: h.hit.line ?? 1,
            content: h.hit.snippet,
          },
        ]
      }
    }
    files.push({
      repo_id: h.repo.repo_id,
      repo_label: h.repo.label,
      path: h.hit.path,
      language: inferLanguage(h.hit.path),
      chunks,
      why: `matched candidate "${h.candidate}" extracted from error text`,
    })
  }

  const summary =
    files.length === 0
      ? `No matches in ${targets.length} repo(s) for ${candidates.length} candidate(s) extracted from the error text.`
      : `Found ${files.length} suspect call site(s) across ${targets.length} repo(s) from ${candidates.length} candidate(s) (${candidates.slice(0, 4).join(', ')}${candidates.length > 4 ? '…' : ''}).`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'debug_help',
    summary,
    intent: 'debug',
    expansions: candidates,
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings,
  })
  await emitMinirepoBuilt('debug_help', miniRepo)
  await emitToolResult({
    handle,
    wrapperName: 'debug_help',
    status: warnings.length > 0 ? 'fallback' : 'ok',
    ...(warnings.length > 0 ? { message: warnings[0] } : {}),
  })
  return miniRepo
}

// ─── Candidate extraction ────────────────────────────────────────────────

/**
 * Pull file paths and symbol-shaped tokens out of the error text +
 * developer query. Language-agnostic by design: we want patterns that
 * appear across stacks regardless of runtime.
 *
 * Patterns recognised:
 *   - File paths with a dotted extension: `src/foo/bar.ts:42` /
 *     `bar.py:line 17` / `node_modules/x/y.js`. Strips line/column
 *     suffixes.
 *   - CamelCase identifiers (≥4 chars): `UserService`, `parseInput`.
 *   - Snake_case identifiers (≥4 chars): `update_total`, `_helper`.
 *   - Dotted call sites: `cart.compute`, `auth.middleware`.
 *
 * Dedupes case-insensitively, caps at MAX_CANDIDATES. The query string
 * appended at the end so developer-supplied terms are last (and
 * de-duped against extracted ones).
 */
function extractCandidates(errorText: string, query: string): readonly string[] {
  const out = new Set<string>()
  const add = (s: string): void => {
    const trimmed = s.trim()
    if (trimmed.length < 2 || trimmed.length > 80) return
    const key = trimmed.toLowerCase()
    if ([...out].some((existing) => existing.toLowerCase() === key)) return
    out.add(trimmed)
  }

  // File paths with extensions (TS/JS/Py/Go/Rust/Java/Ruby/PHP/etc.).
  // Matches `a/b/c.ext` and trims trailing `:N[:M]`.
  const pathRe =
    /\b([A-Za-z0-9_\-./]+\.[a-zA-Z]{1,8})(?::\d+(?::\d+)?)?\b/g
  let m: RegExpExecArray | null
  while ((m = pathRe.exec(errorText)) && out.size < MAX_CANDIDATES * 2) {
    if (m[1]) add(m[1])
  }

  // CamelCase + dotted identifiers (`Cart.compute`, `UserService`).
  const symRe = /\b([A-Z][a-zA-Z0-9_]{2,}(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\b/g
  while ((m = symRe.exec(errorText)) && out.size < MAX_CANDIDATES * 2) {
    if (m[1]) add(m[1])
  }

  // snake_case identifiers (`update_total`, `_helper`).
  const snakeRe = /\b([a-z_][a-z0-9_]{3,})\b/g
  while ((m = snakeRe.exec(errorText)) && out.size < MAX_CANDIDATES * 2) {
    if (m[1] && m[1].includes('_')) add(m[1])
  }

  // Append developer query verbatim.
  if (query.length > 0) add(query)

  return [...out].slice(0, MAX_CANDIDATES)
}

function inferLanguage(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'unknown'
  const ext = path.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    cs: 'csharp',
    cpp: 'cpp',
    php: 'php',
  }
  return map[ext] ?? ext
}

function emptyDraft(args: {
  summary: string
  warnings?: readonly string[]
}): MiniRepoDraft {
  return {
    wrapper: 'debug_help',
    summary: args.summary,
    intent: 'debug',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings: args.warnings,
  }
}
