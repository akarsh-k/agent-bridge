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
  const secretKeyPath = path.join(dataDir, 'secret.key')

  for (const dir of [dataDir, workspaceDir, gitnexusHomeDir, blobsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  try {
    fs.chmodSync(dataDir, 0o700)
  } catch {
    // Best-effort on platforms where chmod semantics differ (e.g. Windows).
  }

  return { dataDir, workspaceDir, gitnexusHomeDir, blobsDir, secretKeyPath }
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
