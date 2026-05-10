# Agent Bridge

**Multi-repo grounding for IDE coding agents via MCP.**

Cursor, Claude Code, and Codex are great at writing code — but they're blind to
the *other* repos your code lives next to. Agent Bridge runs locally, indexes
the repos you point it at, and exposes a single MCP tool — `inspect_codebase` —
that the IDE LLM can call to ask grounded questions about your multi-repo
codebase: where does the `Order` type flow, what calls this endpoint, what
breaks if I change this schema. Answers come back as a structured
`mini_repos[]` envelope built from operator-curated repo edges + the GitNexus
knowledge graph.

> **License:** Source-available under
> [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, research,
> and non-commercial use. Commercial use requires a separate license —
> open an issue or contact the maintainer.

## What it does

- **Inventory + cross-repo edges.** Operator-curated set of repos plus the
  edges between them (frontend → backend → shared types). The IDE LLM never
  has to guess a service boundary.
- **GitNexus-backed grounding.** Each repo gets cloned, parsed, and indexed.
  Tools like `find_in_codebase`, `trace_flow`, `assess_change_impact`,
  `debug_help`, `understand_module`, `list_repos` run against that index and
  return structured results — not raw `grep` output.
- **MCP bridge for any IDE.** `apps/mcp-bridge` is a stdio MCP server. The
  Settings page in the UI hands you a paste-ready config block for
  `~/.cursor/mcp.json` (Cursor) or equivalent. One agent → one tool.
- **Local-first.** Postgres + Redis run on loopback in Docker Compose. No
  hosted backend. Secrets encrypted at rest with a key under
  `.agent-bridge-data/secret.key`.
- **External MCP connections.** Attach Notion, Atlassian, or any other
  MCP-compatible service to an agent (HTTP/SSE with OAuth or stdio with
  env vars) and the agent can call those tools too.

## Quickstart

Requirements:

- **Node** matching `engines.node` in root `package.json` (≥24.15.0). A
  `.nvmrc` is included — `nvm use` picks it up.
- **pnpm** — version pinned via `packageManager` in root `package.json`.
- **Docker + Docker Compose** for local Postgres (with `pgvector`) and Redis.

```bash
pnpm install        # installs all workspaces; you may be asked to approve a build script
cp .env.example .env
pnpm dev            # preflight → docker compose up -d → start backend / frontend / worker / shared watcher
```

Open http://127.0.0.1:5173. Add a repo, wait for clone + index, attach it to
an agent, then head to **Settings** to wire the MCP bridge into your IDE.

`Ctrl+C` stops the Node servers but **leaves Docker containers running** so
DB state stays warm. Run `pnpm stop` to tear them down (preserves data) or
`pnpm stop:clean` to drop the volumes too.

## Connect your IDE

In the running app, go to **Settings** and copy the auto-generated MCP
server config (the backend resolves absolute paths so the IDE doesn't need
to find `tsx` / `node` on its own minimal `PATH`).

For Cursor (`~/.cursor/mcp.json`) the block looks like:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/tsx/dist/cli.mjs",
        "/absolute/path/to/agent-bridge/apps/mcp-bridge/src/index.ts"
      ]
    }
  }
}
```

Restart your IDE. The bridge advertises one tool per agent — `query_<slug>`
— calling it from the IDE LLM routes the request to the matching agent in
your local Agent Bridge install. Run logs and tool traces show up in
`/logs` in the UI.

## Layout

```
.
├── apps/
│   ├── backend/          # Hono API server, run dispatcher, bridge endpoints
│   ├── frontend/         # React 19 + Vite UI
│   ├── worker/           # BullMQ worker for clone / index / wiki jobs
│   └── mcp-bridge/       # stdio MCP server bridging IDEs to agents
├── packages/
│   ├── shared/           # Shared Zod schemas, env helpers, domain types
│   ├── db/               # Drizzle schema, queries, migrations (Postgres + pgvector)
│   └── agents/           # Mastra-backed agent factory (only place that imports @mastra/*)
├── tests/                # Local fixture harness + smoke runners
├── docs/                 # ARCHITECTURE.md and design notes
├── scripts/dev.mjs       # cross-platform dev orchestrator
├── docker-compose.yml    # Postgres (pgvector) + Redis, loopback-bound
└── pnpm-workspace.yaml
```

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
| `pnpm lint`         | ESLint at the root + recursive `lint` across all workspaces.                                          |
| `pnpm format`       | Prettier — rewrite the whole repo to the project style.                                               |
| `pnpm format:check` | Prettier — check only; CI-friendly.                                                                   |
| `pnpm db:generate`  | `drizzle-kit generate` — diff schema, write a new SQL migration.                                      |
| `pnpm db:migrate`   | `drizzle-kit migrate` — apply pending migrations against `DATABASE_URL`.                              |
| `pnpm db:studio`    | `drizzle-kit studio` — browse the local DB.                                                           |
| `pnpm clean:data`   | Wipe `.agent-bridge-data/` (cloned repos, indexes, secrets). Asks first — use `:force` to skip.       |

Useful env-var overrides:

- `SKIP_PREFLIGHT=1 pnpm dev` — skip preflight checks.
- `SKIP_DOCKER=1 pnpm dev` — run app servers only; don't start Postgres/Redis.
- `SKIP_SHARED_BUILD=1 pnpm dev` — skip the one-time `packages/*` build.

For the local fixture harness (synthetic ecommerce multi-repo demo), see
[`tests/README.md`](tests/README.md).

## Type sharing

Two complementary patterns:

1. **Hono RPC** — the frontend imports `AppType` from the `backend`
   workspace and calls `hc<AppType>(baseUrl)`. Fully typed paths, query
   params, request bodies, and responses with zero code generation.
2. **`@agent-bridge/shared`** — domain models and Zod schemas used by more
   than one runtime (backend ↔ worker ↔ frontend ↔ mcp-bridge) live here.
   Each service extends `baseEnvSchema` for its own env, and uses
   `parseEnv()` / `loadRootDotenv()` to boot identically.

`packages/shared`'s `exports` map points to `src/*.ts` under the `types` and
`development` conditions and to `dist/*.js` under `import` and `default`.
Production builds run via `pnpm -r build` in topological order; in dev,
`scripts/dev.mjs` pre-builds `packages/*` once and then `pnpm -r --parallel
run dev` starts shared's `tsc --watch` alongside the app servers.

## Security

- CORS origins are required in production; `*` is rejected at startup.
- Secure headers are applied via `hono/secure-headers` on every response.
- Request body size is capped per-route via `hono/body-limit`.
- All endpoint inputs are validated by Zod.
- Dev defaults bind `HOST` to `127.0.0.1` — set `HOST=0.0.0.0` explicitly
  only when the process runs in a container or behind a proxy / firewall.
- Postgres and Redis ports are bound to `127.0.0.1` by default so they are
  not reachable from the LAN. Override with `POSTGRES_BIND` / `REDIS_BIND`.
- Compose services run with `no-new-privileges:true`; Postgres data is
  initialised with `--data-checksums`.
- Secrets (provider API keys, MCP env/header values, OAuth tokens) live
  encrypted in Postgres with AES-256-GCM. The master key lives at
  `<AGENT_BRIDGE_DATA_DIR>/secret.key` (mode 0600), auto-generated on first
  boot — back it up if you care about the encrypted rows surviving a
  data-dir reset.
- `.env` is gitignored. `.env.example` contains only non-secret
  placeholders; update `POSTGRES_PASSWORD` before any non-local use.

To report a security vulnerability, see [SECURITY.md](SECURITY.md). Please
do not file public issues for vulns.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full design reference:
  monorepo conventions, run lifecycle, MCP architecture, isolation model.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, code style, PR
  expectations.
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure policy.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community guidelines.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Source-available; free for
personal, research, internal evaluation, and non-commercial use.
Commercial use (selling, hosting as a service, embedding in a paid
product) requires a separate license — open an issue to start that
conversation.
