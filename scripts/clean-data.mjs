#!/usr/bin/env node
// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

/**
 * Deletes the Agent Bridge data root (cloned repos, GitNexus knowledge graphs,
 * generated wikis, the secrets master key). Every persistent artifact the app
 * creates lives here, so this is the equivalent of a full factory reset for a
 * local install.
 *
 * Safety:
 *   - We only ever touch the *resolved* AGENT_BRIDGE_DATA_DIR (env override
 *     or `<repo>/.agent-bridge-data/`). Never `~`, never the workspace root.
 *   - We refuse to run if the target path equals `/`, `process.cwd()`, the
 *     resolved repo root, or the user's home directory.
 *   - Prompts for a typed `yes` unless `--force` is passed.
 *
 * Deliberately does NOT import @agent-bridge/shared — this must work on a
 * fresh checkout before any deps are installed or packages are built.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const envOverride = process.env.AGENT_BRIDGE_DATA_DIR?.trim()
const dataDir = envOverride
  ? path.resolve(envOverride)
  : path.join(repoRoot, '.agent-bridge-data')

function refuse(reason) {
  console.error(`[clean:data] refusing to delete: ${reason}`)
  process.exit(1)
}

const forbidden = new Set(
  [
    '/',
    path.resolve('/'),
    repoRoot,
    process.cwd(),
    process.env.HOME,
    process.env.USERPROFILE,
  ]
    .filter(Boolean)
    .map((p) => path.resolve(/** @type {string} */ (p))),
)

if (forbidden.has(dataDir)) {
  refuse(
    `${dataDir} is a forbidden path (repo root, cwd, or HOME). ` +
      `Set AGENT_BRIDGE_DATA_DIR to a dedicated subdirectory.`,
  )
}

if (!dataDir.includes(path.sep)) {
  refuse(`${dataDir} has no path separator — suspicious, aborting.`)
}

if (!fs.existsSync(dataDir)) {
  console.info(`[clean:data] ${dataDir} does not exist — nothing to do.`)
  process.exit(0)
}

const stat = fs.statSync(dataDir)
if (!stat.isDirectory()) {
  refuse(`${dataDir} is not a directory.`)
}

const force = process.argv.includes('--force')

async function confirm() {
  if (force) return true
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const ans = await new Promise((resolve) => {
    rl.question(
      `[clean:data] this will DELETE ${dataDir} (including your secrets key). type "yes" to proceed: `,
      resolve,
    )
  })
  rl.close()
  return String(ans).trim().toLowerCase() === 'yes'
}

;(async () => {
  const ok = await confirm()
  if (!ok) {
    console.info('[clean:data] aborted.')
    process.exit(1)
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.info(`[clean:data] removed ${dataDir}`)
})().catch((err) => {
  console.error('[clean:data] error:', err)
  process.exit(1)
})
