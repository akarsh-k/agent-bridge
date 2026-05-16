# Agent Bridge

**A local-first agent workbench and MCP bridge that gives IDE coding agents grounded codebase research before they edit.**

Agent Bridge started from a simple idea: coding agents are good at editing
code, but they often do weak research before they act.

Cursor, Claude Code, Codex, and other IDE coding agents usually see the
current file, nearby snippets, and whatever they can discover through
search. That works for small tasks, but it breaks down in real applications
where behavior crosses repo boundaries: frontend → backend, shared types →
generated clients, service → worker, schema → tests.

Agent Bridge gives those IDE agents a better way to research your
codebase over MCP before they edit.

It runs locally, indexes the repos you attach, understands the edges
between them, and exposes agents that your IDE can call before making
code changes. The coding agent still writes the patch. Agent Bridge
supplies grounded, structured evidence so the patch is based on the real
shape of your codebase instead of a shallow grep loop.

Its primary use case is acting as a local research sidecar for IDE
coding agents, but you can also create blank agents, attach skills,
attach MCP tools, configure memory and model providers, and expose
those agents through the same MCP bridge.

> **License:** Source-available under
> [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, research,
> and non-commercial use. Commercial use requires a separate license —
> open an issue to start that conversation.

## Built on open-source tooling

Agent Bridge is built on open-source tools and open standards:

- **Mastra** powers the agent runtime, memory, model abstraction, and
  tool execution layer.
- **GitNexus** powers codebase indexing, graph context, embeddings, and
  code inspection.
- **MCP** is the protocol used to bridge IDE coding agents and Agent Bridge.
- **Postgres, pgvector, and Redis** provide local storage, vector search,
  queues, events, and run history.

The goal is not to hide these tools. Agent Bridge combines them into a
local developer workflow where coding agents can ask better questions
before they write code.

## Why this exists

Most coding agents have a research problem.

They can edit files, run commands, and search text, but they do not
naturally understand how a real application is split across repos. When a
bug crosses a frontend, backend, shared package, worker, or service
boundary, the IDE agent has to discover the system one tool call at a
time. That is slow, expensive, and easy to get wrong.

Agent Bridge gives the IDE agent one grounded research interface:

```
IDE coding agent
  → MCP call
    → Agent Bridge agent
      → deterministic inspector tools
        → GitNexus graph + embeddings + repo edges
          → structured evidence back to the IDE
```

Instead of exposing every low-level search or graph tool directly to the
IDE agent, Agent Bridge wraps them behind higher-level workflows like
`find_in_codebase`, `trace_flow`, `assess_change_impact`, `debug_help`,
`understand_module`, and `list_repos`. That keeps the coding agent from
looping through noisy search results and gives it a compact answer with
the files, symbols, relationships, and repo boundaries that matter.

## Two ways to use Agent Bridge

Agent Bridge is not limited to codebase inspection. It supports two
main modes.

### 1. Coding-helper agents

Coding-helper agents are designed to help Cursor, Claude Code, Codex,
and other IDE agents research your codebase before making changes.

These agents can attach repos, use GitNexus-backed graph and embedding
context, follow operator-defined repo edges, and expose code-inspection
tools through the MCP bridge. For each coding-helper agent, the bridge
exposes:

- `<slug>__inspect_codebase` — structured codebase evidence for
  debugging, tracing, impact analysis, and module understanding.
  Returns a `mini_repos[]` envelope with ranked file hits, graph
  context, cross-repo edges, and summaries.
- `<slug>__ask_agent` — prose answers for architecture, debugging, and
  general codebase questions.

This is the sidecar use case: your IDE agent stays focused on the
coding loop, while Agent Bridge handles deeper codebase research.

### 2. Blank custom agents

You can also create blank agents that are not tied to codebase
inspection. A blank agent can have its own system prompt, skills, model
provider, memory settings, external MCP connections, and custom bridge
tools. Attach tools from services like Notion, Atlassian, Datadog,
internal MCP servers, or your own local tools, then expose that agent
through the same MCP bridge.

In this mode, Agent Bridge becomes a local agent workbench. You define
the agent's behavior, attach the tools it should use, and make it
callable from your IDE or any MCP-compatible client.

So Agent Bridge is both a research sidecar for coding agents *and* a
local-first platform for building custom MCP-exposed agents — it's
local-first, not local-only; sidecar-first, not sidecar-only.

## Local LLMs and model usage

Agent Bridge was designed with local LLM workflows in mind.

The web app, MCP bridge, repo indexes, run logs, Postgres, Redis, and
encrypted secrets run on your machine. The intended setup is that your
IDE coding agent can ask a local Agent Bridge instance to research the
codebase, and that research agent can be backed by a local model when
configured.

External model providers are also supported. This is useful if you want
to use OpenAI, Anthropic, or another hosted model for stronger
reasoning, but it changes the operating model:

- prompts and retrieved context may be sent to the external provider;
- usage may consume paid tokens;
- cost depends on the provider, model, context size, and number of tool
  calls;
- local-first storage does not mean model inference is always local.

In short: Agent Bridge is local-first at the application and data
layer, and local-LLM-friendly at the model layer. External APIs are
optional. This lets you choose the trade-off you want: local privacy
and lower token usage with local models, or stronger hosted reasoning
with external provider costs.

## Example questions

From your IDE coding agent, ask things like:

- *Use Agent Bridge to inspect where `OrderStatus` is defined and which
  repos depend on it.*
- *Before changing the checkout schema, ask Agent Bridge what frontend
  and worker code will be affected.*
- *This error happens when creating an invoice. Ask Agent Bridge to
  trace the flow from the frontend mutation to the backend handler.*
- *Find the tests and modules most likely related to the auth callback
  bug.*
- *Ask the architecture agent which services depend on this shared
  package.*
- *Ask my custom Notion-connected agent what product requirements are
  related to this feature.*

## What Agent Bridge is not

Agent Bridge is not a replacement for Cursor, Claude Code, Codex, or
your IDE agent. It does not try to own the editing loop.

It is the research layer behind them: a local MCP server and agent
workbench that helps the coding agent understand the system before it
edits. The IDE agent still decides how to apply the change, run
commands, and produce the final patch. Agent Bridge gives it better
context before it does that work.

## High-level architecture

```
Cursor / Claude Code / Codex / MCP-compatible client
        │
        │ MCP (stdio)
        ▼
apps/mcp-bridge
        │
        ▼
Agent Bridge agent  ─── Mastra agent runtime
                    ├── deterministic inspector wrappers
                    ├── GitNexus graph + embeddings
                    ├── operator-defined repo edges
                    ├── attached skills
                    ├── memory configuration
                    └── optional external MCPs
```

Full design reference: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

Requirements:

- **Node** matching `engines.node` in root `package.json` (≥24.15.0). A
  `.nvmrc` is included — `nvm use` picks it up.
- **pnpm** — version pinned via `packageManager` in root `package.json`.
- **Docker + Docker Compose** for local Postgres (with `pgvector`) and
  Redis.

```bash
pnpm install        # installs all workspaces; you may be asked to approve a build script
cp .env.example .env
pnpm start          # preflight → pnpm install → pnpm build → docker compose up -d → starts backend + worker
```

Open http://127.0.0.1:3001. Then:

1. Add a model provider.
2. Add or clone a repo.
3. Wait for clone and indexing to finish.
4. Create an agent (Coding-helper for the sidecar use case, or Blank
   for a custom agent).
5. Attach repos, skills, and MCP tools as needed.
6. Open Settings and copy the MCP bridge config into your IDE.
7. Restart your IDE and call the exposed Agent Bridge tools.

`Ctrl+C` stops the Node servers but **leaves Docker containers
running** so DB state stays warm. Run `pnpm stop` to tear them down
(preserves data) or `pnpm stop:clean` to drop the volumes too.

## Updating

```bash
git pull
pnpm start
```

That's enough. `pnpm start` always runs `pnpm install` then `pnpm build`
before booting, so dep bumps, source changes, and `.env` edits all get
picked up automatically — every workspace (`packages/shared`, `db`,
`agents`; `apps/backend`, `worker`, `mcp-bridge`, `frontend`) gets built
in topological order. `tsc -b` is incremental, so a no-op build
finishes in ~5–10s; a real change takes the time it actually needs. The
backend then auto-applies any pending database migrations on boot.

No separate `pnpm install` / `pnpm build` / `pnpm db:migrate` step is
required for the common update flow. Escape hatches if you know your
state is fresh and want the fast path: `SKIP_INSTALL=1 pnpm start`,
`SKIP_BUILD=1 pnpm start`, or both. (See "Scripts" below for the env
var docs.)

Your data is safe across updates:

- The Postgres volume managed by Docker persists, so DB content
  survives `pnpm stop` and `pnpm start`.
- Cloned repos, indexes, the encryption master key, and OAuth tokens
  live under `.agent-bridge-data/` (gitignored), untouched by
  `git pull`.
- Your `.env` is gitignored.

The backend logs `Agent Bridge v<X.Y.Z> (commit <sha>)` on startup so
you can verify which version you just upgraded to. `GET /api/system/version`
returns the same.

> **Switching between `pnpm dev` and `pnpm start`?** They use different
> bridge entry points (source `.ts` vs compiled `.js`). After switching
> modes, open Settings in the app and re-copy the MCP config block
> into your IDE — the paths differ.

## Connect your IDE

In the running app, go to **Settings** and copy the auto-generated MCP
server config. The backend resolves absolute paths so the IDE doesn't
need to find `tsx` / `node` on its own minimal `PATH`. The block
adjusts to your install — `pnpm start` (production) emits a path that
points at the compiled bridge; `pnpm dev` emits a `tsx`-wrapped path
that runs the bridge from source for live edits.

For Cursor (`~/.cursor/mcp.json`) the production block looks like:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/agent-bridge/apps/mcp-bridge/dist/index.js"
      ]
    }
  }
}
```

Restart your IDE. The bridge advertises:

- `<slug>__ask_agent` for every agent.
- `<slug>__inspect_codebase` for Coding-helper agents with inspection
  enabled.
- Operator-authored bridge tools when you've added them to an agent.

Run logs and tool traces show up in `/logs` in the UI.

## Layout

```
.
├── apps/
│   ├── backend/          # Hono API server, run dispatcher, bridge endpoints
│   ├── frontend/         # React 19 + Vite UI
│   ├── worker/           # BullMQ worker for clone / index / wiki / delete jobs
│   └── mcp-bridge/       # stdio MCP server bridging IDEs to agents
├── packages/
│   ├── shared/           # Shared Zod schemas, env helpers, domain types
│   ├── db/               # Drizzle schema, queries, migrations (Postgres + pgvector)
│   └── agents/           # Mastra-backed agent factory (only place that imports @mastra/*)
├── tests/                # Local fixture harness + smoke runners
├── docs/                 # ARCHITECTURE.md and design notes
├── scripts/dev.mjs       # cross-platform dev orchestrator
├── scripts/start.mjs     # production orchestrator (pnpm start)
├── docker-compose.yml    # Postgres (pgvector) + Redis, loopback-bound
└── pnpm-workspace.yaml
```

## Scripts

Run from the repo root:

| Script              | What it does                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm preflight`    | Verifies Node version, `.env`, `node_modules`, and workspace layout.                                  |
| `pnpm start`        | **For end users.** Preflight → `pnpm install` → `pnpm build` (every workspace, topological) → `docker compose up -d` → spawn backend + worker against built outputs. Auto-migrates the DB on boot. One URL: http://localhost:3001. |
| `pnpm dev`          | **For contributors.** Preflight → build `packages/*` once → `docker compose up -d` → start all apps in parallel with `tsx watch` / Vite HMR / `tsc --watch`. Frontend on 5173, backend on 3001. |
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
- `SKIP_INSTALL=1 pnpm start` — skip the always-run `pnpm install`.
  Use when you know your install is fresh (e.g., you just ran it
  manually) and want to shave ~1–2s off the boot.
- `SKIP_BUILD=1 pnpm start` — skip the always-run `pnpm build`.
  Useful for verifying that the existing `dist/` boots cleanly, or
  for fast iteration when you're only restarting the runtime. Still
  fails fast if any required dist file is missing — better to error
  here than crash a child two seconds after spawn.
- `pnpm start --check` — verify a fresh clone is ready (Node version,
  `.env`, `node_modules`, Docker + Compose v2) without booting.

For the local fixture harness (synthetic ecommerce multi-repo demo),
see [`tests/README.md`](tests/README.md).

## Security and local-first design

Agent Bridge is designed around a local-first trust boundary:

- cloned repos stay on your machine;
- indexes stay on your machine;
- run logs stay on your machine;
- Postgres and Redis run locally, bound to loopback by default;
- secrets (provider API keys, MCP env/header values, OAuth tokens) are
  encrypted at rest with AES-256-GCM under
  `<AGENT_BRIDGE_DATA_DIR>/secret.key` (mode 0600);
- the MCP bridge runs locally over stdio as an IDE-spawned subprocess;
- external model APIs are optional;
- external MCP tools are optional.

Other guarantees:

- CORS origins are required in production; `*` is rejected at startup.
- Secure headers via `hono/secure-headers` on every response.
- Request body size capped per-route via `hono/body-limit`.
- All endpoint inputs validated by Zod.
- Compose services run with `no-new-privileges:true`; Postgres data is
  initialised with `--data-checksums`.
- `.env` is gitignored. `.env.example` contains only non-secret
  placeholders; update `POSTGRES_PASSWORD` before any non-local use.

**Important distinction:** local-first does not automatically mean
every model call is local. If you configure a local LLM, inference can
stay local. If you configure a hosted model provider, retrieved
context and prompts may be sent to that provider and may consume
tokens.

To report a security vulnerability, see [SECURITY.md](SECURITY.md) —
please don't file public issues for vulns.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full design
  reference: monorepo conventions, run lifecycle, MCP architecture,
  isolation model.
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
