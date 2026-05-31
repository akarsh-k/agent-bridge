/**
 * Thread authorize-required smoke. Locks `runsRepo.getThreadAuthorizeRequiredConnections`,
 * which reconstructs the chat's "Reconnect" notice durably across a thread/tab
 * switch (where the reloaded Mastra messages carry no runId to key the per-run
 * lookup on). It returns the external-MCP connections THIS THREAD has used that
 * are still disconnected: any its runs flagged via `run.mcp.authorize_required`,
 * EXCEPT ones already reconnected since (the discover/reconnect bumps
 * `mcp_connections.updated_at` past the event, so we suppress them) or deleted.
 * Connection-level, not per-turn: it persists until reconnected, so the chat's
 * pinned reconnect bar survives a reload and the model giving up.
 *
 * DB-level, deterministic, no model / no Redis. Uses the test DB created by
 * `pnpm test:fixture:setup`.
 *
 * Run from repo root:
 *   pnpm test:thread-authorize-required
 */

/* eslint-disable no-console */

import { randomUUID } from 'node:crypto'

import { loadRootDotenv } from '@agent-bridge/shared/env'

loadRootDotenv(import.meta.url, { depth: 1 })

import { TEST_DB_NAME } from './fixture-config.js'

const baseDbUrl =
  process.env['DATABASE_URL'] ||
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = (() => {
  const u = new URL(baseDbUrl)
  u.pathname = `/${TEST_DB_NAME}`
  return u.toString()
})()
process.env['DATABASE_URL'] = testDbUrl

const dbMod = await import('@agent-bridge/db')
const { createDb, schema } = dbMod
const { eq } = await import('drizzle-orm')

// Soft binding so the smoke RUNS (granular failures) before the fix exists.
const getThreadAuth = (
  dbMod.runsRepo as {
    getThreadAuthorizeRequiredConnections?: (
      handle: ReturnType<typeof createDb>,
      mastraThreadId: string,
    ) => Promise<Array<{ connectionId: string; connectionName: string }>>
  }
).getThreadAuthorizeRequiredConnections

// ─── harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

console.log('━'.repeat(60))
console.log(' Thread authorize-required smoke')
console.log('━'.repeat(60))
console.log(`test DB: ${testDbUrl.replace(/:[^/]+@/, ':***@')}`)

const db = createDb({ connectionString: testDbUrl })

const now = Date.now()
const THREAD = randomUUID() // focal: thread has used TWO connections (A + C), both down
const THREAD_2 = randomUUID() // isolation check
const THREAD_3 = randomUUID() // earlier run needed E, latest run unrelated → E persists

const agentId = randomUUID()
const connA = randomUUID() // flagged by THREAD (earlier run), not reconnected → SHOWN
const connB = randomUUID() // flagged by THREAD, reconnected after → SUPPRESSED
const connC = randomUUID() // flagged by THREAD (later run), not reconnected → SHOWN
const connD = randomUUID() // THREAD_2's own connection (isolation)
const connE = randomUUID() // THREAD_3: flagged once, never reconnected → persists
const runThread1 = randomUUID() // THREAD: earlier run, flags A + B
const runThread2 = randomUUID() // THREAD: later run, flags C
const runOther = randomUUID() // THREAD_2: flags D
const runT3Flag = randomUUID() // THREAD_3: earlier run, flags E
const runT3Latest = randomUUID() // THREAD_3: latest run, UNRELATED (no flags)

async function safeCall(mastraThreadId: string): Promise<{
  ran: boolean
  rows: Array<{ connectionId: string; connectionName: string }>
}> {
  if (typeof getThreadAuth !== 'function') return { ran: false, rows: [] }
  try {
    return { ran: true, rows: await getThreadAuth(db, mastraThreadId) }
  } catch (e) {
    console.log('  (threw)', e instanceof Error ? e.message : String(e))
    return { ran: true, rows: [] }
  }
}

try {
  await db.db.insert(schema.agents).values({
    id: agentId,
    slug: `__thread-authreq-${process.pid}-${now}`,
    name: 'thread-authreq-smoke',
  })

  // A, C, D, E: last touched BEFORE the run flagged them → still need auth.
  // B: touched AFTER (a reconnect bumped updated_at) → suppress.
  await db.db.insert(schema.mcpConnections).values([
    {
      id: connA,
      name: 'Notion A',
      transport: 'sse',
      commandOrUrl: 'https://mcp.example/sse',
      authKind: 'oauth',
      updatedAt: new Date(now - 120_000),
    },
    {
      id: connB,
      name: 'Notion B',
      transport: 'sse',
      commandOrUrl: 'https://mcp.example/sse',
      authKind: 'oauth',
      updatedAt: new Date(now),
    },
    {
      id: connC,
      name: 'Notion C',
      transport: 'sse',
      commandOrUrl: 'https://mcp.example/sse',
      authKind: 'oauth',
      updatedAt: new Date(now - 120_000),
    },
    {
      id: connD,
      name: 'Notion D',
      transport: 'sse',
      commandOrUrl: 'https://mcp.example/sse',
      authKind: 'oauth',
      updatedAt: new Date(now - 120_000),
    },
    {
      id: connE,
      name: 'Notion E',
      transport: 'sse',
      commandOrUrl: 'https://mcp.example/sse',
      authKind: 'oauth',
      updatedAt: new Date(now - 120_000),
    },
  ])

  // Two runs in THREAD at different times; a connection ANY run left
  // disconnected counts, so both runThread1's A and runThread2's C return.
  await db.db.insert(schema.runs).values([
    {
      id: runThread1,
      agentId,
      streamId: `run:authreq-thread-1-${now}`,
      status: 'completed',
      inputPrompt: 'hi',
      startedAt: new Date(now - 70_000),
      mastraThreadId: THREAD,
    },
    {
      id: runThread2,
      agentId,
      streamId: `run:authreq-thread-2-${now}`,
      status: 'completed',
      inputPrompt: 'hi',
      startedAt: new Date(now - 10_000),
      mastraThreadId: THREAD,
    },
    {
      id: runOther,
      agentId,
      streamId: `run:authreq-other-${now}`,
      status: 'completed',
      inputPrompt: 'hi',
      startedAt: new Date(now - 70_000),
      mastraThreadId: THREAD_2,
    },
    {
      id: runT3Flag,
      agentId,
      streamId: `run:authreq-t3-flag-${now}`,
      status: 'completed',
      inputPrompt: 'hi',
      startedAt: new Date(now - 70_000),
      mastraThreadId: THREAD_3,
    },
    {
      id: runT3Latest,
      agentId,
      streamId: `run:authreq-t3-latest-${now}`,
      status: 'completed',
      inputPrompt: 'hi',
      startedAt: new Date(now - 10_000),
      mastraThreadId: THREAD_3,
    },
  ])

  const ev = (
    runId: string,
    connId: string,
    connName: string,
    tsMs: number,
  ) => ({
    runId,
    ts: new Date(tsMs),
    kind: 'run.mcp.authorize_required',
    payloadJson: { runId, connectionId: connId, connectionName: connName },
  })

  await db.db.insert(schema.runEvents).values([
    // THREAD earlier run flags A (twice → dedupe) and B (B is later reconnected).
    ev(runThread1, connA, 'Notion A', now - 60_000),
    ev(runThread1, connA, 'Notion A', now - 55_000),
    ev(runThread1, connB, 'Notion B', now - 60_000),
    // THREAD later run flags a SECOND connection C — both A and C must return.
    ev(runThread2, connC, 'Notion C', now - 8_000),
    // THREAD_2 single run flags D.
    ev(runOther, connD, 'Notion D', now - 60_000),
    // THREAD_3 earlier run flags E; its latest run emits nothing (model gave up),
    // but E was never reconnected, so it must STILL return.
    ev(runT3Flag, connE, 'Notion E', now - 60_000),
  ])

  // 0. The fix is wired up.
  check(
    'getThreadAuthorizeRequiredConnections is exported',
    typeof getThreadAuth === 'function',
  )

  const main = await safeCall(THREAD)
  check(
    'a thread with TWO connections down returns both (A + C), deduped',
    main.ran && main.rows.length === 2,
    `rows=${main.rows.map((r) => r.connectionName).join(',') || '(none)'}`,
  )
  check(
    'both A (earlier run) and C (later run) are present — ANY run counts',
    main.ran &&
      main.rows.some((r) => r.connectionId === connA) &&
      main.rows.some((r) => r.connectionId === connC),
    JSON.stringify(main.rows),
  )
  check(
    'a reconnected connection (updated_at after its event) is suppressed',
    main.ran && !main.rows.some((r) => r.connectionId === connB),
  )

  // The behaviour the user wants: an earlier run needed E, then the model "gave
  // up" so later turns emit nothing. E is still down, so the bar must persist.
  const persisted = await safeCall(THREAD_3)
  check(
    'a connection stays down after later unrelated turns (until reconnected)',
    persisted.ran &&
      persisted.rows.length === 1 &&
      persisted.rows[0]?.connectionId === connE,
    `rows=${persisted.rows.map((r) => r.connectionName).join(',') || '(none)'}`,
  )

  const other = await safeCall(THREAD_2)
  check(
    'thread isolation: the other thread returns its own connection (D)',
    other.ran &&
      other.rows.length === 1 &&
      other.rows[0]?.connectionId === connD,
    `rows=${other.rows.map((r) => r.connectionName).join(',') || '(none)'}`,
  )
} finally {
  await db.db.delete(schema.runs).where(eq(schema.runs.agentId, agentId))
  await db.db.delete(schema.agents).where(eq(schema.agents.id, agentId))
  for (const id of [connA, connB, connC, connD, connE]) {
    await db.db
      .delete(schema.mcpConnections)
      .where(eq(schema.mcpConnections.id, id))
  }
}

console.log('━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`   ✗ ${f}`)
  console.log('━'.repeat(60))
  process.exit(1)
}
console.log(' All checks passed.')
console.log('━'.repeat(60))
process.exit(0)
