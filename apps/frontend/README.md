# @agent-bridge/frontend

React 19 + Vite client for Agent Bridge. Consumes the Hono backend through
a typed RPC client — see `src/lib/rpc.ts`.

Run this from the **repo root**, not from here:

```bash
pnpm dev
```

That starts the backend, the Vite dev server (on `127.0.0.1:5173` by default),
and the local Postgres/Redis containers.

## Environment

Only `VITE_*` variables reach the browser bundle. The dev server reads the
repo-root `.env` via Vite's `envDir`. The one variable this app cares about is:

- `VITE_API_URL` — absolute URL of the backend (default `http://127.0.0.1:3001`).
  Must be HTTPS in production builds.

## Scripts

| Script           | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Vite dev server                                  |
| `pnpm build`     | Typecheck (project refs) + Vite production build |
| `pnpm preview`   | Serve the production build                       |
| `pnpm lint`      | ESLint over the whole app                        |
| `pnpm typecheck` | `tsc -b --noEmit`                                |

## Type sharing with the backend

`import type { AppType } from 'backend'` — the backend workspace exposes its
Hono app type via package `exports`, and `hc<AppType>(baseUrl)` builds a fully
typed RPC client (paths, query params, JSON bodies, responses).
