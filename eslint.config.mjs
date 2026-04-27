// Repo-root ESLint config.
//
// Scope: lint guard rails that apply to the WHOLE monorepo. Today that's
// one rule — `no-restricted-imports` forbidding any Mastra package from
// being pulled in outside `packages/agents/**`. The intent is to force
// everyone through the `@agent-bridge/agents` facade so Mastra's API
// surface (models, stores, memory, tools) lives in exactly one package.
// That package doesn't exist yet (created in 3b); the rule is written
// ahead of time so 3b can't forget to respect the boundary, and so the
// rule fires immediately if anyone tries to shortcut past the facade.
//
// Per-app ESLint configs (currently only `apps/frontend/eslint.config.js`)
// still run their own domain-specific rules (React hooks, react-refresh,
// etc.) via `pnpm -r lint`. This file layers on top — it does NOT
// replace them. `pnpm lint` at the repo root runs both.
//
// Deliberately NOT using `tseslint.configs.recommended`: the only rule
// here is `no-restricted-imports` (ESLint core, syntax-only). Pulling
// in the recommended TS rules would turn this from a guard rail into a
// style enforcer, and would require per-package `tsconfigRootDir`
// wiring. If/when we want repo-wide TS style rules, split them into a
// separate layer.

import tseslint from 'typescript-eslint'

const MASTRA_IMPORT_PATTERNS = [
  {
    // Matches `@mastra/core`, `@mastra/memory`, `@mastra/rag`, etc. and
    // any subpath imports like `@mastra/core/agent`.
    group: ['@mastra/*', '@mastra/*/**'],
    message:
      'Mastra imports are only allowed inside `packages/agents/**`. ' +
      'Call into `@agent-bridge/agents` from apps/routes instead. ' +
      'See docs/PLAN.md → Phase 3 → 3a-lint for rationale.',
  },
  {
    // Bare `mastra` specifier, in case an unscoped variant is ever
    // published. False-positive cost is zero (no real dep named this).
    group: ['mastra', 'mastra/**'],
    message:
      'Mastra imports are only allowed inside `packages/agents/**`. ' +
      'Call into `@agent-bridge/agents` instead.',
  },
]

export default [
  {
    // The guard rail is a syntax-only overlay. Pre-existing
    // `eslint-disable` directives in source files refer to rules
    // enabled by per-package configs (run via `pnpm -r lint`), so the
    // root config shouldn't flag them as unused.
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist.hidden/**',
      '.agent-bridge-data/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Generated SQL from drizzle-kit — not source we author.
      'packages/db/migrations/**/*.sql',
      // Vendored third-party assets.
      'apps/frontend/public/**',
      // Per-app ESLint configs handle their own files; the frontend
      // one loads React plugins we don't reference here. Skipping
      // duplicate work also keeps `pnpm lint` fast.
      'apps/frontend/**',
    ],
  },

  // TS parser for `.ts`/`.tsx` — syntax only, no project service.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },

  // The guard rail.
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: MASTRA_IMPORT_PATTERNS },
      ],
    },
  },

  // Exception: `packages/agents/**` is the one place allowed to import
  // Mastra directly. Everything outside must go through its public
  // export surface.
  {
    files: ['packages/agents/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // The root config is allowed to name Mastra packages in rule
  // configuration strings without tripping its own rule.
  {
    files: ['eslint.config.mjs'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]
