/**
 * Fixture harness — phase 2 of 2: exercise each inspector wrapper
 * against the indexed fixture and assert on the returned mini-repos.
 *
 * Assumes `pnpm test:fixture:setup` ran first (test DB seeded, fixture
 * repos cloned + indexed under `.agent-bridge-data-test/`).
 *
 * What this asserts (deterministic mode — no LLM calls;
 * `find_in_codebase` skips term expansion when `modelConfig` is omitted):
 *
 *   - list_repos              returns the three fixture repos
 *   - find_in_codebase        finds `Product` across all three repos
 *   - find_in_codebase        finds `formatPrice` only in shared
 *   - understand_module       returns context for the FastAPI route file
 *   - trace_flow              traces from `useProducts` into shared
 *   - assess_change_impact    surfaces both the AST consumer (frontend)
 *                             and the cross-language mirror (backend)
 *                             when `Product` changes in shared
 *   - debug_help              surfaces `ApiError` on a 500 stack hint
 *
 * Each assertion prints `✓` / `✗` with a one-line diagnostic and the
 * runner exits non-zero on any failure.
 *
 * Required env (same as the setup script):
 *   SMOKE_EMBEDDING_URL, SMOKE_EMBEDDING_MODEL
 * Optional:
 *   SMOKE_EMBEDDING_API_KEY  bearer token if the endpoint requires auth
 *
 * Embedding dimensions are auto-probed from the endpoint at preflight.
 *
 * Run from repo root:
 *   pnpm test:fixture
 */

/* eslint-disable no-console */

import { spawnSync } from 'node:child_process'

import { eq } from 'drizzle-orm'

import { loadRootDotenv } from '@agent-bridge/shared/env'

// Load the repo-root .env so SMOKE_* vars resolve in preflight. tsx
// doesn't auto-load it from the tests workspace cwd.
loadRootDotenv(import.meta.url, { depth: 1 })

import {
  FIXTURE_AGENT,
  TEST_DATA_DIR,
  TEST_DB_NAME,
} from './fixture-config.js'
import { probeEmbeddingDims } from './probe-embedding-dims.js'

// ─── Pre-flight + env override (BEFORE worker/agents imports) ──────────────

interface SmokeConfig {
  readonly embeddingUrl: string
  readonly embeddingModel: string
  readonly embeddingDims: number
}

async function preflight(): Promise<SmokeConfig> {
  const embeddingUrl = process.env['SMOKE_EMBEDDING_URL']
  const embeddingModel = process.env['SMOKE_EMBEDDING_MODEL']
  const missing: string[] = []
  if (!embeddingUrl) missing.push('SMOKE_EMBEDDING_URL')
  if (!embeddingModel) missing.push('SMOKE_EMBEDDING_MODEL')
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`)
  }
  // Probe the endpoint to discover output dimensionality. The probe is the
  // single source of truth — overriding it risks silent vector-size mismatch
  // between what we tell the schema and what the embedder actually returns.
  const embeddingDims = await probeEmbeddingDims({
    url: embeddingUrl!,
    model: embeddingModel!,
    apiKey: process.env['SMOKE_EMBEDDING_API_KEY'] ?? null,
  })
  // git available (transitively required by gitnexus walks)
  const gitCheck = spawnSync('git', ['--version'], { stdio: 'ignore' })
  if (gitCheck.status !== 0) throw new Error('git not found on PATH')
  return {
    embeddingUrl: embeddingUrl!,
    embeddingModel: embeddingModel!,
    embeddingDims,
  }
}

const config = await preflight()

const baseDbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = swapDatabaseName(baseDbUrl, TEST_DB_NAME)
process.env['DATABASE_URL'] = testDbUrl
process.env['AGENT_BRIDGE_DATA_DIR'] = TEST_DATA_DIR
process.env['GITNEXUS_EMBEDDING_URL'] = config.embeddingUrl
process.env['GITNEXUS_EMBEDDING_MODEL'] = config.embeddingModel
process.env['GITNEXUS_EMBEDDING_DIMS'] = String(config.embeddingDims)

function swapDatabaseName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

// ─── Imports (env-sensitive ones must come AFTER overrides above) ──────────

const { createDb } = await import('@agent-bridge/db')
const schema = await import('@agent-bridge/db/schema')
const { loadAttachedRepos } = await import('../packages/agents/src/coding-agent/repo-loader.js')
const { mountGitnexusMcp } = await import('../packages/agents/src/mcp/gitnexus-mcp.js')
const { runFindInCodebase } = await import(
  '../packages/agents/src/inspector/workflows/find-in-codebase.js'
)
const { runListRepos } = await import(
  '../packages/agents/src/inspector/workflows/list-repos.js'
)
const { runUnderstandModule } = await import(
  '../packages/agents/src/inspector/workflows/understand-module.js'
)
const { runTraceFlow } = await import(
  '../packages/agents/src/inspector/workflows/trace-flow.js'
)
const { runAssessChangeImpact } = await import(
  '../packages/agents/src/inspector/workflows/assess-change-impact.js'
)
const { runDebugHelp } = await import(
  '../packages/agents/src/inspector/workflows/debug-help.js'
)

// ─── Tiny assertion helper ─────────────────────────────────────────────────

interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly note: string
}

const results: CheckResult[] = []

function check(name: string, ok: boolean, note: string): void {
  results.push({ name, ok, note })
  console.log(`${ok ? '✓' : '✗'} ${name} — ${note}`)
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(60))
  console.log(' Fixture smoke')
  console.log('═'.repeat(60))
  console.log(`test DB:   ${maskPassword(testDbUrl)}`)
  console.log(`data root: ${TEST_DATA_DIR}`)
  console.log('')

  const db = createDb({ connectionString: testDbUrl })

  try {
    // 1. Look up the fixture agent.
    const agentRow = await db.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.slug, FIXTURE_AGENT.slug))
      .limit(1)
    const agent = agentRow[0]
    if (!agent) {
      throw new Error(
        `Fixture agent ${FIXTURE_AGENT.slug} not found. ` +
          `Run \`pnpm test:fixture:setup\` first.`,
      )
    }

    // 2. Load attached repos.
    const repos = await loadAttachedRepos({
      db,
      agentId: agent.id,
      readyOnly: true,
    })
    check(
      'attached repos',
      repos.length === 3,
      `${repos.length}/3 repos at status='ready'`,
    )
    if (repos.length === 0) {
      throw new Error('No ready repos; setup must have failed silently')
    }

    // 3. Mount gitnexus subprocess.
    console.log('▸ mounting gitnexus subprocess…')
    const mounted = await mountGitnexusMcp({
      db,
      agentId: agent.id,
      log: (line) => process.stdout.write(`  [gitnexus] ${line}\n`),
    })
    if (!mounted) {
      throw new Error('mountGitnexusMcp returned null — no ready repos?')
    }
    console.log(`  mounted with ${Object.keys(mounted.tools).length} tools`)

    try {
      // 4. list_repos — returns a mini-repo whose `summary` carries the
      // inventory; `files` stays empty (this isn't a search wrapper).
      const list = await runListRepos({ repos })
      const summaryMentionsAll = ['frontend', 'backend', 'shared'].every((label) =>
        list.summary.toLowerCase().includes(label),
      )
      check(
        'list_repos inventory',
        list.summary.includes('3 repos') && summaryMentionsAll,
        `summary=${truncate(list.summary, 80)}`,
      )

      // 5. find_in_codebase: "Product" across all repos
      const findProduct = await runFindInCodebase({
        tools: mounted.tools,
        repos,
        query: 'Product',
        maxFiles: 12,
      })
      const productRepos = uniqueRepoLabels(findProduct.files.map((f) => f.repo_label))
      check(
        'find_in_codebase("Product")',
        productRepos.length >= 2,
        `${findProduct.files.length} hits across [${productRepos.join(', ')}]`,
      )

      // 6. find_in_codebase: "formatPrice" — should hit shared (and frontend's re-export)
      const findFormat = await runFindInCodebase({
        tools: mounted.tools,
        repos,
        query: 'formatPrice',
        maxFiles: 8,
      })
      const formatRepos = uniqueRepoLabels(findFormat.files.map((f) => f.repo_label))
      check(
        'find_in_codebase("formatPrice")',
        formatRepos.some((l) => l.includes('shared')),
        `${findFormat.files.length} hits across [${formatRepos.join(', ')}]`,
      )

      // 7. understand_module: symbol-anchored. Now that the wrapper reads
      // the body from disk using gitnexus_context's symbol record, we
      // expect at least one file with the function body inline.
      const understand = await runUnderstandModule({
        tools: mounted.tools,
        repos,
        anchor: 'list_products',
        repoHint: 'backend',
      })
      const understandFile = understand.files.find((f) =>
        f.path.endsWith('routes/products.py'),
      )
      check(
        'understand_module(list_products)',
        understand.files.length >= 1 &&
          understandFile != null &&
          understandFile.chunks.length >= 1 &&
          understandFile.chunks[0]!.content.includes('list_products'),
        `${understand.files.length} files; routes/products.py body=${
          understandFile?.chunks[0]?.content.split('\n').length ?? 0
        } lines`,
      )

      // 7b. understand_module: path-anchored. Reads file body from disk
      // directly without a gitnexus_context call.
      const understandPath = await runUnderstandModule({
        tools: mounted.tools,
        repos,
        anchor: 'src/product.ts',
        repoHint: 'shared-types',
      })
      const productFile = understandPath.files.find((f) => f.path === 'src/product.ts')
      check(
        'understand_module(path: src/product.ts)',
        productFile != null &&
          productFile.chunks.length >= 1 &&
          productFile.chunks[0]!.content.includes('interface Product'),
        `${understandPath.files.length} files; product.ts body=${
          productFile?.chunks[0]?.content.split('\n').length ?? 0
        } lines`,
      )

      // 8. trace_flow: from useProducts. With on-disk reads, the top hops
      // should now carry actual file content.
      const trace = await runTraceFlow({
        tools: mounted.tools,
        repos,
        startSymbol: 'useProducts',
        repoHint: 'frontend',
      })
      check(
        'trace_flow(useProducts)',
        trace.wrapper === 'trace_flow' &&
          (trace.files.length >= 1 || trace.summary.length > 0),
        `${trace.files.length} files, ${trace.graph_subset.nodes.length} graph nodes`,
      )

      // 9. assess_change_impact: Product in shared-types. Use the repo's
      // canonical role label so the resolver matches it directly.
      const impact = await runAssessChangeImpact({
        tools: mounted.tools,
        repos,
        db,
        agentId: agent.id,
        anchors: ['Product'],
        changeKind: 'modify',
        repoHint: 'shared-types',
      })
      const impactRepos = uniqueRepoLabels(impact.files.map((f) => f.repo_label))
      check(
        'assess_change_impact(Product)',
        impact.wrapper === 'assess_change_impact' &&
          impact.summary.length > 0 &&
          impact.cross_repo_edges.length >= 1,
        `${impact.files.length} files, ${impact.cross_repo_edges.length} edges, ` +
          `repos=[${impactRepos.join(', ')}]`,
      )

      // 10. debug_help: ApiError surface. Body should now come from disk
      // with surrounding context, not just the gitnexus snippet.
      const debug = await runDebugHelp({
        tools: mounted.tools,
        repos,
        errorText: 'ApiError: HTTP 500 from /products',
      })
      const debugWithBody = debug.files.filter(
        (f) => f.chunks.length >= 1 && f.chunks[0]!.content.length > 0,
      )
      check(
        'debug_help(ApiError)',
        debug.files.length >= 1 && debugWithBody.length >= 1,
        `${debug.files.length} files (${debugWithBody.length} with body), summary=${truncate(
          debug.summary,
          80,
        )}`,
      )
    } finally {
      await mounted.client.disconnect().catch(() => undefined)
    }
  } finally {
    await db.close()
  }

  // Summary
  console.log('')
  console.log('═'.repeat(60))
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(` Passed: ${passed}/${results.length}`)
  if (failed.length > 0) {
    console.log(` Failed:`)
    for (const f of failed) console.log(`   ✗ ${f.name} — ${f.note}`)
    console.log('═'.repeat(60))
    process.exitCode = 1
  } else {
    console.log(' All checks passed.')
    console.log('═'.repeat(60))
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function uniqueRepoLabels(labels: readonly string[]): string[] {
  return Array.from(new Set(labels))
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function maskPassword(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}

main().catch((err) => {
  console.error('[fixture-smoke] fatal:', err)
  process.exit(1)
})
