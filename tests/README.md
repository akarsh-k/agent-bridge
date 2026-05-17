# tests/

Local-only fixture harness for the inspector toolkit. Builds three small
ecommerce repos (TS frontend, Python FastAPI backend, TS shared lib),
indexes them with gitnexus into a sibling data root, and exercises each
inspector wrapper against the real subprocess.

## Layout

```
tests/
  fixtures/repos/
    ecommerce-shared/       TS — Product, formatPrice, ApiError
    ecommerce-frontend/     TS + React — useProducts, ProductCard
    ecommerce-backend/      Python + FastAPI — GET /products
  fixture-config.ts         Shared constants (slugs, edges, agent identity)
  fixture-setup.ts          Phase 1 — DB bootstrap, copy fixtures, git init, index
  smoke-fixture.ts          Phase 2 — exercise wrappers + assertions
  README.md
```

## How it isolates from your dev workspace

- **Database**: `agentbridge_test` (a separate DB on the same Postgres).
  Setup creates it if missing.
- **Data root**: `<repo>/.agent-bridge-data-test/` (sibling of the dev
  `.agent-bridge-data/`). Setup wipes and rebuilds this on every run.
- **Env overrides**: setup/smoke set `DATABASE_URL` and
  `AGENT_BRIDGE_DATA_DIR` in-process before any worker module loads.
  `dotenv` doesn't override existing env, so `.env` is ignored where
  it would conflict.

Your dev DB and data root are never touched.

## Running

Make sure your local embedder is up (e.g. llama-server), then uncomment
the `SMOKE_*` block in the repo-root `.env` (copy from `.env.example`
if you haven't already). Embedding dimensions are auto-probed at
preflight — no need to declare them.

```sh
pnpm test:fixture:setup     # builds + indexes; ~30-60s
pnpm test:fixture           # runs the assertions; ~10-20s
pnpm test:fixture:bridge    # spawns the MCP bridge subprocess; ~10s
```

`SMOKE_EMBEDDING_*` is required for setup and the wrapper smoke.
`SMOKE_CHAT_*` is optional — when set, `test:fixture:bridge` adds an
end-to-end check that round-trips `inspect_codebase` and asserts the
envelope carries `agent_repos` + `repo_relationships`. Without it, that single
assertion skips with a `⚠` line.

## What the smoke asserts

- `list_repos` — returns the three fixture repos
- `find_in_codebase("Product")` — hits across multiple repos
- `find_in_codebase("formatPrice")` — hits in the shared repo
- `understand_module("app/routes/products.py", repo='backend')` — Python file context
- `trace_flow(startSymbol="useProducts")` — frontend hook trace
- `assess_change_impact(["Product"], 'modify')` — surfaces consumers
- `debug_help("ApiError: HTTP 500…")` — surfaces the error class

Assertions are intentionally loose ("at least N hits across these repos")
because BM25+semantic+RRF ranking is non-deterministic across embedder
versions. The point is regression detection — wrappers that suddenly
return zero hits, mounts that fail to spawn, schema drift.
