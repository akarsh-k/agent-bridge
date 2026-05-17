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

export const EXPECTED_GITNEXUS_VERSION = '1.6.5'

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

/**
 * Resolve the absolute path to the gitnexus npm package's `skills/`
 * directory. The package ships seven `.md` files there (declared in
 * its `files` array): `gitnexus-guide.md`, `gitnexus-cli.md`,
 * `gitnexus-exploring.md`, `gitnexus-debugging.md`,
 * `gitnexus-impact-analysis.md`, `gitnexus-refactoring.md`,
 * `gitnexus-pr-review.md`. These are LLM-targeted skill files with
 * YAML frontmatter and markdown bodies. Vendor content the inspector
 * toolkit auto-attaches to every inspector agent's instructions so the
 * model knows the right gitnexus tool-call shapes.
 *
 * Reading from the npm package (rather than from a per-repo
 * `.claude/skills/` copy) means the content is available before
 * any repo is indexed, version-locked to the gitnexus pin, and
 * always the source of truth.
 */
export function resolveGitnexusSkillsDir(fromModuleUrl: string): string {
  const req = createRequire(fromModuleUrl)
  let pkgPath: string
  try {
    pkgPath = req.resolve('gitnexus/package.json')
  } catch (err) {
    throw new Error(
      `[gitnexus] cannot resolve gitnexus from ${fromModuleUrl}. ` +
        `Original: ${(err as Error).message}`,
    )
  }
  return path.join(path.dirname(pkgPath), 'skills')
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
  /**
   * Extra env vars layered on top of the sandbox baseline
   * (`docs/ARCHITECTURE.md §10`). Used to forward `GITNEXUS_EMBEDDING_*` so gitnexus's
   * embedder routes to the workspace's chosen embedding provider instead
   * of the default local embedder. Caller is responsible for redacting
   * any secret env values from logs (the shared `RunRedactor` pattern).
   */
  readonly env?: Record<string, string>
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
    env,
  } = options
  const { nodeBin, cliEntry } = resolveGitnexusCli(fromModuleUrl)
  return spawnSandboxed(nodeBin, [cliEntry, ...args], {
    cwd,
    allowHostHome,
    stdio,
    signal,
    sandbox: 'default',
    ...(env ? { env } : {}),
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
 * Plan note: gitnexus's `--storage-path` defaults to
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
// We talk to the indexed Kuzu store the same way gitnexus serve does:
// by importing gitnexus's own `lbug-adapter` and calling `executeQuery`
// in-process. The `gitnexus cypher` CLI is *not* used here — its
// stdout-as-markdown-envelope contract has an unflushed-stdout race
// on large outputs (the child exits before its stdout drains; piped
// consumers lose bytes), and forcing every consumer to JSON-serialize
// every row through a markdown table is wasteful when we can read the
// real values straight from the DB.
//
// All graph queries land under `repoCypherRows()` so the gitnexus
// library lifecycle (resolve, dynamic-import, `withLbugDb` retry) is
// paid once per query, not per request handler.

export interface CypherCellRow {
  /** Native row shape from `executeQuery` — values arrive as their
   *  natural JS types (strings, numbers, booleans). Callers coerce
   *  via the local `parseIntOrNull` / `nonEmptyOrNull` helpers. */
  readonly [columnHeader: string]: unknown
}

export interface CypherRunOptions {
  /** Path to the repo's source dir. The Kuzu store lives at
   *  `<sourceDir>/.gitnexus/lbug`. */
  readonly sourceDir: string
  /** REQUIRED. The caller's `import.meta.url` — passed to
   *  `createRequire` so the gitnexus library is resolved from the
   *  caller's dependency tree (shared itself doesn't declare
   *  gitnexus). */
  readonly fromModuleUrl: string
}

export interface CypherRunFailure {
  readonly ok: false
  /** Coarse classification: `not-indexed` if `meta.json` is missing,
   *  `query` if gitnexus's executeQuery threw, `spawn` kept for
   *  back-compat (no longer used). */
  readonly reason: 'not-indexed' | 'parse' | 'query' | 'spawn'
  readonly message: string
}

export interface CypherRunSuccess {
  readonly ok: true
  readonly rows: readonly CypherCellRow[]
}

export type CypherRunResult = CypherRunSuccess | CypherRunFailure

/** Cached gitnexus library handle. The library is shared across
 *  every call within this Node process; switching between repos
 *  goes through `withLbugDb(dbPath, ...)` which transparently
 *  re-initialises the singleton DB connection. */
interface GitnexusLib {
  executeQuery: (cypher: string) => Promise<unknown[]>
  withLbugDb: <T>(dbPath: string, op: () => Promise<T>) => Promise<T>
}
let cachedLib: GitnexusLib | null = null
let cachedLibFromUrl: string | null = null

async function loadGitnexusLib(fromModuleUrl: string): Promise<GitnexusLib> {
  if (cachedLib && cachedLibFromUrl === fromModuleUrl) return cachedLib
  const req = createRequire(fromModuleUrl)
  // Resolve via the caller's dep tree, then import the resolved file
  // URL so Node ESM honours the package's own internal imports.
  const adapterPath = req.resolve(
    'gitnexus/dist/core/lbug/lbug-adapter.js',
  )
  const mod = (await import(new URL(`file://${adapterPath}`).toString())) as {
    executeQuery: GitnexusLib['executeQuery']
    withLbugDb: GitnexusLib['withLbugDb']
  }
  cachedLib = { executeQuery: mod.executeQuery, withLbugDb: mod.withLbugDb }
  cachedLibFromUrl = fromModuleUrl
  return cachedLib
}

/**
 * Run a Cypher query against a repo's local Kuzu store. Returns rows
 * as native JS objects (strings, numbers, etc — same shape gitnexus
 * serve produces). Never throws; callers fold the failure shape into
 * a 503 / empty-graph response.
 */
export async function repoCypherRows(
  query: string,
  options: CypherRunOptions,
): Promise<CypherRunResult> {
  const { sourceDir, fromModuleUrl } = options
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

  let lib: GitnexusLib
  try {
    lib = await loadGitnexusLib(fromModuleUrl)
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn',
      message: `failed to load gitnexus library: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const dbPath = path.join(sourceDir, '.gitnexus', 'lbug')
  try {
    const rows = await lib.withLbugDb(dbPath, () => lib.executeQuery(query))
    // Normalise to a readonly array of cell-row objects. gitnexus
    // returns plain objects; the cast is just to honour the
    // declared `unknown` cell type.
    return {
      ok: true,
      rows: rows as readonly CypherCellRow[],
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'query',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

