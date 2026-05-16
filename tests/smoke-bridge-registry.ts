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
 * Additionally, when `SMOKE_CHAT_URL` + `SMOKE_CHAT_MODEL` are set,
 * round-trips a `callTool` against the coding helper's inspect tool
 * and asserts the wire envelope carries `agent_repos` + `repo_edges`
 * (so the IDE can offer "ask about the connected repo too" follow-ups
 * without a separate inventory call).
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

    // End-to-end envelope check. Requires a real chat endpoint —
    // `inspect_codebase` dispatches a full Mastra run, so a placeholder
    // chat provider won't do. Skip cleanly when the env vars are unset
    // so the smoke stays runnable with embedder-only setups.
    const chatUrl = process.env['SMOKE_CHAT_URL']?.trim()
    const chatModel = process.env['SMOKE_CHAT_MODEL']?.trim()
    if (chatUrl && chatModel) {
      await assertInspectCodebaseEnvelope(client, codingInspect)
    } else {
      console.log(
        '⚠ skipping inspect_codebase envelope check — set SMOKE_CHAT_URL + SMOKE_CHAT_MODEL to enable',
      )
    }
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

/**
 * Round-trip the `<slug>__inspect_codebase` MCP tool and validate that
 * the bridge envelope now carries `agent_repos` + `repo_edges` so the
 * IDE can offer "ask about the connected repo too" follow-ups without
 * a separate inventory call.
 *
 * The query is intentionally trivial — we don't care which wrappers the
 * agent's LLM chooses to call; the topology fields are added at the
 * envelope layer regardless of wrapper activity.
 */
async function assertInspectCodebaseEnvelope(
  client: Client,
  toolName: string,
): Promise<void> {
  const res = await client.callTool({
    name: toolName,
    arguments: { query: 'list the repos you have access to' },
  })

  const content = Array.isArray(res.content) ? res.content : []
  const first = content[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    check(
      'inspect_codebase returned a text envelope',
      false,
      `unexpected content shape: ${JSON.stringify(content).slice(0, 200)}`,
    )
    return
  }

  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(first.text) as Record<string, unknown>
  } catch (err) {
    check(
      'inspect_codebase envelope is valid JSON',
      false,
      `${err instanceof Error ? err.message : String(err)}; head=${first.text.slice(0, 120)}`,
    )
    return
  }

  if (envelope['ok'] !== true) {
    check(
      'inspect_codebase returned ok=true',
      false,
      `envelope=${JSON.stringify(envelope).slice(0, 300)}`,
    )
    return
  }

  const repos = Array.isArray(envelope['agent_repos'])
    ? (envelope['agent_repos'] as Array<Record<string, unknown>>)
    : null
  const repoLabels = repos
    ? repos.map((r) => String(r['label'] ?? '')).sort()
    : []
  check(
    'envelope.agent_repos lists all 3 fixture repos',
    repos !== null && repoLabels.length === 3,
    repos === null
      ? 'agent_repos missing or not an array'
      : `labels=[${repoLabels.join(', ')}]`,
  )

  const edges = Array.isArray(envelope['repo_edges'])
    ? (envelope['repo_edges'] as Array<Record<string, unknown>>)
    : null
  const connectors = edges
    ? edges.map((e) => String(e['connector'] ?? '')).sort()
    : []
  // Fixture seeds two edges: frontend->backend (calls), shared->backend
  // (type-mirror). Check both connectors are present rather than length
  // alone so a stale fixture surfaces the right error.
  const hasCalls = connectors.includes('calls')
  const hasTypeMirror = connectors.includes('type-mirror')
  check(
    'envelope.repo_edges includes the two seeded fixture edges',
    edges !== null && edges.length === 2 && hasCalls && hasTypeMirror,
    edges === null
      ? 'repo_edges missing or not an array'
      : `connectors=[${connectors.join(', ')}]`,
  )
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
