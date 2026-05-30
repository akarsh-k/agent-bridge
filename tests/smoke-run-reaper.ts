/**
 * Run-reaper smoke. Locks the watchdog's ACTIVITY-BASED reaping
 * (`runsRepo.reapStaleRunningRuns`). The invariant that matters most: a run is
 * reaped only when it has made NO PROGRESS (emitted no `run_events`) for the
 * window AND started before it. So a legitimately long, actively-streaming run
 * is NEVER reaped mid-stream — which would otherwise flip it to `error` and,
 * because `markCompleted` is CAS-guarded on `status='running'`, silently
 * DISCARD its finished answer. Crashed/stalled dispatches ARE reaped.
 *
 * DB-level, deterministic (<2s), no model / no Redis. Uses the test DB created
 * by `pnpm test:fixture:setup`.
 *
 * Run from repo root:
 *   pnpm test:run-reaper
 *
 * If the test DB doesn't exist yet:
 *   pnpm test:fixture:setup   # creates + migrates `agentbridge_test`
 */

/* eslint-disable no-console */

import { loadRootDotenv } from '@agent-bridge/shared/env'

loadRootDotenv(import.meta.url, { depth: 1 })

import { TEST_DB_NAME } from './fixture-config.js'

// ── Test-DB env override (BEFORE any db import) ────────────────────────────

const baseDbUrl =
  process.env['DATABASE_URL'] ||
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = (() => {
  const u = new URL(baseDbUrl)
  u.pathname = `/${TEST_DB_NAME}`
  return u.toString()
})()
process.env['DATABASE_URL'] = testDbUrl

const { createDb, runsRepo, schema } = await import('@agent-bridge/db')
const { eq } = await import('drizzle-orm')

// ── harness ────────────────────────────────────────────────────────────────

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
console.log(' Run-reaper (activity-based) smoke')
console.log('━'.repeat(60))
console.log(`test DB: ${testDbUrl.replace(/:[^/]+@/, ':***@')}`)

const db = createDb({ connectionString: testDbUrl })

const WINDOW_MS = 60_000
const now = Date.now()
const OLD = new Date(now - 10 * 60_000) // 10 min ago — well past the window
const FRESH = new Date(now - 5_000) // 5s ago — inside the window

// Throwaway agent so the runs satisfy their agent_id FK.
const [agent] = await db.db
  .insert(schema.agents)
  .values({
    slug: `__reaper-smoke-${process.pid}-${now}`,
    name: 'reaper-smoke',
  })
  .returning()
if (!agent) {
  console.error('failed to seed agent; aborting')
  process.exit(1)
}
const agentId = agent.id

async function seedRun(
  label: string,
  status: 'running' | 'pending' | 'completed',
  startedAt: Date,
): Promise<{ id: string }> {
  const [row] = await db.db
    .insert(schema.runs)
    .values({
      agentId,
      streamId: `run:reaper-${label}-${now}`,
      status,
      inputPrompt: 'hi',
      startedAt,
    })
    .returning({ id: schema.runs.id })
  if (!row) {
    console.error(`failed to seed run ${label}; aborting`)
    process.exit(1)
  }
  return row
}

async function statusOf(id: string): Promise<{
  status?: string
  finishedAt?: Date | null
  errorMessage?: string | null
}> {
  const [row] = await db.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, id))
  return row ?? {}
}

try {
  const A = await seedRun('A-stale', 'running', OLD) // old + no events → reaped
  const B = await seedRun('B-active', 'running', OLD) // old + recent event → spared
  const C = await seedRun('C-fresh', 'running', FRESH) // fresh → spared
  const D = await seedRun('D-pending', 'pending', OLD) // old pending + no events → reaped
  const E = await seedRun('E-done', 'completed', OLD) // terminal → untouched

  // B is actively streaming: a run_event INSIDE the window.
  await db.db.insert(schema.runEvents).values({
    runId: B.id,
    ts: new Date(now - 1_000), // 1s ago — inside the window
    kind: 'run.token',
    payloadJson: { text: 'streaming' },
  })

  const reaped = await runsRepo.reapStaleRunningRuns(db, WINDOW_MS)
  // The shared test DB may hold other stale rows, so assert ">= our 2".
  check(
    'reaper reports at least our 2 stale runs reaped',
    reaped >= 2,
    `reaped=${reaped}`,
  )

  const a = await statusOf(A.id)
  check(
    'stale running run (no recent events) → error',
    a.status === 'error',
    `status=${a.status}`,
  )
  check(
    'reaped run is stamped finished_at + error_message',
    a.finishedAt instanceof Date &&
      typeof a.errorMessage === 'string' &&
      (a.errorMessage?.length ?? 0) > 0,
  )

  const b = await statusOf(B.id)
  check(
    'actively-streaming long run (recent event) → SPARED (the result-loss fix)',
    b.status === 'running',
    `status=${b.status}`,
  )

  const c = await statusOf(C.id)
  check(
    'fresh run (started inside the window) → spared',
    c.status === 'running',
    `status=${c.status}`,
  )

  const d = await statusOf(D.id)
  check(
    'stuck pending run (old, no events) → error',
    d.status === 'error',
    `status=${d.status}`,
  )

  const e = await statusOf(E.id)
  check(
    'already-terminal run is left untouched',
    e.status === 'completed',
    `status=${e.status}`,
  )

  // Idempotent for the SPARES: a second sweep must not touch the active/fresh
  // runs (they keep streaming / stay young).
  await runsRepo.reapStaleRunningRuns(db, WINDOW_MS)
  const b2 = await statusOf(B.id)
  const c2 = await statusOf(C.id)
  check(
    'second sweep still spares the active + fresh runs',
    b2.status === 'running' && c2.status === 'running',
    `B=${b2.status} C=${c2.status}`,
  )
} finally {
  // run_events cascade-delete with runs; delete our runs then the agent.
  await db.db.delete(schema.runs).where(eq(schema.runs.agentId, agentId))
  await db.db.delete(schema.agents).where(eq(schema.agents.id, agentId))
}

console.log('\n' + '━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(' All checks passed.')
console.log('━'.repeat(60))
process.exit(0)
