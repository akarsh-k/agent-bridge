#!/usr/bin/env node
// @ts-check
/**
 * Production start: preflight → pnpm install → pnpm build →
 *               docker compose up -d → spawn backend + worker.
 *
 * Unlike `pnpm dev` (tsx watch, vite HMR, parallel watchers), this
 * boots from compiled JS so users running Agent Bridge get stable
 * processes without filesystem watchers wasting CPU. The frontend is
 * served by the backend (`apps/backend/src/app.ts` mounts
 * `hono/serve-static` in production), so there's one URL to open:
 * http://localhost:$PORT (default 3001).
 *
 * Why we always run install + build (no drift detection):
 *   The previous design tried to skip install/build when nothing had
 *   changed via mtime checks against `pnpm-lock.yaml`, `.git/HEAD`,
 *   `.env`, and the dist artifacts. Each shortcut produced its own
 *   footgun: lockfile precision quirks, source edits that didn't
 *   bump HEAD, `.env` edits that invalidated the bundle. The
 *   incremental cost of always running them is ~1-2s for `pnpm
 *   install` (no-op when fresh) + ~5-10s for `pnpm build` (tsc -b is
 *   incremental; vite isn't but is fast). Acceptable for a workflow
 *   where users start the app once a session — `pnpm dev` exists for
 *   the inner-loop case where the latency would actually matter.
 *   Escape hatches: `SKIP_INSTALL=1`, `SKIP_BUILD=1` for users who
 *   know their state and want the fast path.
 *
 * Boot order matters and is deliberate:
 *   1. Preflight (Node version, .env, install).
 *   2. Docker install probe (so failures here surface before we burn
 *      10s on a build).
 *   3. `pnpm install` — picks up any new deps from a `git pull`.
 *   4. `pnpm build` — picks up any new source / `.env` changes.
 *   5. Docker compose for Postgres + Redis.
 *   6. Spawn backend — its `server.ts` runs `runMigrations` BEFORE
 *      accepting traffic, so the DB is current before the worker
 *      could possibly enqueue a job against a stale schema.
 *   7. Spawn worker once backend is healthy.
 *
 * Updates:
 *   git pull
 *   pnpm start          # install + build + boot, all auto-applied
 *
 * Env overrides:
 *   SKIP_PREFLIGHT=1      — skip Node / .env / node_modules checks
 *   SKIP_DOCKER=1         — skip Docker install probe AND `docker compose up -d`
 *   SKIP_INSTALL=1        — skip `pnpm install` (caller asserts it's fresh)
 *   SKIP_BUILD=1          — skip `pnpm build` (caller asserts dist is current);
 *                           still fails fast if any required dist file is missing
 *
 * Flags:
 *   --check               — run preflight + Docker install probe and exit 0,
 *                           without booting. Useful for verifying a fresh
 *                           clone is ready to run.
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

/**
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function versionGte(actual, expected) {
  const a = actual.split('.').map((/** @type {string} */ n) => Number(n) || 0)
  const e = expected.split('.').map((/** @type {string} */ n) => Number(n) || 0)
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
  if (fs.existsSync(nvmrcPath)) {
    const expectedNode = fs.readFileSync(nvmrcPath, 'utf8').trim().replace(/^v/i, '')
    if (/^\d+\.\d+\.\d+/.test(expectedNode)) {
      const actualNode = process.version.replace(/^v/, '')
      if (!versionGte(actualNode, expectedNode)) {
        return {
          ok: false,
          message: `Node ${process.version} is below .nvmrc v${expectedNode}. Use the pinned toolchain, e.g.:\n  nvm use`,
        }
      }
    }
  }

  if (!fs.existsSync(path.join(repoRoot, '.env'))) {
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

  return { ok: true, skipped: false }
}

/**
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {Promise<void>}
 */
function run(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    child.on('error', reject)
    child.on('close', (/** @type {number | null} */ code) => {
      if (code === 0) resolve()
      else
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

/** @returns {Promise<boolean>} */
function dockerDaemonReachable() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.on('error', () => resolve(false))
    child.on('close', (/** @type {number | null} */ code) => resolve(code === 0))
  })
}

/**
 * Run `cmd <args>` and report whether the binary exists. We don't
 * care about exit code here — only about whether the OS could spawn
 * it at all (`ENOENT` means the binary isn't in `PATH`).
 *
 * Used by the upfront Docker checks below so a user without Docker
 * installed gets "Docker isn't installed" instead of the misleading
 * "daemon not reachable" message that `docker info` failures
 * currently produce.
 */
/**
 * @param {string} cmd
 * @param {readonly string[]} args
 * @returns {Promise<boolean>}
 */
function commandAvailable(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.on('error', () => resolve(false))
    child.on('close', (/** @type {number | null} */ code) => resolve(code === 0))
  })
}

async function checkDockerInstall() {
  if (process.env.SKIP_DOCKER === '1') {
    console.info('[start] SKIP_DOCKER=1 — skipping Docker install probe')
    return { ok: true, skipped: true }
  }
  const dockerCli = await commandAvailable('docker', ['--version'])
  if (!dockerCli) {
    return {
      ok: false,
      message:
        'Docker is not installed (or `docker` is not on PATH).\n' +
        '  Install Docker Desktop (Mac/Windows): https://docs.docker.com/get-docker/\n' +
        '  Linux: install Docker Engine + the Compose plugin via your distro\'s package manager.\n' +
        '  If you already have Docker installed elsewhere, ensure PATH includes its `bin/`.\n' +
        '  Or run with SKIP_DOCKER=1 to skip — Postgres + Redis must then be running yourself.',
    }
  }
  const composeV2 = await commandAvailable('docker', ['compose', 'version'])
  if (!composeV2) {
    return {
      ok: false,
      message:
        'Docker is installed but the Compose v2 plugin is missing.\n' +
        '  We use `docker compose` (space), not the legacy `docker-compose` (hyphen).\n' +
        '  Upgrade Docker Desktop to a recent build (Compose v2 is bundled), or on Linux:\n' +
        '    sudo apt-get install docker-compose-plugin\n' +
        '  Or run with SKIP_DOCKER=1 to skip — Postgres + Redis must then be running yourself.',
    }
  }
  return { ok: true, skipped: false }
}

/**
 * Required dist artifacts checked when SKIP_BUILD=1 is set. With
 * SKIP_BUILD off we always rebuild, so this list is purely a
 * "fail-fast guard" for the explicit-skip path: if the user said
 * "trust me, dist is fine" but a critical file is missing, we'd
 * rather fail loudly here than crash a child with
 * `ERR_MODULE_NOT_FOUND` two seconds after spawn.
 *
 * Order doesn't matter; we report the first miss.
 */
const requiredDists = [
  'apps/backend/dist/server.js',
  'apps/worker/dist/index.js',
  'apps/frontend/dist/index.html',
  // mcp-bridge: the bridge config endpoint emits an absolute path to
  // `apps/mcp-bridge/dist/index.js`; the IDE spawns node against that
  // file, so a missing dist would silently break the IDE-side install.
  'apps/mcp-bridge/dist/index.js',
  // Workspace packages — apps resolve `@agent-bridge/{shared,db,agents}`
  // through pnpm-symlinked node_modules pointing at `packages/*/dist/`
  // in production. A missing package dist surfaces as
  // `ERR_MODULE_NOT_FOUND` only at first-request time, not at spawn.
  'packages/shared/dist/index.js',
  'packages/db/dist/index.js',
  // agents has rootDir: "." + scripts/**/*.ts in include, so tsc emits
  // to dist/src/. Don't "fix" without realigning the tsconfig — see
  // packages/agents/package.json.
  'packages/agents/dist/src/index.js',
]

function firstMissingDist() {
  for (const rel of requiredDists) {
    if (!fs.existsSync(path.join(repoRoot, rel))) return rel
  }
  return null
}

const pre = runPreflight()
if (!pre.ok) {
  console.error(`[start] ${pre.message}`)
  process.exit(1)
}
if (!pre.skipped) {
  console.info(`[start] preflight OK — Node ${process.version}`)
}

// Docker checks live separately because they're slower (process spawns)
// and we want the cheap Node / .env / install checks to fail first when
// they'd fail anyway.
const docker = await checkDockerInstall()
if (!docker.ok) {
  console.error(`[start] ${docker.message}`)
  process.exit(1)
}
if (!docker.skipped) {
  console.info('[start] docker + compose v2 detected')
}

// Stop-after-checks mode: `pnpm start --check` runs preflight + the
// Docker probes and exits without booting. Useful for sanity-checking
// a fresh install without spinning up containers and Node processes.
if (process.argv.includes('--check')) {
  console.info('[start] --check passed; not starting the app')
  process.exit(0)
}

// Always install. pnpm install is idempotent and fast (~1-2s no-op);
// catches dep-bump-after-git-pull without us having to compare lockfile
// mtimes. SKIP_INSTALL=1 for the "I know my state is fresh" escape.
if (process.env.SKIP_INSTALL === '1') {
  console.info('[start] SKIP_INSTALL=1 — skipping pnpm install')
} else {
  console.info('[start] pnpm install')
  try {
    await run('pnpm', ['install'], { cwd: repoRoot })
  } catch (err) {
    console.error(
      '[start] pnpm install failed. Fix the errors above, then re-run pnpm start.\n' +
        '        (Set SKIP_INSTALL=1 to bypass on the next run if you know your install is fresh.)\n',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  }
}

// Always build. tsc -b is incremental (fast no-op when sources are
// unchanged); vite isn't incremental but completes in ~5s on our
// frontend. Both pick up `.env` / source changes automatically — no
// drift detection needed. SKIP_BUILD=1 still requires every entry in
// `requiredDists` to exist (we'd rather fail here than crash a child).
if (process.env.SKIP_BUILD === '1') {
  const missing = firstMissingDist()
  if (missing) {
    console.error(
      `[start] SKIP_BUILD=1 is set but ${missing} is missing.\n` +
        '        Run: pnpm build',
    )
    process.exit(1)
  }
  console.info('[start] SKIP_BUILD=1 — skipping pnpm build')
} else {
  console.info('[start] pnpm build')
  try {
    // NODE_ENV=production is REQUIRED here, not optional. Vite (v8)
    // sets `import.meta.env.PROD` from `process.env.NODE_ENV === 'production'`,
    // not from the `--mode` flag. Without this override, Vite's build
    // log still says "building client environment for production"
    // (which refers to MODE), but the bundle's `import.meta.env.PROD`
    // resolves to `false`. Result: any code path keyed on PROD picks
    // the dev branch — most notably the frontend's `resolveBaseUrl`,
    // which would then bake the dev-default absolute URL into every
    // fetch (CORS-blocked when the page is opened at a different
    // hostname than the API). NODE_ENV may be 'development' in the
    // user's `.env`; we deliberately do NOT inherit that here.
    await run('pnpm', ['-r', 'run', 'build'], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'production' },
    })
  } catch (err) {
    console.error(
      '[start] build failed. Fix the errors above, then re-run pnpm start.\n',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  }
}

if (process.env.SKIP_DOCKER !== '1') {
  try {
    console.info('[start] docker compose up -d')
    await run('docker', ['compose', 'up', '-d'], { cwd: repoRoot })
  } catch (err) {
    const daemonOk = await dockerDaemonReachable()
    if (!daemonOk) {
      console.error(
        '[start] Docker daemon is not reachable. Start Docker Desktop / dockerd, or run with SKIP_DOCKER=1.\n',
        err instanceof Error ? err.message : err,
      )
    } else {
      console.error(
        '[start] docker compose up failed (daemon is running).',
        '\n       Common causes:',
        '\n         - host port already in use (another postgres/redis or container).',
        '\n             lsof -nP -iTCP:5432 -sTCP:LISTEN',
        '\n         - image pull blocked. Retry or pre-pull manually.',
        '\n',
        err instanceof Error ? err.message : err,
      )
    }
    process.exit(1)
  }
} else {
  console.info('[start] SKIP_DOCKER=1 — not running docker compose')
}

// Spawn backend and worker with NODE_ENV=production so each one's own
// `isProd` branch (migrate-on-boot, serve-static, request-logger off)
// fires. Backend goes first so its migration applies before the worker
// has a chance to dequeue against a stale schema; we don't gate on a
// healthcheck because Drizzle's migrate path serialises through the
// migrations table — a worker boot racing the backend will observe
// the same writes the moment it tries to run.
const env = { ...process.env, NODE_ENV: 'production' }

console.info('[start] spawning backend (node apps/backend/dist/server.js)')
const backend = spawn(
  process.execPath,
  ['apps/backend/dist/server.js'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    shell: false,
  },
)

console.info('[start] spawning worker (node apps/worker/dist/index.js)')
const worker = spawn(
  process.execPath,
  ['apps/worker/dist/index.js'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    shell: false,
  },
)

const children = [
  { name: 'backend', proc: backend },
  { name: 'worker', proc: worker },
]

let shuttingDown = false
/** @param {NodeJS.Signals} signal */
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`\n[start] ${signal} received — forwarding to children`)
  for (const { proc } of children) {
    if (!proc.killed) proc.kill(signal)
  }
  // If any child hasn't exited in 12s, force exit. The ref()/unref()
  // dance: setTimeout returns NodeJS.Timeout in node, which has
  // .unref(); the DOM-typed `number` return doesn't. Cast through
  // unknown so the JSDoc-only type-check is happy without us pulling
  // in DOM lib.
  const forceTimer = /** @type {NodeJS.Timeout} */ (
    /** @type {unknown} */ (
      setTimeout(() => {
        console.error('[start] children did not exit in time — forcing exit')
        process.exit(1)
      }, 12_000)
    )
  )
  forceTimer.unref()
}

/** @type {readonly NodeJS.Signals[]} */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM']
for (const sig of SHUTDOWN_SIGNALS) {
  process.on(sig, () => shutdown(sig))
}

let exitCode = 0
let exited = 0
for (const { name, proc } of children) {
  proc.on('error', (/** @type {Error} */ err) => {
    console.error(`[start] ${name} could not start:`, err)
    exitCode = 1
    shutdown('SIGTERM')
  })
  proc.on(
    'exit',
    (
      /** @type {number | null} */ code,
      /** @type {NodeJS.Signals | null} */ signal,
    ) => {
      exited += 1
      const reason = signal ? `signal ${signal}` : `code ${code ?? '?'}`
      if (!shuttingDown) {
        console.error(`[start] ${name} exited unexpectedly (${reason})`)
        exitCode = code ?? 1
        shutdown('SIGTERM')
      } else {
        console.info(`[start] ${name} exited (${reason})`)
      }
      if (exited === children.length) {
        process.exit(exitCode)
      }
    },
  )
}
