/**
 * Build-stamp helper: resolves `{ version, commit }` for the running
 * Agent Bridge install. Backend + worker call this at boot to log
 * which version they're on; the backend also exposes it via
 * `GET /api/system/version` so the frontend and bug reports can
 * reference the same identifier.
 *
 * Resolution strategy (no codegen, no build step):
 *
 *   1. `version` reads the repo-root `package.json` at module load.
 *      For a source-distro install, that's the canonical version
 *      the operator pulled.
 *   2. `commit` shells `git rev-parse --short HEAD` against the
 *      repo root. If git is missing or the directory isn't a repo
 *      (e.g. a future tarball install), the field falls back to
 *      `'unknown'` — version is still meaningful on its own.
 *
 * Cached after the first call so we don't re-spawn `git` on every
 * `/api/system/version` poll.
 *
 * **Node-only.** This module imports `fs` and `child_process`, so it
 * must NOT be re-exported from `@agent-bridge/shared`'s root entry —
 * the browser bundle would crash on `node:child_process`. Consume via
 * the `@agent-bridge/shared/version` subpath export instead.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AgentBridgeVersion {
  /** SemVer string from the repo-root `package.json`. */
  readonly version: string
  /** Short SHA of `HEAD`, or `'unknown'` when git isn't available. */
  readonly commit: string
}

let cached: AgentBridgeVersion | null = null

export function getAgentBridgeVersion(): AgentBridgeVersion {
  if (cached) return cached

  let version = '0.0.0-unknown'
  let commit = 'unknown'

  // This module compiles to one of:
  //   - packages/shared/src/version.ts   (tsx-dev path)
  //   - packages/shared/dist/version.js  (built path)
  // Both live three levels under the repo root, so the same walk
  // works either way.
  try {
    const here = fileURLToPath(import.meta.url)
    const repoRoot = path.resolve(path.dirname(here), '..', '..', '..')
    try {
      const pkgRaw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgRaw) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        version = pkg.version
      }
    } catch {
      // package.json missing or unreadable — keep the default.
    }
    try {
      commit = execSync('git rev-parse --short HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (commit.length === 0) commit = 'unknown'
    } catch {
      // Not a git repo / git not installed — leave as 'unknown'.
    }
  } catch {
    // `import.meta.url` resolution failed (extremely unusual). Keep
    // defaults.
  }

  cached = { version, commit }
  return cached
}
