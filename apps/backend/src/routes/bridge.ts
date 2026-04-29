/**
 * `GET /api/bridge/config` — paste-ready MCP server config block.
 *
 * Phase 5b. The IDE (Cursor / Claude Code / etc.) needs a JSON shape it
 * can drop straight into its `mcpServers` config. Hand-crafting the
 * absolute path to `apps/mcp-bridge` is annoying and error-prone — this
 * endpoint resolves it from the running backend's filesystem so the
 * operator just copies and pastes.
 *
 * **PATH-independence (critical).** Desktop IDEs spawn the bridge with
 * a minimal `PATH` (often just `/usr/bin:/bin`), so naïvely emitting
 * `command: "tsx"` fails with `spawn tsx ENOENT` even though `tsx`
 * works fine from a normal shell. We resolve everything to **absolute
 * paths** so the IDE never has to look anything up:
 *   - `command` = `process.execPath` (absolute node binary).
 *   - `args[0]` = absolute path to `tsx/dist/cli.mjs` (dev) OR the
 *     compiled `dist/index.js` (prod).
 *   - `args[1+]` = absolute path to the bridge entry script.
 *
 * Shape returned:
 *   {
 *     "command": "/Users/.../node",
 *     "args": ["/Users/.../tsx/dist/cli.mjs", "/Users/.../mcp-bridge/src/index.ts"],
 *     "configBlock": "{\"mcpServers\":{\"agent-bridge\":{...}}}"
 *   }
 *
 * `configBlock` is the literal JSON string most IDEs expect — newline-
 * formatted so the operator can paste it into a `~/.cursor/mcp.json`
 * etc. without further reshaping.
 *
 * What this DOES NOT include:
 *   - Env vars (DATABASE_URL, REDIS_URL, etc.). The bridge reads
 *     `.env` from the repo root via `loadRootDotenv` — so the IDE only
 *     needs to know the command + args, never any secrets. Including
 *     them in the response would be a config leak risk.
 *   - Auth tokens. Stdio = "trust the parent process" (PID-auth) for
 *     Phase 5d; HTTP transport with HMAC/bearer is deferred.
 *
 * Dev vs prod:
 *   - When `NODE_ENV !== 'production'` we point at `tsx`'s CLI module
 *     so the IDE picks up live edits without a build step.
 *   - In prod we point at the compiled `dist/index.js`. The dist file
 *     might not exist yet (first boot before `pnpm build`); we surface
 *     a `prodReady: false` flag so the UI can warn before the
 *     operator pastes a config that will fail.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hono } from 'hono'
import { env } from '../env.js'

/**
 * Resolve the absolute path to the bridge entry. The backend runs from
 * `apps/backend/dist/server.js` in prod and `apps/backend/src/server.ts`
 * via tsx in dev — both `import.meta.url` shapes resolve to a child of
 * `apps/backend/`, so walking three levels up lands on the repo root,
 * and the bridge is at `<root>/apps/mcp-bridge/`.
 *
 * The walk is deliberate (not `process.cwd()`) so the result is stable
 * even when the backend is started from a different working directory
 * (e.g. by a process manager).
 */
function resolveBridgeEntry(): { dev: string; prod: string; root: string } {
  const here = fileURLToPath(import.meta.url)
  // here = .../apps/backend/{src|dist}/routes/bridge.{ts|js}
  // walk up: routes → src/dist → backend → apps → repo root
  const repoRoot = path.resolve(path.dirname(here), '..', '..', '..', '..')
  const bridgeDir = path.join(repoRoot, 'apps', 'mcp-bridge')
  return {
    dev: path.join(bridgeDir, 'src', 'index.ts'),
    prod: path.join(bridgeDir, 'dist', 'index.js'),
    root: repoRoot,
  }
}

/**
 * Resolve the absolute path to `tsx`'s CLI module so the bridge can
 * be invoked as `node <tsx-cli> <bridge-src>` — fully PATH-independent.
 *
 * The bridge declares `tsx` as a devDependency, so resolving from
 * inside `apps/mcp-bridge/node_modules` is the deterministic location.
 * pnpm's hoisting puts the actual file at
 * `node_modules/.pnpm/tsx@<v>/node_modules/tsx/dist/cli.mjs`;
 * `require.resolve` follows that symlink chain for us.
 *
 * Returns `null` when tsx isn't installed (`pnpm install` was skipped
 * or the bridge workspace was renamed). Caller treats that as a
 * dev-mode misconfig and surfaces it in the response so the UI can
 * tell the operator to run `pnpm install`.
 */
function resolveTsxCli(bridgeDir: string): string | null {
  // tsx's `exports` field doesn't whitelist `./dist/cli.mjs`, so a
  // direct `require.resolve('tsx/dist/cli.mjs')` errors with
  // `ERR_PACKAGE_PATH_NOT_EXPORTED`. The reliable path is to resolve
  // tsx's `package.json` (always allowed), read its `bin` field, and
  // join that to the package dir. pnpm's symlink chain follows
  // automatically.
  try {
    const req = createRequire(path.join(bridgeDir, 'package.json'))
    const pkgJsonPath = req.resolve('tsx/package.json')
    const pkgJson = req('tsx/package.json') as {
      bin?: string | Record<string, string>
    }
    const binField = pkgJson.bin
    const binRel =
      typeof binField === 'string'
        ? binField
        : (binField?.['tsx'] ?? './dist/cli.mjs')
    return path.resolve(path.dirname(pkgJsonPath), binRel)
  } catch {
    return null
  }
}

interface BridgeConfig {
  readonly command: string
  readonly args: readonly string[]
  /**
   * Env vars the IDE must set when spawning the bridge. In dev we
   * inject `NODE_OPTIONS=--conditions=development` so that
   * `@agent-bridge/*` workspace imports resolve to each package's
   * `src/index.ts` (live, no build step). Empty in prod — built
   * artifacts already point at `dist/`.
   *
   * Why env (not a node CLI flag): tsx forks an internal loader
   * worker, and node CLI flags don't propagate to forked children.
   * `NODE_OPTIONS` does, so the condition reaches every level of
   * the resolver.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * Whether the resolved command + args are runnable today. `false`
   * in prod when `dist/index.js` is missing (operator skipped the
   * build) or in dev when tsx isn't installed. The UI surfaces a
   * warning so the operator doesn't paste a config Cursor will
   * fail to spawn.
   */
  readonly ready: boolean
  readonly readyHint: string | null
  /**
   * The full Cursor/Claude-style `{ "mcpServers": { ... } }` JSON
   * string the operator pastes into their IDE config file.
   */
  readonly configBlock: string
}

function buildConfig(): BridgeConfig {
  const entry = resolveBridgeEntry()
  const bridgeDir = path.join(entry.root, 'apps', 'mcp-bridge')

  // Always invoke node with an absolute path. `process.execPath` is
  // the Node binary the backend itself is running under — same node
  // version is exactly what we want for the bridge.
  const nodeBin = process.execPath

  let command: string
  let args: string[]
  let envVars: Record<string, string> = {}
  let ready = false
  let readyHint: string | null = null

  if (env.isProd) {
    command = nodeBin
    args = [entry.prod]
    if (existsSync(entry.prod)) {
      ready = true
    } else {
      readyHint =
        `Build the bridge first — \`pnpm --filter mcp-bridge build\` ` +
        `creates ${entry.prod}.`
    }
  } else {
    const tsxCli = resolveTsxCli(bridgeDir)
    if (tsxCli) {
      command = nodeBin
      args = [tsxCli, entry.dev]
      // Two env vars matter here:
      //   1. `NODE_OPTIONS=--conditions=development` so the workspace's
      //      `development` export condition wins and `@agent-bridge/*`
      //      imports resolve to each package's `src/index.ts` (live,
      //      no build step). Backend + worker dev scripts do the same
      //      via `NODE_OPTIONS`. The flag MUST go through `NODE_OPTIONS`
      //      (not a node CLI arg) because tsx spawns an internal
      //      loader worker, and node CLI flags don't reach forked
      //      children — `NODE_OPTIONS` does.
      //   2. `DOTENV_CONFIG_QUIET=true` to silence tsx's bundled
      //      dotenvx banner. tsx auto-loads `.env` and prints
      //      `◇ injected env (N) from .env` to STDOUT — which would
      //      corrupt the MCP wire format. tsx has no `--quiet` flag;
      //      this env var is the only way to suppress.
      envVars = {
        NODE_OPTIONS: '--conditions=development',
        DOTENV_CONFIG_QUIET: 'true',
      }
      ready = existsSync(entry.dev)
      if (!ready) {
        readyHint = `Bridge entry missing at ${entry.dev}.`
      }
    } else {
      // Fall back to a definitely-broken spawn so the IDE's error
      // message at least names what's missing.
      command = nodeBin
      args = ['--eval', "console.error('tsx not installed; run pnpm install'); process.exit(1)"]
      readyHint =
        `tsx isn't installed in apps/mcp-bridge — run \`pnpm install\` ` +
        `from the repo root.`
    }
  }

  // The CWD hint matters: the bridge calls `loadRootDotenv` which
  // walks upward looking for `.env`. Pointing the IDE at the repo
  // root keeps that walk short + deterministic across operators
  // who might run their IDE from a parent directory.
  const serverBlock: Record<string, unknown> = {
    command,
    args,
    // Many MCP-aware IDEs honor a `cwd` field; harmless on those
    // that don't because they spawn from their own default cwd.
    cwd: entry.root,
  }
  if (Object.keys(envVars).length > 0) {
    serverBlock['env'] = envVars
  }
  const block = { mcpServers: { 'agent-bridge': serverBlock } }

  return {
    command,
    args,
    env: envVars,
    ready,
    readyHint,
    configBlock: JSON.stringify(block, null, 2),
  }
}

export const bridgeRouter = new Hono().get('/config', (c) => {
  const config = buildConfig()
  return c.json({ ok: true as const, ...config })
})

export type BridgeRouter = typeof bridgeRouter
