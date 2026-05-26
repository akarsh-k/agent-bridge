/**
 * Local keyword retrieval for the inspector wrappers
 * (`docs/ARCHITECTURE.md §10`). Stand-in for gitnexus_query's BM25 arm, which is broken
 * upstream while [GitNexus#1287] keeps the FTS-index-on-read-only-DB
 * issue open.
 *
 * Why this exists at all:
 *   - Gitnexus's hybrid `query` is BM25 + semantic + RRF.
 *   - Semantic works (after our env-forwarding fix).
 *   - BM25 returns 0 because the gitnexus mcp server opens its DB
 *     read-only and lazy FTS index creation fails.
 *   - Result: literal-keyword queries (e.g. "useElements", a stack-
 *     trace symbol) miss the most precise matches. The semantic
 *     vectors are blurry on identifier-name lookup.
 *
 * What this is:
 *   - A thin wrapper around `@vscode/ripgrep` (the npm package that
 *     bundles the platform-specific ripgrep binary, ~1MB, MIT-
 *     licensed, used by VS Code in production).
 *   - Returns `KeywordHit[]` shaped identically to `GitnexusQueryHit`
 *     so the wrapper can union both sources with a one-line dedupe.
 *   - Designed to be deletable when gitnexus#1287 lands: this file +
 *     the two callsites + two event kinds in `events.ts`.
 *
 * Why ripgrep over minisearch / flexsearch:
 *   - Memory-bounded (process-scoped) regardless of repo size.
 *   - No cold-start cliff. minisearch builds an in-RAM index per
 *     repo per BuiltAgent; on a 10k-file monorepo that's seconds of
 *     latency every time the cache evicts (every 30 min).
 *   - Native `.gitignore` (with nested files), binary-skip, large-
 *     file-skip, line numbers, snippets, `--smart-case` — all the
 *     things a code-search needs without us hand-rolling them.
 *   - Used by VS Code's search UI in production — battle-tested at
 *     real scale.
 *
 * Sandbox: ripgrep only reads files. We still spawn through
 * `spawnSandboxed` for HOME-clamp uniformity with every other child
 * process the app launches, plus we pass `--no-config` so `~/.ripgreprc`
 * (which would be inside our gitnexus-home anyway) can't influence
 * results.
 */

import { rgPath } from '@vscode/ripgrep'
import path from 'node:path'

import { spawnSandboxed } from '@agent-bridge/shared/spawn'

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * Match the `GitnexusQueryHit` shape from `gitnexus-callers.ts` so the
 * caller can union both sources with a single dedupe pass. Kept as its
 * own named type so a future divergence (e.g. new fields on the gitnexus
 * side) doesn't silently widen this one.
 */
export interface KeywordHit {
  readonly repo: string
  readonly path: string
  readonly line: number | null
  readonly symbol: string | null
  readonly score: number
  readonly snippet: string | null
  readonly reason: string
  /** Always null on keyword hits — local ripgrep has no node-kind
   *  awareness. Kept so the union dedupe pass with `GitnexusQueryHit`
   *  works without a cast. */
  readonly type: null
  readonly processLabel: null
  readonly processType: null
  readonly stepIndex: null
}

export interface KeywordSearchInput {
  /** Absolute path to the cloned source directory. */
  readonly sourceDir: string
  /** Friendly repo label echoed back on every hit. */
  readonly repoLabel: string
  /** One or more literal terms to OR together in a single ripgrep run. */
  readonly queries: readonly string[]
  /**
   * Total cap on returned hits. Default 12. Per-file cap is derived
   * from this so a single file can't dominate the result set.
   */
  readonly limit?: number
  /**
   * Hard timeout per ripgrep invocation. Default 8 seconds — even on
   * a 100k-file repo ripgrep finishes in 1-2s; an 8s ceiling means a
   * stuck process never blocks the wrapper indefinitely.
   */
  readonly timeoutMs?: number
}

/**
 * One ripgrep spawn that ORs every query (`-e PATTERN1 -e PATTERN2 …`)
 * across the source tree, then post-ranks by file-path relevance +
 * occurrence count + early-line-number. Returns up to `limit` hits.
 *
 * Failure modes:
 *   - rg exits 0   →  found matches, parse them
 *   - rg exits 1   →  no matches (NORMAL — return empty array)
 *   - rg exits 2+  →  error (bad regex, IO failure). throw with
 *                     stderr so the wrapper can record a warning
 *   - timeout      →  kill the child, throw a timeout error
 *
 * Exit codes are documented in ripgrep's man page. Treat 0 and 1 as
 * "the search ran"; anything else is exceptional.
 */
export async function keywordSearch(
  input: KeywordSearchInput,
): Promise<KeywordHit[]> {
  const { sourceDir, repoLabel, queries, limit = 12, timeoutMs = 8_000 } = input

  const validQueries = queries
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && q.length <= 200)
  if (validQueries.length === 0) return []

  const perFileMax = Math.max(2, Math.ceil(limit / 3))
  const args = [
    '--json',
    '--smart-case',
    '--max-count',
    String(perFileMax),
    '--max-filesize',
    '512K',
    '--no-heading',
    '--no-config',
    '--threads',
    '4',
    // Treat every query as a literal substring, not a regex. The LLM
    // produces things like `cart.compute` that would match unintended
    // things if interpreted as regex.
    '--fixed-strings',
  ]
  for (const q of validQueries) {
    args.push('-e', q)
  }
  // Trailing `--` then the path, so args that happen to start with
  // `-` aren't reinterpreted as flags.
  args.push('--', sourceDir)

  const child = spawnSandboxed(rgPath, args, {
    cwd: sourceDir,
    sandbox: 'default',
    allowHostHome: false,
    stdio: 'pipe',
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `[keyword-search] ripgrep timed out after ${timeoutMs}ms in ${sourceDir}`,
        ),
      )
    }, timeoutMs)
    timer.unref()
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(typeof code === 'number' ? code : -1)
    })
  })

  if (exitCode === 1) {
    // Normal "no matches" — ripgrep exits 1 when nothing matched.
    return []
  }
  if (exitCode !== 0) {
    throw new Error(
      `[keyword-search] ripgrep exited ${exitCode}: ${stderr.slice(0, 400)}`,
    )
  }

  return parseAndRankRgJson(stdout, {
    sourceDir,
    repoLabel,
    queries: validQueries,
    limit,
  })
}

// ─── Internals ──────────────────────────────────────────────────────────

interface ParseInput {
  readonly sourceDir: string
  readonly repoLabel: string
  readonly queries: readonly string[]
  readonly limit: number
}

/**
 * Each line of stdout is one JSON object. We care about `type: 'match'`
 * frames; ignore `begin` / `end` / `context` / `summary`.
 *
 * Match shape (ripgrep --json):
 *   {
 *     type: 'match',
 *     data: {
 *       path: { text: '/abs/path/to/file.ts' } | { bytes: '...' },
 *       lines: { text: '…the matching line…' },
 *       line_number: 42,
 *       absolute_offset: 1234,
 *       submatches: [
 *         { match: { text: 'useElements' }, start: 4, end: 15 },
 *         …
 *       ]
 *     }
 *   }
 */
function parseAndRankRgJson(stdout: string, ctx: ParseInput): KeywordHit[] {
  const lines = stdout.split('\n')
  // Per-file accumulator so we can rank by total occurrence count
  // before flattening. ripgrep emits matches in file order; we group
  // here so the post-rank can favour files with many matches over
  // files with one.
  const perFile = new Map<
    string,
    {
      relPath: string
      totalSubmatches: number
      matchedQueries: Set<string>
      hits: Array<{
        line: number
        snippet: string
        submatchTexts: readonly string[]
      }>
    }
  >()

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    let frame: unknown
    try {
      frame = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (
      !frame ||
      typeof frame !== 'object' ||
      (frame as { type?: unknown }).type !== 'match'
    ) {
      continue
    }
    const data = (frame as { data?: unknown }).data
    if (!data || typeof data !== 'object') continue
    const d = data as Record<string, unknown>

    const absPath = readRgText(d['path'])
    if (!absPath) continue
    const relPath = path.relative(ctx.sourceDir, absPath)
    const lineNumber =
      typeof d['line_number'] === 'number' ? d['line_number'] : 0
    const lineText = readRgText(d['lines']) ?? ''
    const submatches = Array.isArray(d['submatches'])
      ? (d['submatches'] as unknown[])
      : []

    const submatchTexts: string[] = []
    for (const sm of submatches) {
      if (!sm || typeof sm !== 'object') continue
      const t = readRgText((sm as Record<string, unknown>)['match'])
      if (t) submatchTexts.push(t)
    }
    if (submatchTexts.length === 0) continue

    const fileEntry = perFile.get(relPath) ?? {
      relPath,
      totalSubmatches: 0,
      matchedQueries: new Set<string>(),
      hits: [],
    }
    fileEntry.totalSubmatches += submatchTexts.length
    for (const t of submatchTexts) fileEntry.matchedQueries.add(t)
    fileEntry.hits.push({
      line: lineNumber,
      snippet: clipSnippet(lineText),
      submatchTexts,
    })
    perFile.set(relPath, fileEntry)
  }

  // Per-file score — favour:
  //   - files whose path contains a query literal (massive boost; this
  //     is "the file is named after the thing you searched for")
  //   - higher total occurrence counts
  //   - earlier-line first hits (decay 1/N)
  // Then flatten to per-line hits with the same file score so the
  // codebase-inspection-report's path-level ordering is stable.
  const fileScores = new Map<string, number>()
  for (const [relPath, f] of perFile.entries()) {
    let score = f.totalSubmatches
    const lowerPath = relPath.toLowerCase()
    for (const q of ctx.queries) {
      if (lowerPath.includes(q.toLowerCase())) {
        // 5 per query that appears in the path, capped so a degenerate
        // query like "i" doesn't dominate.
        score += 5
        break
      }
    }
    if (f.hits[0]) {
      score += Math.max(0, 1 - f.hits[0].line / 1000)
    }
    fileScores.set(relPath, score)
  }

  // Flatten + sort. One KeywordHit per `(file, first-match-line)` so
  // the dedupe in the caller doesn't have to thrash on line collisions.
  const out: KeywordHit[] = []
  for (const [relPath, f] of perFile.entries()) {
    const fileScore = fileScores.get(relPath) ?? 0
    const matchedTerms = [...f.matchedQueries].slice(0, 3).join(', ')
    // Prefer the EARLIEST hit per file as the representative.
    const firstHit = [...f.hits].sort((a, b) => a.line - b.line)[0]
    if (!firstHit) continue
    out.push({
      repo: ctx.repoLabel,
      path: relPath,
      line: firstHit.line || null,
      symbol: null,
      score: fileScore,
      snippet: firstHit.snippet,
      reason: `keyword: ${matchedTerms} ×${f.totalSubmatches}`,
      type: null,
      processLabel: null,
      processType: null,
      stepIndex: null,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, ctx.limit)
}

/**
 * Pull the human-readable text out of one of ripgrep's `data.path` /
 * `data.lines` / `submatch.match` slots. ripgrep returns either
 * `{text: string}` for utf-8 content OR `{bytes: base64}` for paths
 * with non-utf8 bytes. We treat the bytes case as best-effort base64
 * decode → utf-8; failures yield `null`.
 */
function readRgText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj['text'] === 'string') return obj['text']
  if (typeof obj['bytes'] === 'string') {
    try {
      return Buffer.from(obj['bytes'], 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  return null
}

/**
 * Trim a match line to a readable snippet. Ripgrep already gives us
 * just the matched line, so usually this is a no-op; we cap obscenely
 * long minified-bundle hits at 200 chars to keep the wire payload
 * bounded.
 */
function clipSnippet(line: string): string {
  const trimmed = line.replace(/[\r\n]+$/g, '')
  if (trimmed.length <= 200) return trimmed
  return trimmed.slice(0, 199) + '…'
}
