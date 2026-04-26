import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSandboxed } from './spawn.js'
import type { ChildProcess } from 'node:child_process'

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
