# Contributing

Thanks for your interest. A few notes before you start.

## Licensing

Agent Bridge is licensed under
[PolyForm Noncommercial 1.0.0](LICENSE). By submitting a contribution
you agree your contribution is licensed under the same terms. If your
intended use of the project is commercial, please open an issue first
— a separate commercial license may be available.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The `pnpm dev` command runs a preflight (Node version, `.env`,
`node_modules`), pre-builds `packages/*`, brings up Postgres + Redis via
Docker Compose, then starts every app workspace in parallel. See the
README for what each script does.

For the local fixture harness (synthetic ecommerce multi-repo demo), see
[`tests/README.md`](tests/README.md).

## Code style

- **TypeScript strict** everywhere. `pnpm typecheck` must pass.
- **Prettier** owns formatting. Run `pnpm format` before opening a PR.
- **ESLint** at the root + per-workspace. `pnpm lint` must pass.
- **Comments**: prefer none. When you write one, explain *why* (a
  non-obvious constraint, a workaround) — not *what* (the code already
  shows that).
- **No backwards-compat shims** for code that hasn't shipped. Just
  change the call sites.

## Architecture invariants

These are enforced by ESLint guard-rails — don't fight them, ask first
if you think you need to:

- Only `packages/agents/*` may import `@mastra/*`.
- Only `apps/backend/src/lib/mcp-connections/*` and
  `packages/agents/src/mcp/external-mcps.ts` may call `decryptSecret(...)`
  on an mcp-connection envelope.
- Browser code (the Vite app) must never import from
  `@agent-bridge/shared/env` — it pulls in `dotenv` and calls
  `process.exit` on validation failure. Use the root `@agent-bridge/shared`
  entry only.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full set.

## Pull requests

- One concern per PR. Bug fixes don't need surrounding cleanup; refactors
  don't need feature work bundled in.
- Include a short *why* in the description. The diff already shows the
  *what*.
- For UI changes, please run the dev server and exercise the change in a
  browser before marking it ready. Type checks and tests verify
  correctness, not feature behaviour.
- Don't use `git commit --no-verify` — if a hook fails, fix the
  underlying issue.

## Reporting bugs

Use [GitHub issues](https://github.com/akarsh-k/agent-bridge/issues)
for bugs and feature requests. For **security** issues, see
[SECURITY.md](SECURITY.md) — please don't file public issues for vulns.

## Code of conduct

By participating you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).
