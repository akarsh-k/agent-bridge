import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSandboxed } from './spawn.js'
import type { ChildProcess } from 'node:child_process'
import type { RepoIndexSummary } from './domain.js'

/**
 * Invariants:
 * - GitNexus is pinned to exactly this version in `apps/worker/package.json`
 *   and echoed in root `pnpm.overrides`. Bumping it is deliberate.
 * - We never shell out via `npx gitnexus …` — the CLI entry is resolved from
 *   our own `node_modules` via `createRequire` + `require.resolve`.
 * - Every spawn goes through `spawnSandboxed` so GitNexus's per-user registry,
 *   config, and caches land in the isolated `gitnexus-home` dir.
 *
 * This module is Node-only.
 */

export const EXPECTED_GITNEXUS_VERSION = '1.6.3'

export interface ResolvedGitnexusCli {
  readonly nodeBin: string
  readonly cliEntry: string
  readonly packageVersion: string
}

/**
 * Resolve the installed GitNexus CLI entry and its declared version.
 *
 * `fromModuleUrl` MUST be the caller's `import.meta.url` — resolution happens
 * in the caller's dependency graph. The shared package intentionally does not
 * depend on gitnexus; only apps that actually run it (worker, mcp-bridge) do.
 */
export function resolveGitnexusCli(fromModuleUrl: string): ResolvedGitnexusCli {
  if (!fromModuleUrl) {
    throw new Error(
      '[gitnexus] fromModuleUrl is required — pass `import.meta.url` from the caller.',
    )
  }
  const req = createRequire(fromModuleUrl)
  let pkgPath: string
  try {
    pkgPath = req.resolve('gitnexus/package.json')
  } catch (err) {
    throw new Error(
      `[gitnexus] cannot resolve gitnexus from ${fromModuleUrl}. ` +
        `The calling workspace must declare gitnexus as a dependency. ` +
        `Original: ${(err as Error).message}`,
    )
  }
  const pkgDir = path.dirname(pkgPath)

  const pkgJson = req('gitnexus/package.json') as {
    bin?: string | Record<string, string>
    version?: string
  }
  const binField = pkgJson.bin
  const binRel =
    typeof binField === 'string'
      ? binField
      : (binField?.['gitnexus'] ?? 'dist/cli/index.js')

  return {
    nodeBin: process.execPath,
    cliEntry: path.join(pkgDir, binRel),
    packageVersion: pkgJson.version ?? '0.0.0',
  }
}

/** Confirm the installed version matches the expected pin. Throws on mismatch. */
export function assertExpectedGitnexusVersion(
  fromModuleUrl: string,
): ResolvedGitnexusCli {
  const resolved = resolveGitnexusCli(fromModuleUrl)
  if (resolved.packageVersion !== EXPECTED_GITNEXUS_VERSION) {
    throw new Error(
      `[gitnexus] version mismatch: resolved ${resolved.packageVersion}, ` +
        `expected ${EXPECTED_GITNEXUS_VERSION}. ` +
        `Pin sync required: update apps/worker/package.json, root pnpm.overrides, ` +
        `and the EXPECTED_GITNEXUS_VERSION constant together.`,
    )
  }
  return resolved
}

export interface RunGitnexusOptions {
  /** REQUIRED. Pass the caller's `import.meta.url` so resolution happens in
   *  the caller's dependency graph (shared does not depend on gitnexus). */
  readonly fromModuleUrl: string
  readonly cwd?: string
  readonly allowHostHome?: boolean
  readonly stdio?: 'inherit' | 'pipe' | 'ignore'
  readonly signal?: AbortSignal
}

/**
 * Spawn `gitnexus <args...>` sandboxed. Returns the `ChildProcess` so the
 * caller can attach stdout/stderr listeners (we parse progress for UI events).
 */
export function runGitnexus(
  args: readonly string[],
  options: RunGitnexusOptions,
): ChildProcess {
  const {
    cwd,
    allowHostHome = false,
    stdio = 'pipe',
    signal,
    fromModuleUrl,
  } = options
  const { nodeBin, cliEntry } = resolveGitnexusCli(fromModuleUrl)
  return spawnSandboxed(nodeBin, [cliEntry, ...args], {
    cwd,
    allowHostHome,
    stdio,
    signal,
    sandbox: 'default',
  })
}

/** Run `gitnexus <args>` to completion, returning the exit code + captured stdio. */
export async function runGitnexusToCompletion(
  args: readonly string[],
  options: RunGitnexusOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = runGitnexus(args, { ...options, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ─── meta.json reader ────────────────────────────────────────────────────
//
// gitnexus writes `<sourceDir>/.gitnexus/meta.json` on every successful
// `analyze` pass. It is the single source of truth for "did this repo get
// indexed, and if so what did it find?" — we do NOT duplicate these counts
// into Postgres. Two callers consume it:
//
//   1. The worker's index-repo job — expects the file to exist post-analyze
//      and treats `null` as a bug (analyze exited 0 but wrote nothing).
//   2. Every backend repo-read endpoint — treats `null` as the normal
//      "not indexed yet / source tree wiped" state and renders nothing.
//
// The helper returns `null` for any read or parse failure and never throws,
// so List endpoints iterating over N repos can't have one bad meta.json
// blow up the whole response. Callers that need strict semantics
// (the worker) check the return value and throw locally.

const META_RELATIVE_PATH = ['.gitnexus', 'meta.json'] as const
const WIKI_RELATIVE_DIR = ['.gitnexus', 'wiki'] as const

/** Absolute path to the `meta.json` written by `gitnexus analyze` for a
 *  repo whose cloned source tree lives at `sourceDir`. */
export function repoMetaJsonPath(sourceDir: string): string {
  return path.join(sourceDir, ...META_RELATIVE_PATH)
}

/**
 * Absolute path to the wiki output directory written by `gitnexus wiki`.
 * Phase 2C plan note: gitnexus's `--storage-path` defaults to
 * `<sourceDir>/.gitnexus/`, and the wiki command always nests its output
 * under `<storagePath>/wiki/`. The original Plan.md said
 * `.agent-bridge-data/workspace/<agent>/<repo>/wiki/`, but per-agent doesn't
 * make sense for a repo-derived artifact and fights gitnexus's defaults —
 * we co-locate with `meta.json` instead.
 */
export function repoWikiDir(sourceDir: string): string {
  return path.join(sourceDir, ...WIKI_RELATIVE_DIR)
}

/** Absolute path to the wiki's bundled HTML viewer. Used by the backend's
 *  static-serve endpoint to short-circuit "does the wiki exist?" checks. */
export function repoWikiIndexHtmlPath(sourceDir: string): string {
  return path.join(repoWikiDir(sourceDir), 'index.html')
}

/**
 * Lazily read + parse `<sourceDir>/.gitnexus/meta.json` into a
 * `RepoIndexSummary`. Returns `null` if the file is missing, unreadable,
 * malformed, or doesn't carry the fields we care about. Never throws.
 *
 * This is the SINGLE place that knows meta.json's on-disk shape. If
 * gitnexus renames a field or adds a new stat, update here and every
 * caller (worker job, backend read path) picks it up in one commit.
 */
export async function readIndexSummary(
  sourceDir: string,
): Promise<RepoIndexSummary | null> {
  const metaPath = repoMetaJsonPath(sourceDir)

  let contents: string
  try {
    contents = await fs.readFile(metaPath, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const raw = parsed as Record<string, unknown>
  const indexedAt =
    typeof raw['indexedAt'] === 'string' ? raw['indexedAt'] : null
  if (!indexedAt) return null

  const lastCommitRaw = raw['lastCommit']
  const indexedCommitSha =
    typeof lastCommitRaw === 'string' && lastCommitRaw.length > 0
      ? lastCommitRaw
      : null

  const statsRaw = raw['stats']
  const stats =
    statsRaw && typeof statsRaw === 'object' && !Array.isArray(statsRaw)
      ? (statsRaw as Record<string, unknown>)
      : {}

  return {
    indexedAt,
    indexedCommitSha,
    files: pickInt(stats['files']),
    nodes: pickInt(stats['nodes']),
    edges: pickInt(stats['edges']),
    communities: pickInt(stats['communities']),
    processes: pickInt(stats['processes']),
    embeddings: pickInt(stats['embeddings']),
  }
}

function pickInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  return null
}

// ─── cypher (graph extraction) ───────────────────────────────────────────
//
// `gitnexus cypher <query>` exits with a JSON envelope of
// `{ markdown, row_count }` (or `{ error }` on a binder/runtime error).
// The `markdown` field carries a markdown table:
//
//   | h1 | h2 |
//   | --- | --- |
//   | r1c1 | r1c2 |
//   | r2c1 | r2c2 |
//
// gitnexus 1.6.3 has no `--format json` flag, so we parse the table
// here. Each call is cheap (one spawn) and we keep the pipeline scalar-
// only (`RETURN n.id, n.name`) so cell values never contain `|` and the
// parser stays a single-pass split.
//
// All graph queries land under `repoCypherRows()` so the extra spawn cost
// is paid once per query, not per request handler.

export interface CypherCellRow {
  readonly [columnHeader: string]: string
}

export interface CypherRunOptions extends RunGitnexusOptions {
  /** Source dir of the repo whose `.gitnexus/lbug` should answer the
   *  query. Used to gate on `meta.json` existence before the spawn. */
  readonly sourceDir: string
  /**
   * Registered repo name in the gitnexus registry — passed as
   * `gitnexus cypher -r <name>`. REQUIRED whenever the registry holds
   * more than one indexed repo, which is the steady-state for this
   * app. Use `repoDirName(descriptor)` from
   * `@agent-bridge/shared/paths` to get the same alias the analyze
   * pass registered.
   */
  readonly repoName: string
}

export interface CypherRunFailure {
  readonly ok: false
  /** Coarse classification: `not-indexed` if `meta.json` is missing
   *  (running cypher would error with a registry miss), `parse` if the
   *  output envelope was malformed, `query` if gitnexus returned an
   *  error envelope, `spawn` if the child failed to launch. */
  readonly reason: 'not-indexed' | 'parse' | 'query' | 'spawn'
  readonly message: string
}

export interface CypherRunSuccess {
  readonly ok: true
  readonly rows: readonly CypherCellRow[]
}

export type CypherRunResult = CypherRunSuccess | CypherRunFailure

/**
 * Run a single Cypher query against a repo's local Kuzu store and parse
 * the markdown-table envelope into row objects. Never throws — callers
 * fold the failure shape into a 503 / empty-graph response.
 *
 * Caveat: cells are parsed by literal `|` split, so any column whose
 * value embeds `|` will tear. This is fine for our usage (scalar id /
 * name returns) but is documented here so future query authors stay
 * inside that lane.
 */
export async function repoCypherRows(
  query: string,
  options: CypherRunOptions,
): Promise<CypherRunResult> {
  const { sourceDir, repoName, ...runOpts } = options
  const metaPath = repoMetaJsonPath(sourceDir)
  try {
    await fs.access(metaPath)
  } catch {
    return {
      ok: false,
      reason: 'not-indexed',
      message: 'meta.json missing; the repo has not been indexed yet',
    }
  }

  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runGitnexusToCompletion(
      ['cypher', '-r', repoName, query],
      {
        ...runOpts,
        cwd: sourceDir,
      },
    )
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (result.code !== 0) {
    return {
      ok: false,
      reason: 'query',
      message:
        `gitnexus cypher exited with code ${result.code}: ` +
        truncateForLog(result.stderr || result.stdout),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return {
      ok: false,
      reason: 'parse',
      message: `gitnexus cypher emitted non-JSON stdout: ${truncateForLog(result.stdout)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'parse', message: 'envelope is not an object' }
  }

  const env = parsed as Record<string, unknown>
  if (typeof env['error'] === 'string') {
    return { ok: false, reason: 'query', message: env['error'] }
  }

  const markdown = typeof env['markdown'] === 'string' ? env['markdown'] : null
  if (markdown === null) {
    return {
      ok: false,
      reason: 'parse',
      message: 'envelope missing markdown field',
    }
  }

  return { ok: true, rows: parseMarkdownTable(markdown) }
}

/**
 * Tolerant markdown-table → row-object parser. Recognises a standard
 * `| h |` header followed by a `| --- |` separator. Yields nothing for
 * empty / malformed input — callers are expected to handle a zero-row
 * success the same as a normal "no matches" result.
 */
function parseMarkdownTable(markdown: string): readonly CypherCellRow[] {
  const lines = markdown.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return []

  const headerLine = lines[0]
  const separatorLine = lines[1]
  if (!headerLine || !separatorLine) return []
  if (!/^\s*\|/.test(separatorLine) || !/-{3,}/.test(separatorLine)) return []

  const headers = splitMarkdownRow(headerLine)
  const rows: CypherCellRow[] = []
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const cells = splitMarkdownRow(line)
    const row: Record<string, string> = {}
    for (let h = 0; h < headers.length; h++) {
      row[headers[h] ?? `col_${h}`] = cells[h] ?? ''
    }
    rows.push(row)
  }
  return rows
}

function splitMarkdownRow(line: string): string[] {
  // Strip the leading + trailing pipe before splitting so we don't get
  // empty edge cells. Split, then trim each cell.
  const trimmed = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function truncateForLog(input: string, max = 240): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`
}
