/**
 * Bridge-registry smoke. Spawns `apps/mcp-bridge/src/index.ts` as a
 * subprocess pointed at the test DB + test data root, connects via
 * stdio MCP, lists tools, and asserts the per-kind built-in surface:
 *
 *   - Repo-inspector fixture (`fixture-ecommerce`):
 *       <slug>__inspect_codebase ONLY (no ask_agent)
 *   - Blank fixture         (`fixture-blank`):
 *       <slug>__ask_agent ONLY (no inspect_codebase)
 *
 * Also exercises wire-level scenarios on `inspect_codebase`:
 *
 *   - Clarification short-circuit (no LLM): an unmatched repo_hint
 *     against the 3-repo fixture returns a `clarification` envelope
 *     with pre-baked `suggested_replies`. No run dispatched.
 *
 *   - When `SMOKE_CHAT_URL` + `SMOKE_CHAT_MODEL` are set, run full
 *     `inspect_codebase` calls and assert:
 *       - default envelope OMITS `agent_repos` / `repo_relationships`
 *       - envelope INCLUDES `next_actions` when focal repo has relationships
 *       - `with_topology: true` brings `agent_repos` / `repo_relationships` back
 *       - structured `remote_url` hint resolves with
 *         `matched_signal: 'remote_url'`
 *
 * Run after `pnpm test:fixture:setup` succeeds. Same env requirements
 * as the existing smoke (`SMOKE_EMBEDDING_*`).
 */

/* eslint-disable no-console */

import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { loadRootDotenv } from '@agent-bridge/shared/env'

// Load the repo-root .env so SMOKE_CHAT_* vars resolve for the optional
// LLM-dispatching scenarios below. Same pattern smoke-fixture.ts uses.
loadRootDotenv(import.meta.url, { depth: 1 })

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
      'repo inspector has inspect_codebase (system built-in)',
      toolNames.includes(codingInspect),
      codingInspect,
    )
    check(
      'repo inspector does NOT have auto-created ask_agent',
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

    // Clarification short-circuit does NOT dispatch a run — the bridge
    // returns the picker envelope synchronously. Safe to run without a
    // chat LLM. Tests the wire shape of `clarification.*` directly.
    await assertClarificationShortCircuit(client, codingInspect)

    // End-to-end envelope check. Requires a real chat endpoint —
    // `inspect_codebase` dispatches a full Mastra run, so a placeholder
    // chat provider won't do. Skip cleanly when the env vars are unset
    // so the smoke stays runnable with embedder-only setups.
    const chatUrl = process.env['SMOKE_CHAT_URL']?.trim()
    const chatModel = process.env['SMOKE_CHAT_MODEL']?.trim()
    if (chatUrl && chatModel) {
      await assertDefaultEnvelopeFocused(client, codingInspect)
      await assertWithTopologyEnvelope(client, codingInspect)
      await assertRemoteUrlPreResolution(client, codingInspect)
    } else {
      console.log(
        '⚠ skipping LLM-dispatching envelope checks — set SMOKE_CHAT_URL + SMOKE_CHAT_MODEL to enable',
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
 * Read + JSON-parse the bridge's envelope payload from a `callTool`
 * response. Returns `null` and emits a failing `check(...)` row when the
 * content shape is wrong or the JSON is malformed; callers should
 * short-circuit on a `null` return so subsequent assertions don't
 * cascade-fail.
 */
function parseEnvelope(
  res: unknown,
  label: string,
): Record<string, unknown> | null {
  const content = Array.isArray((res as { content?: unknown })?.content)
    ? ((res as { content: unknown[] }).content)
    : []
  const first = content[0] as { type?: string; text?: unknown } | undefined
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    check(
      `${label}: returned a text envelope`,
      false,
      `unexpected content shape: ${JSON.stringify(content).slice(0, 200)}`,
    )
    return null
  }
  try {
    return JSON.parse(first.text) as Record<string, unknown>
  } catch (err) {
    check(
      `${label}: envelope is valid JSON`,
      false,
      `${err instanceof Error ? err.message : String(err)}; head=${first.text.slice(0, 120)}`,
    )
    return null
  }
}

/**
 * Pass an unmatched repo_hint to the 3-repo fixture and verify the
 * bridge returns a `clarification` envelope WITHOUT dispatching a run.
 *
 * This path is LLM-free: the bridge handler resolves the hint
 * pre-dispatch, sees a multi-repo agent with no matching candidate,
 * and short-circuits with `{clarification: {...}, agent_repos,
 * repo_relationships}`. The wire envelope is the only thing under test.
 */
async function assertClarificationShortCircuit(
  client: Client,
  toolName: string,
): Promise<void> {
  const res = await client.callTool({
    name: toolName,
    arguments: {
      query: 'anything — should not reach the LLM',
      repo_hint: 'definitely-not-a-real-repo',
    },
  })
  const envelope = parseEnvelope(res, 'clarification short-circuit')
  if (!envelope) return

  const clarification = envelope['clarification'] as
    | { kind?: unknown; candidates?: unknown; suggested_replies?: unknown }
    | undefined
  check(
    'clarification.kind = repo_or_all',
    clarification?.kind === 'repo_or_all',
    `kind=${String(clarification?.kind ?? '(missing)')}`,
  )
  const candidates = Array.isArray(clarification?.candidates)
    ? (clarification!.candidates as Array<Record<string, unknown>>)
    : []
  check(
    'clarification.candidates lists all 3 fixture repos',
    candidates.length === 3,
    `count=${candidates.length}`,
  )
  const replies = Array.isArray(clarification?.suggested_replies)
    ? (clarification!.suggested_replies as Array<Record<string, unknown>>)
    : []
  const repliesShape =
    replies.length === 3 &&
    replies.every(
      (r) =>
        typeof r['label'] === 'string' &&
        typeof r['args_patch'] === 'object' &&
        r['args_patch'] !== null &&
        typeof (r['args_patch'] as Record<string, unknown>)['repo_hint'] ===
          'string',
    )
  check(
    'clarification.suggested_replies[*] = {label, args_patch.repo_hint}',
    repliesShape,
    repliesShape ? 'shape ok' : `first=${JSON.stringify(replies[0]).slice(0, 120)}`,
  )
  // Clarification short-circuits, so no wrapper ran. The envelope MUST
  // carry an empty codebase_inspection_reports[] and MUST NOT carry prose_summary (which
  // would imply chit-chat fallback after a real run).
  check(
    'clarification short-circuit: codebase_inspection_reports is empty',
    Array.isArray(envelope['codebase_inspection_reports']) &&
      (envelope['codebase_inspection_reports'] as unknown[]).length === 0,
    `codebase_inspection_reports=${JSON.stringify(envelope['codebase_inspection_reports']).slice(0, 80)}`,
  )
  check(
    'clarification short-circuit: no prose_summary field',
    envelope['prose_summary'] === undefined,
    `prose_summary=${String(envelope['prose_summary'])}`,
  )
}

/**
 * Default call (no `with_topology`) → expect topology fields OMITTED
 * and `next_actions[]` present when the focal repo has cross-repo
 * edges. Dispatches a real run, so requires SMOKE_CHAT_*.
 */
async function assertDefaultEnvelopeFocused(
  client: Client,
  toolName: string,
): Promise<void> {
  const res = await client.callTool({
    name: toolName,
    arguments: {
      // Pre-resolve to `backend` via remote_url. Backend has 2 incoming
      // edges (frontend --calls-->, shared --type-mirror-->) so the
      // bridge should compute ≥1 next_action.
      query: 'list the files in this repo',
      remote_url: 'fixture://ecommerce-backend',
    },
  })
  const envelope = parseEnvelope(res, 'default envelope')
  if (!envelope) return

  check(
    'default envelope: agent_repos OMITTED',
    envelope['agent_repos'] === undefined,
    `agent_repos=${String(envelope['agent_repos'])}`,
  )
  check(
    'default envelope: repo_relationships OMITTED',
    envelope['repo_relationships'] === undefined,
    `repo_relationships=${String(envelope['repo_relationships'])}`,
  )
  const resolved = envelope['resolved_repo'] as
    | { label?: unknown; matched_signal?: unknown }
    | undefined
  check(
    'default envelope: resolved_repo.label = backend',
    resolved?.label === 'backend',
    `label=${String(resolved?.label)}`,
  )
  check(
    'default envelope: resolved_repo.matched_signal = remote_url',
    resolved?.matched_signal === 'remote_url',
    `matched_signal=${String(resolved?.matched_signal)}`,
  )
  const nextActions = Array.isArray(envelope['next_actions'])
    ? (envelope['next_actions'] as Array<Record<string, unknown>>)
    : []
  check(
    'default envelope: next_actions has ≥1 entry',
    nextActions.length >= 1,
    `count=${nextActions.length}`,
  )
  // Mixed-kind envelope; only `cross_repo` carries
  // `args_patch.{repo_hint, remote_url}`. Fixture seeds edges, so we
  // expect ≥1 cross_repo entry.
  const crossRepoEntries = nextActions.filter((a) => a['kind'] === 'cross_repo')
  check(
    'next_actions: includes ≥1 cross_repo entry from seeded edges',
    crossRepoEntries.length >= 1,
    `cross_repo_count=${crossRepoEntries.length}`,
  )
  const crossRepoWellFormed = crossRepoEntries.every((a) => {
    const patch = a['args_patch'] as Record<string, unknown> | undefined
    return (
      typeof patch?.['repo_hint'] === 'string' &&
      typeof patch?.['remote_url'] === 'string'
    )
  })
  check(
    'next_actions[kind=cross_repo].args_patch carries BOTH repo_hint and remote_url',
    crossRepoWellFormed,
    `first=${JSON.stringify(crossRepoEntries[0]).slice(0, 200)}`,
  )
}

/**
 * `with_topology: true` → expect `agent_repos` + `repo_relationships` to come
 * back as in the pre-change behavior, AND `next_actions` still present.
 * Same fixture seeds 3 repos + 2 relationships; we re-check both connectors.
 */
async function assertWithTopologyEnvelope(
  client: Client,
  toolName: string,
): Promise<void> {
  const res = await client.callTool({
    name: toolName,
    arguments: {
      query: 'list the files in this repo',
      remote_url: 'fixture://ecommerce-backend',
      with_topology: true,
    },
  })
  const envelope = parseEnvelope(res, 'with_topology envelope')
  if (!envelope) return

  const repos = Array.isArray(envelope['agent_repos'])
    ? (envelope['agent_repos'] as Array<Record<string, unknown>>)
    : null
  check(
    'with_topology: agent_repos lists all 3 fixture repos',
    repos !== null && repos.length === 3,
    repos === null ? 'missing' : `count=${repos.length}`,
  )

  const relationships = Array.isArray(envelope['repo_relationships'])
    ? (envelope['repo_relationships'] as Array<Record<string, unknown>>)
    : null
  const connectors = relationships
    ? relationships.map((e) => String(e['connector'] ?? '')).sort()
    : []
  check(
    'with_topology: repo_relationships includes both seeded fixture relationships',
    relationships !== null &&
      relationships.length === 2 &&
      connectors.includes('calls') &&
      connectors.includes('type-mirror'),
    relationships === null ? 'missing' : `connectors=[${connectors.join(', ')}]`,
  )
  // next_actions should still be computed alongside the full topology.
  check(
    'with_topology: next_actions still present',
    Array.isArray(envelope['next_actions']) &&
      (envelope['next_actions'] as unknown[]).length >= 1,
    `next_actions=${JSON.stringify(envelope['next_actions']).slice(0, 120)}`,
  )
}

/**
 * Pass `remote_url` only (no other hint) and verify the bridge's
 * pre-resolver picks the right repo with `matched_signal: 'remote_url'`.
 * Mirrors the production failure mode the user originally hit (Cursor
 * passes `git remote get-url origin`, we want to use it directly).
 */
async function assertRemoteUrlPreResolution(
  client: Client,
  toolName: string,
): Promise<void> {
  const res = await client.callTool({
    name: toolName,
    arguments: {
      query: 'what files are here',
      remote_url: 'fixture://ecommerce-frontend',
    },
  })
  const envelope = parseEnvelope(res, 'remote_url pre-resolution')
  if (!envelope) return

  const resolved = envelope['resolved_repo'] as
    | { repo_id?: unknown; label?: unknown; matched_signal?: unknown }
    | undefined
  check(
    'remote_url pre-resolution: resolved to frontend',
    resolved?.label === 'frontend',
    `label=${String(resolved?.label)}`,
  )
  check(
    'remote_url pre-resolution: matched_signal=remote_url',
    resolved?.matched_signal === 'remote_url',
    `matched_signal=${String(resolved?.matched_signal)}`,
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
