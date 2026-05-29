/**
 * Worker-jobs smoke. Locks down invariants that have regressed before:
 *
 *   1. Boot reapers wipe stale `worker_jobs` rows at status='running'
 *      and reset stuck repos in transitional statuses.
 *   2. CAS state-machine guards on `markCloning` / `markPulling` /
 *      `markIndexing` accept the documented prior states and reject
 *      the wrong ones.
 *   3. `looksLikeFatalLine` and `looksLikeEmbedPhase` heuristics
 *      classify representative gitnexus stderr lines correctly.
 *   4. Static source checks for absence of regressed patterns:
 *      - clone queue is `attempts: 1` in both worker and backend
 *      - probe-fail branch in `index-repo.ts` does NOT publish
 *        `repo.embed.fail`
 *      - Resolution-cache branch in `index-repo.ts` does NOT publish
 *        `repo.embed.started`
 *
 * Runs in <5s against the existing test DB (created by `pnpm
 * test:fixture:setup`). Does NOT touch the embedder, gitnexus, or BullMQ.
 * Mostly DB + filesystem reads; the pull-guard case invokes the real
 * `handlePullRepoJob`, whose guard path constructs the worker event bus, so
 * Redis must be reachable (it never publishes; `closeEventBus()` releases the
 * connection before exit).
 *
 * Run from repo root:
 *   pnpm test:worker-jobs
 *
 * If the test DB doesn't exist yet:
 *   pnpm test:fixture:setup   # creates + migrates `agentbridge_test`
 */

/* eslint-disable no-console */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const { createDb, reposRepo, workerJobsRepo, schema } =
  await import('@agent-bridge/db')
const { eq } = await import('drizzle-orm')
const indexRepoModule = await import('../apps/worker/src/jobs/index-repo.js')
const { handlePullRepoJob } =
  await import('../apps/worker/src/jobs/pull-repo.js')
const { closeEventBus } = await import('../apps/worker/src/event-bus.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

// ── Lightweight assertion harness (mirrors smoke-resolver.ts) ──────────────

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

// ── Banner ──────────────────────────────────────────────────────────────────

console.log('━'.repeat(60))
console.log(' Worker-jobs invariants smoke')
console.log('━'.repeat(60))
console.log(`test DB: ${testDbUrl.replace(/:[^/]+@/, ':***@')}`)

const db = createDb({ connectionString: testDbUrl })

// ── 1. Heuristic predicates (pure functions) ───────────────────────────────

const { looksLikeFatalLine, looksLikeEmbedPhase } = indexRepoModule

console.log('\n• Heuristic predicates')

check(
  'looksLikeFatalLine matches gitnexus ❌ markers',
  looksLikeFatalLine('❌ Embedding pipeline error: ECONNREFUSED'),
)
check(
  'looksLikeFatalLine matches Error: prefix',
  looksLikeFatalLine('Error: fetch failed'),
)
check(
  'looksLikeFatalLine matches Embedding dimension mismatch',
  looksLikeFatalLine('Embedding dimension mismatch: 1024 vs 384'),
)
check(
  'looksLikeFatalLine rejects normal progress',
  !looksLikeFatalLine(
    '{"level":30,"name":"gitnexus","msg":"📦 parse-cache MISS+store: chunk 1/10"}',
  ),
)
check(
  'looksLikeFatalLine rejects banner line',
  !looksLikeFatalLine('GitNexus Analyzer'),
)
check(
  'looksLikeEmbedPhase matches Querying embeddable nodes',
  looksLikeEmbedPhase(
    '{"level":30,"name":"gitnexus","msg":"🔍 Querying embeddable nodes..."}',
  ),
)
check(
  'looksLikeEmbedPhase matches embedBatch',
  looksLikeEmbedPhase(
    '{"level":30,"name":"gitnexus","msg":"embedBatch 12/45 (256 nodes)"}',
  ),
)
check(
  'looksLikeEmbedPhase rejects scope-resolution phase',
  !looksLikeEmbedPhase(
    '{"level":30,"name":"gitnexus","msg":"▶ Phase: scopeResolution"}',
  ),
)
check(
  'looksLikeEmbedPhase rejects Resolution cache line',
  !looksLikeEmbedPhase(
    '{"level":30,"name":"gitnexus","msg":"🔍 Resolution cache: 0 hits, 0 misses"}',
  ),
)

// ── 2. Boot reapers (DB-level) ─────────────────────────────────────────────

console.log('\n• Boot reapers')

// Seed a fake transitional repo. UUID is generated server-side. Use a
// uniquely-tagged URL so the cleanup at the end finds exactly our row.
const SMOKE_URL = `https://example.test/smoke-worker-jobs/${process.pid}-${Date.now()}.git`

const [seededRepo] = await db.db
  .insert(schema.repos)
  .values({
    remoteUrl: SMOKE_URL,
    branch: 'main',
    status: 'cloning',
  })
  .returning()

if (!seededRepo) {
  console.error('Failed to seed fake repo; aborting')
  process.exit(1)
}

const [seededJob] = await db.db
  .insert(schema.workerJobs)
  .values({
    repoId: seededRepo.id,
    jobKind: 'clone',
    status: 'running',
  })
  .returning()

if (!seededJob) {
  console.error('Failed to seed fake worker_job; aborting')
  process.exit(1)
}

try {
  const reapedJobs = await workerJobsRepo.reapStaleRunningJobs(db)
  const reapedRepos = await reposRepo.reapStuckTransitionalRepos(db)

  check(
    'reapStaleRunningJobs returned >=1',
    reapedJobs >= 1,
    `reaped=${reapedJobs}`,
  )
  check(
    'reapStuckTransitionalRepos returned >=1',
    reapedRepos >= 1,
    `reaped=${reapedRepos}`,
  )

  const [jobAfter] = await db.db
    .select()
    .from(schema.workerJobs)
    .where(eq(schema.workerJobs.id, seededJob.id))
  check(
    "worker_jobs row → status='aborted'",
    jobAfter?.status === 'aborted',
    `status=${jobAfter?.status}`,
  )
  check(
    'worker_jobs row stamped finishedAt',
    jobAfter?.finishedAt instanceof Date,
  )
  check(
    'worker_jobs row carries reaper errorMessage',
    typeof jobAfter?.errorMessage === 'string' &&
      jobAfter.errorMessage.includes('worker restart'),
  )

  const [repoAfter] = await db.db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, seededRepo.id))
  check(
    "repos row → status='error'",
    repoAfter?.status === 'error',
    `status=${repoAfter?.status}`,
  )
  check(
    'repos row carries reaper lastError',
    typeof repoAfter?.lastError === 'string' &&
      repoAfter.lastError.includes('Worker restarted'),
  )

  // Idempotency: second reaper run should be a no-op for our seeds.
  const reapedJobs2 = await workerJobsRepo.reapStaleRunningJobs(db)
  check(
    'reapStaleRunningJobs idempotent (no rows after first reap)',
    reapedJobs2 === 0,
    `reaped=${reapedJobs2}`,
  )
} finally {
  // Cleanup our seed rows so reruns are clean.
  await db.db
    .delete(schema.workerJobs)
    .where(eq(schema.workerJobs.id, seededJob.id))
  await db.db.delete(schema.repos).where(eq(schema.repos.id, seededRepo.id))
}

// ── 3. CAS state machine (DB-level) ────────────────────────────────────────

console.log('\n• CAS state-machine guards')

// Fresh seed at status='pending' so we can walk through the lifecycle.
const CAS_URL = `https://example.test/smoke-cas/${process.pid}-${Date.now()}.git`
const [casRepo] = await db.db
  .insert(schema.repos)
  .values({ remoteUrl: CAS_URL, branch: 'main', status: 'pending' })
  .returning()

if (!casRepo) {
  console.error('Failed to seed CAS repo; aborting')
  process.exit(1)
}

try {
  // pending → cloning OK
  const c1 = await reposRepo.markCloning(db, casRepo.id)
  check('markCloning accepts pending', c1?.status === 'cloning')

  // cloning → cloning REJECTED (already cloning)
  const c2 = await reposRepo.markCloning(db, casRepo.id)
  check('markCloning rejects cloning→cloning', c2 === null)

  // Finish the clone manually so we can test downstream transitions.
  await reposRepo.finishClone(db, casRepo.id, {
    status: 'cloned',
    localPath: '/tmp/fake/source',
  })

  // cloned → pulling OK
  const p1 = await reposRepo.markPulling(db, casRepo.id)
  check('markPulling accepts cloned', p1?.status === 'pulling')

  // pulling → pulling REJECTED
  const p2 = await reposRepo.markPulling(db, casRepo.id)
  check('markPulling rejects pulling→pulling', p2 === null)

  await reposRepo.finishPull(db, casRepo.id, { status: 'cloned' })

  // cloned → indexing OK
  const i1 = await reposRepo.markIndexing(db, casRepo.id)
  check('markIndexing accepts cloned', i1?.status === 'indexing')

  // indexing → cloning REJECTED (no jumping backward; user must wait)
  const i2 = await reposRepo.markCloning(db, casRepo.id)
  check('markCloning rejects indexing→cloning', i2 === null)

  // indexing → indexing REJECTED
  const i3 = await reposRepo.markIndexing(db, casRepo.id)
  check('markIndexing rejects indexing→indexing', i3 === null)
} finally {
  await db.db.delete(schema.repos).where(eq(schema.repos.id, casRepo.id))
}

// ── 3b. Pull guard: stale/duplicate delivery must not clobber a repo ───────
//
// Regression lock for the bug where a re-delivered pull job (BullMQ is
// at-least-once: a stall or worker restart re-runs a job that already
// completed) found the row already settled at `ready` and the guard flipped
// it to `error` via the unconditional `finishPull`. The guard must now leave
// the repo row untouched and only mark its OWN worker_jobs row `aborted`.
//
// Invokes the real `handlePullRepoJob` so we test behaviour, not a mirror.
// The guard path constructs the worker event bus (Redis) but never publishes;
// `closeEventBus()` in the finally releases the connection.

console.log('\n• Pull guard (stale/duplicate delivery)')

const PULL_URL = `https://example.test/smoke-pull-guard/${process.pid}-${Date.now()}.git`
const [pullRepo] = await db.db
  .insert(schema.repos)
  .values({
    remoteUrl: PULL_URL,
    branch: 'main',
    status: 'ready',
    localPath: '/tmp/fake/source',
    lastError: null,
  })
  .returning()

if (!pullRepo) {
  console.error('Failed to seed pull-guard repo; aborting')
  process.exit(1)
}

try {
  const fakeJob = {
    data: {
      repoId: pullRepo.id,
      remoteUrl: PULL_URL,
      branch: 'main',
      hasPat: false,
    },
  } as unknown as Parameters<typeof handlePullRepoJob>[0]

  let threw = false
  let result: Awaited<ReturnType<typeof handlePullRepoJob>> | null = null
  try {
    result = await handlePullRepoJob(fakeJob)
  } catch {
    threw = true
  }

  check('pull guard returns without throwing', !threw)

  const [repoAfter] = await db.db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, pullRepo.id))
  // THE invariant: a healthy repo is never downgraded by a stale delivery.
  check(
    "healthy repo stays status='ready' (not clobbered to 'error')",
    repoAfter?.status === 'ready',
    `status=${repoAfter?.status}`,
  )
  check(
    'repo lastError left untouched (still null)',
    repoAfter?.lastError === null,
    `lastError=${repoAfter?.lastError ?? 'null'}`,
  )

  const repoJobs = await db.db
    .select()
    .from(schema.workerJobs)
    .where(eq(schema.workerJobs.repoId, pullRepo.id))
  const pullJob = repoJobs.find((j) => j.jobKind === 'pull')
  check(
    "guard marks its worker_jobs row status='aborted'",
    pullJob?.status === 'aborted',
    `status=${pullJob?.status ?? 'none'}`,
  )
  check(
    'aborted job records the skip reason',
    typeof pullJob?.errorMessage === 'string' &&
      pullJob.errorMessage.includes("expected 'pulling'"),
  )
  check(
    "handler result reports a no-op (status='error', not a real pull)",
    result?.status === 'error',
    `result=${result?.status ?? 'none'}`,
  )
} finally {
  await db.db
    .delete(schema.workerJobs)
    .where(eq(schema.workerJobs.repoId, pullRepo.id))
  await db.db.delete(schema.repos).where(eq(schema.repos.id, pullRepo.id))
  await closeEventBus()
}

// ── 4. Static source checks (lock down recent invariant fixes) ────────────

console.log('\n• Static source assertions')

const indexRepoSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/worker/src/jobs/index-repo.ts'),
  'utf8',
)
const workerIndexSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/worker/src/index.ts'),
  'utf8',
)
const backendQueuesSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/backend/src/lib/queues.ts'),
  'utf8',
)

// Clone queue: attempts must be 1 in BOTH worker and backend producer.
// Regression here re-introduces the CAS-bypass-on-retry bug.
function attemptsForCloneInWorker(src: string): number | null {
  const cloneSection = sliceAfter(src, 'const cloneRepoQueue = new Queue')
  if (!cloneSection) return null
  const m = cloneSection.slice(0, 1200).match(/^\s*attempts:\s*(\d+)/m)
  return m ? Number(m[1]) : null
}
function attemptsForCloneInBackend(src: string): number | null {
  const cloneSection = sliceAfter(src, 'export async function enqueueCloneRepo')
  if (!cloneSection) return null
  const m = cloneSection.slice(0, 1200).match(/^\s*attempts:\s*(\d+)/m)
  return m ? Number(m[1]) : null
}

const workerCloneAttempts = attemptsForCloneInWorker(workerIndexSrc)
check(
  'worker clone queue attempts === 1',
  workerCloneAttempts === 1,
  `got=${workerCloneAttempts}`,
)

const backendCloneAttempts = attemptsForCloneInBackend(backendQueuesSrc)
check(
  'backend enqueueCloneRepo attempts === 1',
  backendCloneAttempts === 1,
  `got=${backendCloneAttempts}`,
)

// Probe-fail branch must NOT emit `repo.embed.fail`. Locate the
// `await probeEmbedder(probeArgs)` call and inspect the catch block
// that immediately follows; assert no embed.fail emission inside.
const probeBlock = isolateProbeFailBlock(indexRepoSrc)
check(
  'probe-fail block does NOT publish repo.embed.fail',
  probeBlock !== null && !probeBlock.includes(`'repo.embed.fail'`),
)
check(
  'probe-fail block still calls failAndPublish (index.fail path preserved)',
  probeBlock !== null && probeBlock.includes('failAndPublish'),
)

// Resolution-cache branch must NOT emit `repo.embed.started` speculatively.
// Locate the `Resolution cache:` substring guard and inspect the next ~50
// lines; assert no embed.started emission inside.
const resolutionBlock = isolateResolutionCacheBlock(indexRepoSrc)
check(
  'Resolution-cache block does NOT publish repo.embed.started',
  resolutionBlock !== null && !resolutionBlock.includes(`'repo.embed.started'`),
)
check(
  'Resolution-cache block still emits the synthetic graph-DB hint',
  resolutionBlock !== null &&
    resolutionBlock.includes('Building graph database'),
)

// Pull guard must NOT route a non-`pulling` row through finishAndPublish/
// finishPull (an unconditional write that clobbers a healthy repo to
// `error`). It must bail by marking its own job `aborted` and returning.
const pullRepoSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/worker/src/jobs/pull-repo.ts'),
  'utf8',
)
const pullGuardBlock = isolatePullGuardBlock(pullRepoSrc)
check(
  'pull guard block does NOT call finishAndPublish (no repo-status write)',
  // The call form — the branch's own comment mentions the name to explain
  // why it must not be used, so match `await finishAndPublish`, not the bare
  // identifier.
  pullGuardBlock !== null && !pullGuardBlock.includes('await finishAndPublish'),
)
check(
  "pull guard block marks the worker job 'aborted' and returns",
  pullGuardBlock !== null &&
    pullGuardBlock.includes("status: 'aborted'") &&
    pullGuardBlock.includes('return {'),
)

// Boot reaper is wired in worker main() before queue registration.
check(
  'worker boot calls reapStaleRunningJobs',
  workerIndexSrc.includes('reapStaleRunningJobs'),
)
check(
  'worker boot calls reapStuckTransitionalRepos',
  workerIndexSrc.includes('reapStuckTransitionalRepos'),
)
// The reaper must run BEFORE the first `new Queue(` so a freshly-enqueued
// retry can't race the reaper. Cheap check: positional ordering.
const reaperIdx = workerIndexSrc.indexOf('reapStaleRunningJobs')
const firstQueueIdx = workerIndexSrc.indexOf('new Queue(')
check(
  'reaper runs before first queue registration',
  reaperIdx > 0 && firstQueueIdx > 0 && reaperIdx < firstQueueIdx,
  `reaperIdx=${reaperIdx} firstQueueIdx=${firstQueueIdx}`,
)

// ── helpers for static checks ─────────────────────────────────────────────

function sliceAfter(src: string, needle: string): string | null {
  const i = src.indexOf(needle)
  if (i < 0) return null
  return src.slice(i)
}

function isolateProbeFailBlock(src: string): string | null {
  // From the `await probeEmbedder(probeArgs)` call to the close-brace
  // of its surrounding `if (probeArgs) { try { … } catch { … } }`.
  // Empirically the block is well under 2000 chars; we grab a generous
  // window so the check is robust to formatting drift.
  const tryStart = src.indexOf('await probeEmbedder(probeArgs)')
  if (tryStart < 0) return null
  // The catch block ends at the next "}\n    }" sequence that closes
  // the outer `if (probeArgs) { … }`. Cheaper to just grab 2500 chars.
  return src.slice(tryStart, tryStart + 2500)
}

function isolatePullGuardBlock(src: string): string | null {
  // Exactly the guard branch: from `if (row.status !== 'pulling')` to the
  // close of its `return { … }`. Bounding at the return matters — the very
  // next block (`if (!row.localPath)`) legitimately calls finishAndPublish,
  // so a looser window would false-positive.
  const start = src.indexOf("if (row.status !== 'pulling')")
  if (start < 0) return null
  const retIdx = src.indexOf('return {', start)
  if (retIdx < 0) return null
  const retClose = src.indexOf('}', retIdx) // return object has no nested braces
  if (retClose < 0) return null
  return src.slice(start, retClose + 1)
}

function isolateResolutionCacheBlock(src: string): string | null {
  // From the `cleaned.includes('Resolution cache:')` guard to the
  // following ~50 lines. Captures both the synthetic hint emit and
  // any speculative embed-started emit that might be added by mistake.
  const i = src.indexOf(`cleaned.includes('Resolution cache:')`)
  if (i < 0) return null
  return src.slice(i, i + 2000)
}

// ── Summary ─────────────────────────────────────────────────────────────────

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
