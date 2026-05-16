/**
 * End-to-end smoke: skills attached to a blank agent reach the LLM.
 *
 * What this verifies:
 *   1. The fixture's blank agent has a skill (`FIXTURE_BLANK_SKILL`)
 *      that instructs the LLM to reply with the literal token
 *      `FIXTURE_BLANK_SKILL_TOKEN`.
 *   2. The bridge subprocess registers `<safeSlug>__ask_agent` for
 *      that agent (auto-created bridge_tool, prompt template `{{query}}`).
 *   3. Calling that tool via MCP runs the agent through the chat LLM.
 *   4. The response envelope's `prose_summary` contains the literal
 *      token — proving the skill was composed into the system prompt
 *      and the LLM honoured it.
 *   5. The bridge captured a Callsite for the run: client.name from the
 *      MCP `initialize` handshake, agent identity, tool name, valid
 *      timestamp; AND the caller prepended a `_Request origin: …_`
 *      metadata line to `runs.input_prompt` so the LLM saw provenance.
 *   6. The bridge-originated thread is filtered OUT of
 *      `listAgentThreads` — bridge runs belong in /logs, not in the
 *      chat-tab thread list.
 *
 * Requires a real chat LLM endpoint (the wrapper + bridge-registry
 * smokes don't need one because they never invoke the chat model).
 *
 * Required env (in addition to SMOKE_EMBEDDING_*):
 *   SMOKE_CHAT_URL    e.g. http://127.0.0.1:8080/v1
 *   SMOKE_CHAT_MODEL  e.g. <your-chat-model-id>
 *
 * Configure these in the repo-root `.env` (see `.env.example`). Then,
 * after `pnpm test:fixture:setup` has succeeded, run:
 *   pnpm test:fixture:skill
 */

/* eslint-disable no-console */

import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { createDb, schema } from '@agent-bridge/db'
import { listAgentThreads } from '@agent-bridge/agents'
import { callsiteSchema, type Callsite } from '@agent-bridge/shared'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import { desc, eq } from 'drizzle-orm'

// Load the repo-root .env so SMOKE_* vars resolve in preflight. tsx
// doesn't auto-load it from the tests workspace cwd.
loadRootDotenv(import.meta.url, { depth: 1 })

import {
  FIXTURE_BLANK_AGENT,
  FIXTURE_BLANK_SKILL_TOKEN,
  REPO_ROOT,
  TEST_DATA_DIR,
  TEST_DB_NAME,
} from './fixture-config.js'

/** MCP client identity sent on `initialize` — the bridge captures this
 *  via `getClientInfo()` and stamps it onto the run's callsite. The
 *  callsite check below asserts the round-trip preserved this exact
 *  string. */
const MCP_CLIENT_NAME = 'agent-bridge-tests-skill'

// ─── Pre-flight ─────────────────────────────────────────────────────────

function preflight(): { chatUrl: string; chatModel: string } {
  const chatUrl = process.env['SMOKE_CHAT_URL']
  const chatModel = process.env['SMOKE_CHAT_MODEL']
  const missing: string[] = []
  if (!chatUrl) missing.push('SMOKE_CHAT_URL')
  if (!chatModel) missing.push('SMOKE_CHAT_MODEL')
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `Point at a real chat LLM endpoint — this smoke actually invokes ` +
        `the model. Re-run \`pnpm test:fixture:setup\` with the same env ` +
        `so the seeded chat provider points at the right model.`,
    )
  }
  return { chatUrl: chatUrl!, chatModel: chatModel! }
}

const chat = preflight()

function swapDatabaseName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

const baseDbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = swapDatabaseName(baseDbUrl, TEST_DB_NAME)

const BRIDGE_ENTRY = path.join(REPO_ROOT, 'apps', 'mcp-bridge', 'src', 'index.ts')

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

async function main(): Promise<void> {
  console.log('═'.repeat(60))
  console.log(' Blank-agent skill smoke')
  console.log('═'.repeat(60))
  console.log(`test DB:    ${maskPassword(testDbUrl)}`)
  console.log(`data root:  ${TEST_DATA_DIR}`)
  console.log(`chat:       ${chat.chatUrl} (${chat.chatModel})`)
  console.log(`expected token: ${FIXTURE_BLANK_SKILL_TOKEN}`)
  console.log('')

  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--filter', 'mcp-bridge', 'exec', 'tsx', 'src/index.ts'],
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: testDbUrl,
      AGENT_BRIDGE_DATA_DIR: TEST_DATA_DIR,
    },
    cwd: REPO_ROOT,
    stderr: 'inherit',
  })

  const client = new Client(
    { name: MCP_CLIENT_NAME, version: '0.0.0' },
    { capabilities: {} },
  )

  console.log('▸ connecting to bridge subprocess…')
  await client.connect(transport)

  try {
    // Resolve the auto-created tool name (slug dashes → underscores).
    const safeSlug = FIXTURE_BLANK_AGENT.slug.replace(/-/g, '_')
    const toolName = `${safeSlug}__ask_agent`

    const list = await client.listTools()
    const advertised = list.tools.find((t) => t.name === toolName)
    check(
      'tool registered',
      advertised != null,
      advertised ? toolName : `MISSING ${toolName}`,
    )
    if (!advertised) return

    console.log(`▸ calling ${toolName} (this hits the chat LLM)…`)
    const startedAt = Date.now()
    const result = await client.callTool({
      name: toolName,
      arguments: {
        query: 'Hi! What is the capital of France?',
      },
    })
    const elapsedMs = Date.now() - startedAt
    console.log(`  ↳ returned in ${elapsedMs}ms`)

    if (result.isError) {
      check('call succeeded', false, JSON.stringify(result.content).slice(0, 200))
      return
    }

    // Pull the JSON envelope out of the MCP text content frame.
    const envelope = parseEnvelope(result)
    if (!envelope) {
      check('envelope parsed', false, 'no JSON text in MCP response')
      return
    }
    check('envelope has ok=true', envelope.ok === true, `ok=${envelope.ok}`)
    const prose: string =
      typeof envelope.prose_summary === 'string' ? envelope.prose_summary : ''
    console.log(
      `  ↳ prose_summary (${prose.length} chars): ${truncate(prose, 200)}`,
    )

    check(
      'prose_summary contains skill token',
      prose.includes(FIXTURE_BLANK_SKILL_TOKEN),
      `looking for "${FIXTURE_BLANK_SKILL_TOKEN}" in response`,
    )

    // ─── Callsite + thread-filter checks ────────────────────────────
    //
    // Open a separate AgentBridgeDb against the test DB so we can
    // (a) read the row the bridge just wrote and (b) call
    // `listAgentThreads` the same way the chat-tab does. The bridge
    // subprocess has its own pool; we don't share it.
    await runDbBackedChecks(toolName)
  } finally {
    await client.close().catch(() => undefined)
  }

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
 * Post-call DB inspections — split out so `main`'s control flow stays
 * focused on the MCP round-trip. Opens its own DB pool against the
 * test database, runs the two new checks, and always closes the pool.
 *
 * Failures here do NOT throw — they're recorded via `check()` so the
 * summary at the end of `main` shows pass/fail counts uniformly with
 * the MCP-side checks.
 */
async function runDbBackedChecks(expectedToolName: string): Promise<void> {
  const db = createDb({ connectionString: testDbUrl, maxConnections: 2 })
  try {
    // Resolve the blank agent's id by slug. The test fixture seeds
    // exactly one blank agent with this slug, so a single SELECT is
    // sufficient.
    const [agentRow] = await db.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.slug, FIXTURE_BLANK_AGENT.slug))
      .limit(1)
    if (!agentRow) {
      check(
        'fixture blank agent exists',
        false,
        `no agent row for slug "${FIXTURE_BLANK_AGENT.slug}" — re-run fixture setup`,
      )
      return
    }
    check('fixture blank agent exists', true, `agentId=${agentRow.id}`)

    // ── Check 5: callsite captured for the bridge run ──────────────
    //
    // The bridge just dispatched ONE tool call → exactly one new
    // bridge-source run for this agent. Take the most recent.
    const [runRow] = await db.db
      .select({
        id: schema.runs.id,
        streamId: schema.runs.streamId,
        inputPrompt: schema.runs.inputPrompt,
        bridgeToolName: schema.runs.bridgeToolName,
        callsiteJson: schema.runs.callsiteJson,
        mastraThreadId: schema.runs.mastraThreadId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentRow.id))
      .orderBy(desc(schema.runs.startedAt))
      .limit(1)
    if (!runRow) {
      check('most recent run exists', false, 'no rows in runs for this agent')
      return
    }
    check(
      'most recent run is bridge-sourced',
      runRow.streamId.startsWith('bridge:'),
      `streamId=${runRow.streamId}`,
    )
    check(
      'run.bridge_tool_name matches called tool',
      runRow.bridgeToolName === expectedToolName,
      `expected ${expectedToolName}, got ${runRow.bridgeToolName ?? 'null'}`,
    )

    const callsite = parseCallsite(runRow.callsiteJson)
    check(
      'callsite_json is populated',
      callsite !== null,
      callsite ? 'shape ok' : 'callsite_json is null or malformed',
    )
    if (callsite) {
      check(
        'callsite.client.name preserved from MCP initialize handshake',
        callsite.client?.name === MCP_CLIENT_NAME,
        `expected ${MCP_CLIENT_NAME}, got ${callsite.client?.name ?? '(missing)'}`,
      )
      check(
        'callsite.agent.slug matches fixture blank agent',
        callsite.agent?.slug === FIXTURE_BLANK_AGENT.slug,
        `expected ${FIXTURE_BLANK_AGENT.slug}, got ${callsite.agent?.slug ?? '(missing)'}`,
      )
      check(
        'callsite.tool.name matches called tool',
        callsite.tool?.name === expectedToolName,
        `expected ${expectedToolName}, got ${callsite.tool?.name ?? '(missing)'}`,
      )
      check(
        'callsite.started_at is a valid ISO datetime',
        typeof callsite.started_at === 'string' &&
          !Number.isNaN(Date.parse(callsite.started_at)),
        `started_at=${callsite.started_at ?? '(missing)'}`,
      )
    }

    check(
      'caller prepended Request-origin metadata to input_prompt',
      runRow.inputPrompt.trimStart().startsWith('_Request origin:'),
      `input_prompt[0..60]="${runRow.inputPrompt.slice(0, 60).replace(/\n/g, '\\n')}"`,
    )

    // ── Check 6: bridge thread filtered out of chat-tab list ────────
    //
    // `listAgentThreads` is the helper the chat tab calls to populate
    // its thread sidebar. Bridge runs SHOULD NOT appear here (they're
    // tool invocations, not conversations); /logs is the right surface.
    if (runRow.mastraThreadId) {
      const threads = await listAgentThreads(db, agentRow.id)
      const bridgeThreadVisible = threads.some(
        (t) => t.threadId === runRow.mastraThreadId,
      )
      check(
        'bridge thread is filtered out of listAgentThreads',
        !bridgeThreadVisible,
        bridgeThreadVisible
          ? `LEAK: thread ${runRow.mastraThreadId} appeared in chat-tab list`
          : `bridge thread ${runRow.mastraThreadId} correctly hidden (${threads.length} chat threads)`,
      )
    } else {
      // Memory-disabled agents never create a Mastra thread row, so
      // there's nothing to filter. Skip without failing — record the
      // skip so the test output shows we considered it.
      check(
        'bridge thread filter check (skipped)',
        true,
        'agent has memory disabled — no mastra_thread_id to test',
      )
    }
  } finally {
    await db.close()
  }
}

interface EnvelopeShape {
  readonly ok?: unknown
  readonly prose_summary?: unknown
  readonly mini_repos?: unknown
  readonly warnings?: unknown
}

function parseEnvelope(result: unknown): EnvelopeShape | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { content?: unknown }
  if (!Array.isArray(r.content)) return null
  for (const part of r.content) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === 'text' && typeof p.text === 'string') {
      try {
        return JSON.parse(p.text) as EnvelopeShape
      } catch {
        // Not JSON — keep looking.
      }
    }
  }
  return null
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/**
 * Coerce the raw `runs.callsite_json` JSONB cell into a typed Callsite,
 * mirroring `apps/backend/src/routes/runs.ts:parseCallsite`. Returns
 * null on bad shapes so the calling check() reports a clean miss
 * rather than crashing with a Zod throw.
 */
function parseCallsite(raw: unknown): Callsite | null {
  if (raw === null || raw === undefined) return null
  const result = callsiteSchema.safeParse(raw)
  return result.success ? result.data : null
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
  console.error('[skill-smoke] fatal:', err)
  process.exit(1)
})
