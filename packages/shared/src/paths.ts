import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every persistent, user-writable artifact Agent Bridge creates lives under a
 * single data root. Uninstall = `rm -rf` that one folder. Nothing leaks to
 * `~/.gitnexus/`, `~/.gitconfig`, the user's other repos, or anywhere else on
 * the machine.
 *
 * This module is Node-only.
 */

const ENV_VAR = 'AGENT_BRIDGE_DATA_DIR'
const DEFAULT_DIR_NAME = '.agent-bridge-data'

/** Resolve the absolute data root. Does not create it — use `ensureDataDirs()`. */
export function resolveDataDir(): string {
  const fromEnv = process.env[ENV_VAR]?.trim()
  if (fromEnv) return path.resolve(fromEnv)

  const repoRoot = findRepoRoot()
  if (repoRoot) return path.join(repoRoot, DEFAULT_DIR_NAME)

  return path.join(os.homedir(), DEFAULT_DIR_NAME)
}

export interface DataDirs {
  readonly dataDir: string
  readonly workspaceDir: string
  readonly gitnexusHomeDir: string
  readonly blobsDir: string
  readonly reposDir: string
  readonly secretKeyPath: string
}

/**
 * Ensure all data subdirectories exist with strict 0o700 perms, then return
 * their absolute paths. Safe to call repeatedly.
 */
export function ensureDataDirs(): DataDirs {
  const dataDir = resolveDataDir()
  const workspaceDir = path.join(dataDir, 'workspace')
  const gitnexusHomeDir = path.join(dataDir, 'gitnexus-home')
  const blobsDir = path.join(dataDir, 'blobs')
  const reposDir = path.join(dataDir, 'repos')
  const secretKeyPath = path.join(dataDir, 'secret.key')

  for (const dir of [dataDir, workspaceDir, gitnexusHomeDir, blobsDir, reposDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  try {
    fs.chmodSync(dataDir, 0o700)
  } catch {
    // Best-effort on platforms where chmod semantics differ (e.g. Windows).
  }

  return {
    dataDir,
    workspaceDir,
    gitnexusHomeDir,
    blobsDir,
    reposDir,
    secretKeyPath,
  }
}

// ─── Per-repo layout ─────────────────────────────────────────────────────
//
// `<dataDir>/repos/<slug>__<shortId>/` holds everything tied to a single
// deduped repo row from the database. The slug is `<owner>__<repo>__<branch>`
// derived from the remote URL + branch, sanitised for filesystem-safety.
// The 8-char UUID suffix keeps names unique when two repos slug-collide
// (e.g. two branches of the same repo, or two owners with the same repo
// name that also share a branch), while the slug prefix makes the directory
// glanceable from `ls` or Finder — no more "what the hell is c38e70cd?".
//
// The short UUID is the identity, the slug is decorative. Callers should
// always route through these helpers so nothing hardcodes the format;
// if we ever change the slugging rules, only `repoDirName` changes and
// every caller follows.
//
// Subdirs (created on demand by callers, not `ensureDataDirs`):
//   - `source/`      — the final clone. Readable once `repos.status='cloned'`.
//   - `source.tmp/`  — in-progress clone destination; atomically renamed
//                      onto `source/` on git-exit=0. Never observable as
//                      a partial `source/`.
//   - `index/`       — GitNexus analyze output.
//   - `wiki/`        — GitNexus wiki output.

/**
 * Minimal shape the path helpers need. Accepts a full `RepoResponse` row
 * (via structural subtyping) or a hand-built literal at call sites that
 * already have the three fields without loading the whole row.
 */
export interface RepoDirDescriptor {
  readonly id: string
  readonly remoteUrl: string
  readonly branch: string
}

/**
 * Directory name for a single repo: `<owner>__<repo>__<branch>__<shortId>`.
 *
 * - Slug parts are sanitised to `[A-Za-z0-9._-]`. `/` in branch names (e.g.
 *   `feat/foo`) becomes `-`, so a branch like `release/v1` slugs to `release-v1`.
 * - The 8-char hex UUID suffix is carved from the first four bytes of the
 *   UUID. Collision probability between two repo rows with identical slugs
 *   is ~1 in 4 billion; good enough for a local-first tool.
 * - Falls back to `repo__<shortId>` if the slug ends up empty (weird URLs,
 *   empty branches post-sanitisation, etc.). That path is still valid, just
 *   ugly.
 */
export function repoDirName(descriptor: RepoDirDescriptor): string {
  const { owner, repo } = parseOwnerRepo(descriptor.remoteUrl)
  const parts = [owner, repo, descriptor.branch]
    .map(slugifyForPath)
    .filter((s) => s.length > 0)
  const shortId = descriptor.id.replace(/-/g, '').slice(0, 8)
  return parts.length > 0 ? `${parts.join('__')}__${shortId}` : `repo__${shortId}`
}

/** Absolute path to `<dataDir>/repos/<slug>__<shortId>/` (never auto-created). */
export function repoRootDir(descriptor: RepoDirDescriptor): string {
  const { reposDir } = ensureDataDirs()
  return path.join(reposDir, repoDirName(descriptor))
}

/** Absolute path to the completed clone directory for a given repo. */
export function repoSourceDir(descriptor: RepoDirDescriptor): string {
  return path.join(repoRootDir(descriptor), 'source')
}

/** Absolute path to the in-progress clone staging directory. */
export function repoTmpDir(descriptor: RepoDirDescriptor): string {
  return path.join(repoRootDir(descriptor), 'source.tmp')
}

/**
 * Trim `[A-Za-z0-9._-]` out of a single slug segment. Intentionally not
 * lowercasing — `Hello-World` reads better than `hello-world` in `ls`.
 * Caps each part at 40 chars so a pathological branch name can't generate
 * a filesystem-hostile directory name.
 */
function slugifyForPath(input: string): string {
  return input
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
}

/**
 * Extract `{owner, repo}` from a remote URL. Handles HTTPS
 * (`https://host/owner/repo[.git]`) and SSH (`git@host:owner/repo[.git]`).
 * Falls back to empty strings for anything we can't parse — the caller's
 * `.filter((s) => s.length > 0)` drops those.
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
  const clean = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  // SSH style: user@host:owner/repo
  const sshMatch = clean.match(/^[^\s@/]+@[^\s:/]+:(.+)$/)
  const pathPart = sshMatch
    ? (sshMatch[1] ?? '')
    : clean.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\/?/, '')
  const segments = pathPart.split('/').filter((s) => s.length > 0)
  const owner = segments.length >= 2 ? (segments[segments.length - 2] ?? '') : ''
  const repo = segments[segments.length - 1] ?? ''
  return { owner, repo }
}

/**
 * Walk up from the caller's position (or this file's position) looking for a
 * repo root marker (`pnpm-workspace.yaml` is our canonical marker). Falls back
 * to `null` when we can't find one — e.g. running from a global install.
 */
function findRepoRoot(startFrom?: string): string | null {
  const start = startFrom ?? path.dirname(fileURLToPath(import.meta.url))
  let cursor = start
  const { root } = path.parse(cursor)

  while (cursor !== root) {
    if (fs.existsSync(path.join(cursor, 'pnpm-workspace.yaml'))) {
      return cursor
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return null
}
