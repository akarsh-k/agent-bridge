/**
 * Bridge-registry smoke. Spawns `apps/mcp-bridge/src/index.ts` as a
 * subprocess pointed at the test DB + test data root, connects via
 * stdio MCP, lists tools, and asserts the per-kind built-in surface:
 *
 *   - Coding-helper fixture (`fixture-ecommerce`):
 *       <slug>__inspect_codebase ONLY (no ask_agent)
 *   - Blank fixture         (`fixture-blank`):
 *       <slug>__ask_agent ONLY (no inspect_codebase)
 *
 * Catches regressions in `buildToolRegistry`'s branching on
 * `agents.inspector_enabled` and confirms the "exactly one built-in
 * per agent kind" rule.
 *
 * Run after `pnpm test:fixture:setup` succeeds. Same env requirements
 * as the existing smoke (`SMOKE_EMBEDDING_*`).
 */

/* eslint-disable no-console */

import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  FIXTURE_AGENT,
  FIXTURE_BLANK_AGENT,
  REPO_ROOT,
  TEST_DATA_DIR,
  TEST_DB_NAME,
} from './fixture-config.js'

// ─── Env override (BEFORE any MCP spawn) ────────────────────────────────

function swapDatabaseName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

const baseDbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = swapDatabaseName(baseDbUrl, TEST_DB_NAME)

// ─── Spawn config ───────────────────────────────────────────────────────

const BRIDGE_ENTRY = path.join(REPO_ROOT, 'apps', 'mcp-bridge', 'src', 'index.ts')

// ─── Tiny check helper ──────────────────────────────────────────────────

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

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(60))
  console.log(' Bridge-registry smoke')
  console.log('═'.repeat(60))
  console.log(`test DB:    ${maskPassword(testDbUrl)}`)
  console.log(`data root:  ${TEST_DATA_DIR}`)
  console.log(`bridge:     ${BRIDGE_ENTRY}`)
  console.log('')

  // Use pnpm to invoke the bridge under the same workspace's tsx so
  // we don't hand-roll the loader path. pnpm + filter + exec walks the
  // workspace, finds tsx, and runs the entry script. The MCP SDK speaks
  // stdio; pnpm's own logs go to stderr (harmless).
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: [
      '--filter',
      'mcp-bridge',
      'exec',
      'tsx',
      'src/index.ts',
    ],
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: testDbUrl,
      AGENT_BRIDGE_DATA_DIR: TEST_DATA_DIR,
      // Forward embedding env in case any path (e.g. assertExpectedGitnexusVersion)
      // wants it during boot. The bridge itself doesn't run gitnexus, so
      // this is mostly defensive.
      ...(process.env['SMOKE_EMBEDDING_URL']
        ? { GITNEXUS_EMBEDDING_URL: process.env['SMOKE_EMBEDDING_URL'] }
        : {}),
      ...(process.env['SMOKE_EMBEDDING_MODEL']
        ? { GITNEXUS_EMBEDDING_MODEL: process.env['SMOKE_EMBEDDING_MODEL'] }
        : {}),
      ...(process.env['SMOKE_EMBEDDING_DIMS']
        ? { GITNEXUS_EMBEDDING_DIMS: process.env['SMOKE_EMBEDDING_DIMS'] }
        : {}),
    },
    cwd: REPO_ROOT,
    stderr: 'inherit',
  })

  const client = new Client(
    { name: 'agent-bridge-tests', version: '0.0.0' },
    { capabilities: {} },
  )

  console.log('▸ connecting to bridge subprocess…')
  await client.connect(transport)

  try {
    const list = await client.listTools()
    const toolNames = list.tools.map((t) => t.name).sort()
    console.log(`▸ tools advertised (${toolNames.length}):`)
    for (const n of toolNames) console.log(`    - ${n}`)

    // bridge_tools.name CHECK rejects dashes — auto-create + setup both
    // replace dashes with underscores to satisfy the regex.
    const safeBlankSlug = FIXTURE_BLANK_AGENT.slug.replace(/-/g, '_')
    const safeCodingSlug = FIXTURE_AGENT.slug.replace(/-/g, '_')
    const codingInspect = `${FIXTURE_AGENT.slug}__inspect_codebase`
    const codingAutoAsk = `${safeCodingSlug}__ask_agent`
    const blankAutoAsk = `${safeBlankSlug}__ask_agent`
    const blankInspect = `${FIXTURE_BLANK_AGENT.slug}__inspect_codebase`

    check(
      'coding helper has inspect_codebase (system built-in)',
      toolNames.includes(codingInspect),
      codingInspect,
    )
    check(
      'coding helper does NOT have auto-created ask_agent',
      !toolNames.includes(codingAutoAsk),
      `expected absent: ${codingAutoAsk}`,
    )
    check(
      'blank agent has ask_agent (auto-created bridge_tool)',
      toolNames.includes(blankAutoAsk),
      blankAutoAsk,
    )
    check(
      'blank agent does NOT have inspect_codebase',
      !toolNames.includes(blankInspect),
      `expected absent: ${blankInspect}`,
    )
  } finally {
    await client.close().catch(() => undefined)
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
  console.error('[bridge-registry-smoke] fatal:', err)
  process.exit(1)
})
