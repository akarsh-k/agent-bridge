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

```sh
# 1) make sure your local embedder is up (e.g. llama-server)
# 2) set the embedder coordinates inline:
export SMOKE_EMBEDDING_URL=http://127.0.0.1:8081/v1
export SMOKE_EMBEDDING_MODEL=<your-embedding-model-id>
# Optional — bearer token if your endpoint requires auth (cloud providers).
# export SMOKE_EMBEDDING_API_KEY=...

# Embedding dimensions are auto-probed from the endpoint at preflight.

pnpm test:fixture:setup     # builds + indexes; ~30-60s
pnpm test:fixture           # runs the assertions; ~10-20s
```

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
