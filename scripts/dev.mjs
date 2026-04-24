#!/usr/bin/env node
/**
 * Local dev: preflight → build shared packages once → docker compose up -d
 *          → pnpm workspace dev servers (shared's tsc --watch runs in parallel).
 *
 * Checks only:  node scripts/dev.mjs --preflight-only   (or pnpm preflight)
 *
 * SKIP_PREFLIGHT=1        — skip Node / .env / node_modules checks
 * SKIP_DOCKER=1           — skip `docker compose up -d`
 * SKIP_SHARED_BUILD=1     — skip pre-building `packages/*` (use only if dist
 *                           already exists; otherwise app servers will fail
 *                           to resolve shared packages).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const preflightOnly = process.argv.includes('--preflight-only')

function versionGte(actual, expected) {
  const a = actual.split('.').map((n) => Number(n) || 0)
  const e = expected.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0
    const ei = e[i] ?? 0
    if (ai > ei) return true
    if (ai < ei) return false
  }
  return true
}

function runPreflight() {
  if (process.env.SKIP_PREFLIGHT === '1') {
    console.info('[preflight] skipped (SKIP_PREFLIGHT=1)')
    return { ok: true, skipped: true }
  }

  const nvmrcPath = path.join(repoRoot, '.nvmrc')
  if (!fs.existsSync(nvmrcPath)) {
    return { ok: false, message: 'Missing .nvmrc at repo root.' }
  }

  const nvmrcRaw = fs.readFileSync(nvmrcPath, 'utf8').trim()
  const expectedNode = nvmrcRaw.replace(/^v/i, '')
  const actualNode = process.version.replace(/^v/, '')

  if (!/^\d+\.\d+\.\d+/.test(expectedNode)) {
    return {
      ok: false,
      message: `Invalid .nvmrc value: ${JSON.stringify(nvmrcRaw)}`,
    }
  }

  if (!versionGte(actualNode, expectedNode)) {
    return {
      ok: false,
      message: `Node ${process.version} is below .nvmrc v${expectedNode}. Use the pinned toolchain, e.g.:\n  nvm use`,
    }
  }

  const envPath = path.join(repoRoot, '.env')
  if (!fs.existsSync(envPath)) {
    return {
      ok: false,
      message:
        'Missing root .env (backend and Compose expect it).\n  cp .env.example .env\nThen set secrets for your environment.',
    }
  }

  if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    return {
      ok: false,
      message: 'Root node_modules missing. Run:\n  pnpm install',
    }
  }

  const workspaceFile = path.join(repoRoot, 'pnpm-workspace.yaml')
  if (!fs.existsSync(workspaceFile)) {
    return { ok: false, message: 'Missing pnpm-workspace.yaml.' }
  }

  const requiredPackages = ['apps/backend', 'apps/frontend']
  const packagesDir = path.join(repoRoot, 'packages')
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir)) {
      const full = path.join(packagesDir, entry)
      if (fs.statSync(full).isDirectory()) {
        requiredPackages.push(path.join('packages', entry))
      }
    }
  }

  for (const pkg of requiredPackages) {
    const dir = path.join(repoRoot, pkg)
    if (!fs.existsSync(dir)) {
      return { ok: false, message: `Missing workspace package: ${pkg}/` }
    }
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      return {
        ok: false,
        message: `Missing node_modules in ${pkg}/. Run from repo root:\n  pnpm install`,
      }
    }
  }

  return { ok: true, skipped: false, expectedNode }
}

if (preflightOnly) {
  const result = runPreflight()
  if (!result.ok) {
    console.error(`[preflight] ${result.message}`)
    process.exit(1)
  }
  if (result.skipped) {
    process.exit(0)
  }
  console.info(
    `[preflight] OK — Node ${process.version} (≥ v${result.expectedNode}), .env present`,
  )
  process.exit(0)
}

function run(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

/**
 * Try `docker info` to tell whether the daemon is reachable. Used to write a
 * useful error message when `docker compose up -d` fails — daemon-down vs
 * some other reason (port clash, bad compose file, image pull error) need
 * different fixes.
 */
function dockerDaemonReachable() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

const pre = runPreflight()
if (!pre.ok) {
  console.error(`[dev] ${pre.message}`)
  process.exit(1)
}
if (!pre.skipped) {
  console.info(
    `[dev] preflight OK — Node ${process.version} (≥ v${pre.expectedNode})`,
  )
}

if (process.env.SKIP_SHARED_BUILD !== '1') {
  const packagesDir = path.join(repoRoot, 'packages')
  if (fs.existsSync(packagesDir) && fs.readdirSync(packagesDir).length > 0) {
    try {
      console.info('[dev] pnpm --filter "./packages/*" run build  (once)')
      await run(
        'pnpm',
        ['--filter', './packages/*', 'run', '--if-present', 'build'],
        { cwd: repoRoot },
      )
    } catch (err) {
      console.error(
        '[dev] Failed to build shared packages. Fix the errors above, or run with SKIP_SHARED_BUILD=1 once dist/ exists.\n',
        err instanceof Error ? err.message : err,
      )
      process.exit(1)
    }
  }
} else {
  console.info('[dev] SKIP_SHARED_BUILD=1 — not building packages/*')
}

if (process.env.SKIP_DOCKER !== '1') {
  try {
    console.info('[dev] docker compose up -d')
    await run('docker', ['compose', 'up', '-d'], { cwd: repoRoot })
  } catch (err) {
    const daemonOk = await dockerDaemonReachable()
    if (!daemonOk) {
      console.error(
        '[dev] Docker daemon is not reachable. Start Docker Desktop / dockerd, or run with SKIP_DOCKER=1.\n',
        err instanceof Error ? err.message : err,
      )
    } else {
      console.error(
        '[dev] docker compose up failed (daemon is running).',
        '\n       Common causes:',
        '\n         - host port already in use (another postgres/redis or container). Check:',
        '\n             lsof -nP -iTCP:5432 -sTCP:LISTEN',
        '\n             docker ps --format "table {{.Names}}\\t{{.Ports}}"',
        '\n           Fix: `pnpm stop`, or override POSTGRES_PORT / REDIS_PORT in .env.',
        '\n         - image pull blocked (network / auth). Retry, or pre-pull manually.',
        '\n         - corrupt volume. Last resort: `pnpm stop:clean` (destroys local DB data).',
        '\n',
        err instanceof Error ? err.message : err,
      )
    }
    process.exit(1)
  }
} else {
  console.info('[dev] SKIP_DOCKER=1 — not running docker compose')
}

console.info('[dev] pnpm -r --parallel run dev')
const dev = spawn('pnpm', ['-r', '--parallel', 'run', 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

dev.on('error', (err) => {
  console.error('[dev] could not start pnpm:', err)
  process.exit(1)
})

dev.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})

// Forward Ctrl+C / SIGTERM to the workspace dev loop. The orchestrator waits
// for the child to exit via `dev.on('exit')` above, so callers get the real
// exit code instead of Node's default "exit immediately on SIGINT" behavior
// (which would orphan the pnpm child).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    dev.kill(sig)
  })
}
