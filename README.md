# agent-bridge

Monorepo for Agent Bridge — a typed, end-to-end TypeScript stack.

- **apps/backend** — Hono API (`@hono/node-server`), Zod-validated endpoints, typed RPC surface exported to the frontend.
- **apps/frontend** — React 19 + Vite, consumes the backend's types via Hono's RPC client.
- **apps/mcp-bridge**. MCP server that exposes each Agent Bridge agent to IDE coding agents (Cursor, Claude Code, Codex) as one tool: `inspect_codebase`. The IDE LLM passes a free-form `query` plus optional repo hints; under the hood the agent's deterministic wrapper toolkit (`find_in_codebase`, `trace_flow`, `assess_change_impact`, `debug_help`, `understand_module`, `list_repos`) calls `gitnexus` and returns a structured `mini_repos[]` envelope grounded in the operator-curated multi-repo inventory + cross-repo edges. Design + protocol details in [`docs/ARCHITECTURE.md` §10](docs/ARCHITECTURE.md#10-wrapper-tool-architecture-inspector-toolkit).
- **packages/shared** — Shared Zod schemas, env helpers, and domain types used by every runtime (backend / workers / future services).
- **docker-compose.yml** — Postgres (with `pgvector`) and Redis for local development, bound to loopback.

## Requirements

- Node — matches `.nvmrc` (`nvm use`)
- pnpm — version pinned via `packageManager` in root `package.json`
- Docker + Docker Compose (optional; only needed for local Postgres/Redis)

## Setup

```bash
pnpm install
cp .env.example .env
```

Review `.env` and change at least `POSTGRES_PASSWORD` if this repo leaves your machine.

## Scripts

Run from the repo root:

| Script              | What it does                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm preflight`    | Verifies Node version, `.env`, `node_modules`, and workspace layout.                                  |
| `pnpm dev`          | Preflight → build `packages/*` once → `docker compose up -d` → start all apps in parallel.            |
| `pnpm stop`         | `docker compose down` — stops the Postgres/Redis containers (volumes preserved, data kept).           |
| `pnpm stop:clean`   | `docker compose down -v` — stops containers **and removes volumes** (destroys local DB + cache data). |
| `pnpm build`        | Recursive `build` across all workspaces (topological: `packages/*` build before `apps/*`).            |
| `pnpm typecheck`    | Recursive `typecheck` across all workspaces.                                                          |
| `pnpm lint`         | Recursive `lint` across all workspaces (frontend ESLint today; extendable per workspace).             |
| `pnpm format`       | Prettier — rewrite the whole repo to the project style.                                               |
| `pnpm format:check` | Prettier — check only; CI-friendly.                                                                   |

Stopping the dev stack: `Ctrl+C` stops the Node dev servers (backend / frontend / shared
watcher) gracefully but **leaves Docker containers running** so DB state is
kept warm between restarts. Run `pnpm stop` when you actually want to tear the
containers down.

Useful env-var overrides:

- `SKIP_PREFLIGHT=1 pnpm dev` — skip preflight checks.
- `SKIP_DOCKER=1 pnpm dev` — run app servers only; don't start Postgres/Redis.
- `SKIP_SHARED_BUILD=1 pnpm dev` — skip the one-time `packages/*` build (only use when `dist/` already exists).

## Layout

```
.
├── apps/
│   ├── backend/          # Hono API server
│   └── frontend/         # React + Vite client
├── packages/
│   └── shared/           # Shared Zod schemas, env helpers, domain types
├── scripts/dev.mjs       # cross-platform dev orchestrator
├── docker-compose.yml    # Postgres (pgvector) + Redis, loopback-bound
├── tsconfig.base.json    # Shared TypeScript compiler options
├── .env.example          # Safe defaults to copy to .env
└── pnpm-workspace.yaml
```

## Type sharing

Two complementary patterns:

1. **Hono RPC** — the frontend imports `AppType` from the `backend` workspace
   and calls `hc<AppType>(baseUrl)`. You get fully typed paths, query params,
   request bodies, and responses with zero code generation.
2. **`@agent-bridge/shared`** — any domain model or Zod schema used by more
   than one runtime (backend ↔ worker ↔ frontend) lives here. Each service
   extends `baseEnvSchema` for its own env, and uses `parseEnv()` /
   `loadRootDotenv()` to boot identically.

### How the shared package is wired

`packages/shared`'s `exports` points to `src/*.ts` under the `types` and
`development` conditions (what TypeScript and Vite see) and to `dist/*.js`
under `import` and `default` (what Node sees at runtime). Production builds
are handled by `pnpm -r build`, which runs in topological order so shared
packages are compiled before the apps that depend on them. In dev,
`scripts/dev.mjs` pre-builds `packages/*` once and then `pnpm -r --parallel
run dev` starts shared's `tsc --watch` alongside the app servers — so
backend/worker always find a fresh compiled output.

## Adding a worker (`apps/worker`)

The scaffolding is ready for this. A minimal worker:

1. Create `apps/worker/package.json`:

   ```json
   {
     "name": "worker",
     "version": "1.0.0",
     "private": true,
     "type": "module",
     "main": "./dist/index.js",
     "scripts": {
       "dev": "tsx watch src/index.ts",
       "build": "tsc",
       "start": "node dist/index.js",
       "typecheck": "tsc --noEmit"
     },
     "dependencies": {
       "@agent-bridge/shared": "workspace:*",
       "zod": "^4.3.6"
     },
     "devDependencies": {
       "@types/node": "^24.12.2",
       "tsx": "^4.21.0",
       "typescript": "~6.0.3"
     }
   }
   ```

2. Copy `apps/backend/tsconfig.json` to `apps/worker/tsconfig.json`.

3. Scaffold `apps/worker/src/env.ts` on the shared pattern:

   ```ts
   import {
     baseEnvSchema,
     loadRootDotenv,
     parseEnv,
   } from '@agent-bridge/shared/env'
   import { z } from 'zod'

   loadRootDotenv(import.meta.url)

   const envSchema = baseEnvSchema.extend({
     REDIS_URL: z.string().trim().url(), // required for a worker
     WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
   })

   const data = parseEnv(envSchema)
   export const env = {
     ...data,
     isProd: data.NODE_ENV === 'production',
   } as const
   ```

   `@agent-bridge/shared/env` is Node-only — it imports `dotenv` and
   calls `process.exit` on validation failure. Browser code (e.g. the
   Vite app) must not import from it; the frontend handles its own
   `VITE_*` parsing inline.

4. `apps/worker/src/index.ts` starts the job loop, with the same graceful-
   shutdown pattern used in `apps/backend/src/server.ts`.

5. `pnpm install` — `pnpm-workspace.yaml` already globs `apps/*`, so the
   worker is picked up automatically. `pnpm dev` / `pnpm build` /
   `pnpm typecheck` now include the worker with no further changes.

## Security notes

- CORS origins are required in production; `*` is rejected at startup.
- Secure headers are applied via `hono/secure-headers` on every response.
- Request body size is capped per-route via `hono/body-limit`.
- All endpoint inputs are validated by Zod.
- Dev defaults bind `HOST` to `127.0.0.1` — set `HOST=0.0.0.0` explicitly only
  when the process runs in a container or behind a proxy / firewall.
- Postgres and Redis ports are bound to `127.0.0.1` by default so they are not
  reachable from the LAN. Override with `POSTGRES_BIND` / `REDIS_BIND`.
- Compose services run with `no-new-privileges:true`; Postgres data is
  initialised with `--data-checksums`.
- Secrets live in `.env` (git-ignored). `.env.example` contains only
  non-secret placeholders; update `POSTGRES_PASSWORD` before any non-local use.

## License

See `LICENSE`.
