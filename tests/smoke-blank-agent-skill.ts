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
 *
 * Requires a real chat LLM endpoint (the wrapper + bridge-registry
 * smokes don't need one because they never invoke the chat model).
 *
 * Required env (in addition to SMOKE_EMBEDDING_*):
 *   SMOKE_CHAT_URL    e.g. http://127.0.0.1:8080/v1
 *   SMOKE_CHAT_MODEL  e.g. <your-chat-model-id>
 *
 * Run after `pnpm test:fixture:setup` succeeded with the same env:
 *   SMOKE_CHAT_URL=… SMOKE_CHAT_MODEL=… pnpm test:fixture:setup
 *   SMOKE_CHAT_URL=… SMOKE_CHAT_MODEL=… pnpm test:fixture:skill
 */

/* eslint-disable no-console */

import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  FIXTURE_BLANK_AGENT,
  FIXTURE_BLANK_SKILL_TOKEN,
  REPO_ROOT,
  TEST_DATA_DIR,
  TEST_DB_NAME,
} from './fixture-config.js'

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
    { name: 'agent-bridge-tests-skill', version: '0.0.0' },
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
