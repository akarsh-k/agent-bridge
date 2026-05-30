/**
 * Lazy-MCP real-model E2E. Dev-only, like `smoke.ts` — talks to a REAL model
 * over the wire. It does NOT mock the LLM; the whole point is to verify the
 * model's decision to call a tool flows through the lazy proxy correctly.
 *
 * What it does (all against a throwaway, auto-cleaned-up seed):
 *   1. Seeds a fake stdio MCP connection (a tiny `echo` server in
 *      `fixtures/fake-mcp-echo.mjs`) onto the given agent, and writes its
 *      tool catalog so the connection mounts LAZILY (proxy tools, no socket).
 *   2. `buildAgent(...)` → asserts the fake server is NOT spawned at build
 *      time (the marker file stays absent): building the agent, and the model
 *      merely seeing the tool, costs no connection.
 *   3. Runs the REAL model with a tool-triggering prompt → asserts the server
 *      spawned (the connection opened on demand) and the echoed value reached
 *      the model.
 *   4. Runs the REAL model (fresh build) with a non-tool prompt → asserts the
 *      server never spawned: no connection unless the model actually calls the
 *      tool. This is the "no Reconnect prompt unless the LLM decides to call
 *      it" guarantee, end to end with a real model.
 *   5. Deletes the seed (the connection cascade-drops its catalog + the
 *      agent's allowlist row).
 *
 * The deterministic mechanics live in `tests/smoke-lazy-mcp.ts`
 * (`pnpm test:lazy-mcp`); this one needs a working provider on the agent.
 *
 * Run:
 *   pnpm --filter @agent-bridge/agents smoke:lazy-mcp --agent <slug-or-uuid>
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDb, schema } from '@agent-bridge/db'
import { eq, like } from 'drizzle-orm'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import { buildAgent } from '../src/build-agent.js'

loadRootDotenv(import.meta.url)

const DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'

const { values } = parseArgs({
  options: {
    agent: { type: 'string', short: 'a' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

if (values.help || !values.agent?.trim()) {
  console.info(
    [
      'Usage: pnpm --filter @agent-bridge/agents smoke:lazy-mcp --agent <slug-or-uuid>',
      '',
      'Seeds a fake stdio MCP (cataloged → lazy) onto the agent, runs the REAL',
      'model twice (a tool-triggering prompt and a non-tool prompt), and asserts',
      'the connection opens ONLY when the model calls the tool. Auto-cleans up.',
      'Needs a working LLM provider configured on the agent.',
    ].join('\n'),
  )
  process.exit(values.agent ? 0 : 1)
}

const AGENT_REF = values.agent.trim()
const FAKE_SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-mcp-echo.mjs',
)
const NAME_PREFIX = '__lazy-mcp-e2e-'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(`${name}${diag ? ` — ${diag}` : ''}`)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

function clearMarker(marker: string): void {
  rmSync(marker, { force: true })
}

function extractText(result: any): string {
  if (typeof result?.text === 'string') return result.text
  const content = result?.response?.content ?? result?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: { text?: string }) =>
        typeof p?.text === 'string' ? p.text : '',
      )
      .join('')
  }
  return ''
}

async function resolveAgentId(
  db: ReturnType<typeof createDb>,
  ref: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref
  const [row] = await db.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.slug, ref))
    .limit(1)
  if (!row) {
    throw new Error(`No agent found for slug "${ref}". Pass a UUID directly.`)
  }
  return row.id
}

async function main(): Promise<void> {
  console.log('━'.repeat(60))
  console.log(' Lazy-MCP real-model E2E')
  console.log('━'.repeat(60))

  const db = createDb({ connectionString: DATABASE_URL, maxConnections: 5 })
  const connId = randomUUID()
  const marker = join(tmpdir(), `lazy-mcp-marker-${connId}.txt`)

  try {
    const agentId = await resolveAgentId(db, AGENT_REF)
    console.log(`[seed] agent "${AGENT_REF}" → ${agentId}`)

    // Drop any seed left behind by a crashed prior run.
    await db.db
      .delete(schema.mcpConnections)
      .where(like(schema.mcpConnections.name, `${NAME_PREFIX}%`))

    // 1. Seed: a stdio connection running the fake echo server, plus its tool
    //    catalog so the mount goes LAZY rather than eager.
    await db.db.insert(schema.mcpConnections).values({
      id: connId,
      name: `${NAME_PREFIX}${connId.slice(0, 8)}__`,
      transport: 'stdio',
      commandOrUrl: process.execPath,
      argsJson: [FAKE_SERVER, marker],
      authKind: 'none',
      allowHostHome: false,
    })
    await db.db.insert(schema.mcpConnectionTools).values({
      mcpConnectionId: connId,
      toolName: 'echo',
      description: 'Echo back the provided text verbatim.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    })
    await db.db.insert(schema.agentMcpTools).values({
      agentId,
      mcpConnectionId: connId,
      toolName: 'echo',
      enabled: true,
    })
    console.log('[seed] fake echo MCP attached + cataloged (lazy)\n')

    // 2. Build → lazy mount must not spawn the server.
    clearMarker(marker)
    let built = await buildAgent({ db, agentId, disableGitnexus: true })
    try {
      check(
        'building the agent does NOT spawn the MCP server (lazy mount)',
        !existsSync(marker),
        `marker present=${existsSync(marker)}`,
      )

      // 3. Tool-triggering prompt → the model calls echo → the server spawns.
      clearMarker(marker)
      const r1 = await built.agent.generate(
        'Use the echo tool to echo the exact word: pineapple. ' +
          'Then tell me, in one short sentence, what the tool returned.',
      )
      const t1 = extractText(r1)
      check(
        'a tool-triggering prompt opens the connection (server spawned)',
        existsSync(marker),
        `marker present=${existsSync(marker)}`,
      )
      check(
        'the echo tool actually ran and its result reached the model',
        /pineapple/i.test(t1),
        `reply="${t1.slice(0, 100).replace(/\s+/g, ' ')}"`,
      )
    } finally {
      await built.disconnect().catch(() => {})
    }

    // 4. Non-tool prompt on a FRESH build (fresh lazy manager) → no spawn.
    clearMarker(marker)
    built = await buildAgent({ db, agentId, disableGitnexus: true })
    try {
      const r2 = await built.agent.generate(
        'What is 2 plus 2? Reply with just the number. Do not use any tools.',
      )
      const t2 = extractText(r2)
      check(
        'a non-tool prompt never opens the connection (no spawn, no auth prompt)',
        !existsSync(marker),
        `marker present=${existsSync(marker)} reply="${t2.slice(0, 40).replace(/\s+/g, ' ')}"`,
      )
    } finally {
      await built.disconnect().catch(() => {})
    }
  } finally {
    // Remove the seed (cascades to catalog + allowlist) and the marker.
    try {
      await db.db
        .delete(schema.mcpConnections)
        .where(eq(schema.mcpConnections.id, connId))
    } catch {
      // best-effort cleanup
    }
    clearMarker(marker)
    await db.close()
  }

  console.log('━'.repeat(60))
  console.log(` Passed: ${passed}/${passed + failed}`)
  if (failed > 0) {
    console.log(' Failed:')
    for (const f of failures) console.log(`   ✗ ${f}`)
    console.log('━'.repeat(60))
    process.exitCode = 1
  } else {
    console.log(' All checks passed.')
    console.log('━'.repeat(60))
  }
}

main().catch((err) => {
  console.error('[lazy-mcp-e2e] fatal:', err)
  process.exit(1)
})
