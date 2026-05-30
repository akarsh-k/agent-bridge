/**
 * Run-detail events smoke. Locks the invariants behind the lazy-payload +
 * elision + "initiated by" work so later changes can't silently break them:
 *
 *   1. `elideRunEventPayload` shrinks an over-cap payload to a marker but
 *      PRESERVES the structural fields the timeline pairs on; small payloads
 *      pass through unchanged.
 *   2. `isElidedRunEventPayload` round-trips the marker (and rejects normal
 *      payloads / null / arrays).
 *   3. `originForKind` attributes each call to the right initiator: the
 *      agent (model / tool / search), the inspector wrapper span, the PARENT
 *      wrapper for nested gitnexus/keyword/llm calls, system for prefetch.
 *   4. Static: `ELIDE_PRESERVE_KEYS` is a SUPERSET of every field the
 *      timeline's `pairInfo` pairs on — the regression that produced the
 *      "model call between steps" orphan rows.
 *   5. Static: the backend run-detail route still elides + exposes the lazy
 *      payload endpoint, run-scoped and id-validated.
 *
 * Pure functions + source reads — no DB, no network. Run from repo root:
 *   pnpm test:run-detail-events
 */

/* eslint-disable no-console */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ELIDE_PRESERVE_KEYS,
  RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES,
  elideRunEventPayload,
  isElidedRunEventPayload,
} from '@agent-bridge/shared'

// `originForKind` lives in the frontend (`event-labels.ts`), which uses
// bundler-style extensionless imports incompatible with this package's
// `nodenext` resolution — so we lock its attribution logic via a source
// read rather than importing it (section 3 below).

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

// ── Lightweight assertion harness (mirrors smoke-worker-jobs.ts) ───────────

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

console.log('━'.repeat(60))
console.log(' Run-detail events invariants smoke')
console.log('━'.repeat(60))

// ── 1. isElidedRunEventPayload ─────────────────────────────────────────────

console.log('\n• isElidedRunEventPayload')

check(
  'marker → true',
  isElidedRunEventPayload({ __abElided: true, bytes: 9, kind: 'x' }),
)
check('normal payload → false', !isElidedRunEventPayload({ stepIndex: 1 }))
check('null → false', !isElidedRunEventPayload(null))
check('array → false', !isElidedRunEventPayload([1, 2, 3]))
check(
  '__abElided:false → false',
  !isElidedRunEventPayload({ __abElided: false }),
)

// ── 2. elideRunEventPayload (the core invariant) ──────────────────────────

console.log('\n• elideRunEventPayload')

// Small payload passes through untouched (referential identity).
const small = { stepIndex: 1, foo: 'bar' }
check(
  'small payload returned unchanged',
  elideRunEventPayload(small, 'k') === small,
)
check('null returned unchanged', elideRunEventPayload(null, 'k') === null)
check(
  'undefined returned unchanged',
  elideRunEventPayload(undefined, 'k') === undefined,
)

// Over-cap object: elided, but every structural field survives and the big
// content field is dropped.
const bigOutput = 'x'.repeat(RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES + 5000)
const toolResult = {
  runId: 'r1',
  stepIndex: 2,
  toolCallId: 'abc123',
  toolName: 'find_in_codebase',
  output: bigOutput,
}
const elided = elideRunEventPayload(toolResult, 'run.tool.result') as Record<
  string,
  unknown
>
check('over-cap payload → marker', isElidedRunEventPayload(elided))
check('marker keeps stepIndex', elided['stepIndex'] === 2)
check('marker keeps toolCallId', elided['toolCallId'] === 'abc123')
check('marker keeps toolName', elided['toolName'] === 'find_in_codebase')
check('marker drops the big content field', !('output' in elided))
check('marker records kind', elided['kind'] === 'run.tool.result')
check(
  'marker bytes ~ full size',
  typeof elided['bytes'] === 'number' &&
    (elided['bytes'] as number) > RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES,
  `bytes=${elided['bytes']}`,
)

// Inspector-style elided payload keeps the wrapperName (parent attribution
// + inspector.tool pairing both depend on it).
const bigGitnexus = {
  runId: 'r1',
  tool: 'gitnexus_query',
  wrapperName: 'find_in_codebase',
  argsPreview: 'y'.repeat(RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES + 100),
}
const elidedGn = elideRunEventPayload(
  bigGitnexus,
  'inspector.gitnexus.called',
) as Record<string, unknown>
check(
  'inspector elided keeps wrapperName',
  elidedGn['wrapperName'] === 'find_in_codebase',
)
check(
  'inspector elided keeps tool (pair key)',
  elidedGn['tool'] === 'gitnexus_query',
)

// Over-cap ARRAY: elided to a bare marker (no structural keys to keep).
const bigArray = new Array(RUN_EVENT_PAYLOAD_INLINE_MAX_BYTES).fill('z')
const elidedArr = elideRunEventPayload(bigArray, 'k') as Record<string, unknown>
check('over-cap array → marker', isElidedRunEventPayload(elidedArr))

// ── 3. Static: originForKind "initiated by" attribution ───────────────────
//
// Source check (not behavioral — see the import note above). Locks that the
// nested inspector sub-calls attribute to their PARENT wrapper (`wrapperName`)
// rather than the literal target system, the bug we fixed (`'gitnexus'`).

console.log('\n• Static: originForKind attribution')

const labelsSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/frontend/src/features/agent-logs/event-labels.ts'),
  'utf8',
)
const originStart = labelsSrc.indexOf('export function originForKind(')
const originAfter = originStart >= 0 ? labelsSrc.slice(originStart) : ''
const originEnd = originAfter.indexOf('\nexport function ', 1)
const originBody =
  originStart >= 0
    ? originAfter.slice(0, originEnd > 0 ? originEnd : 1600)
    : null

check('originForKind located', originBody !== null)
check(
  'inspector sub-calls attribute to the parent wrapper (wrapperName)',
  originBody !== null && originBody.includes("p['wrapperName']"),
)
check(
  "inspector sub-calls do NOT hardcode the target (no `return 'gitnexus'`)",
  originBody !== null && !/return\s+'gitnexus'/.test(originBody),
)
check(
  "inspector.tool tagged distinctly from the agent ('inspector wrapper')",
  originBody !== null && originBody.includes("'inspector wrapper'"),
)
check(
  "eager prefetch tagged system-initiated ('auto prefetch')",
  originBody !== null && originBody.includes("'auto prefetch'"),
)
check(
  "agent's own calls tagged 'agent'",
  originBody !== null && originBody.includes("return 'agent'"),
)

// ── 4. Static: ELIDE_PRESERVE_KEYS ⊇ pairInfo fields ──────────────────────
//
// THE regression lock. `pairInfo` (event-timeline.tsx) reads payload fields
// to build the pair key; elision must preserve every one of them or the
// event renders as an unpaired orphan row.

console.log('\n• Static: preserve-keys cover the timeline pairing fields')

const timelineSrc = await fs.readFile(
  path.join(
    REPO_ROOT,
    'apps/frontend/src/features/agent-logs/event-timeline.tsx',
  ),
  'utf8',
)
const pairStart = timelineSrc.indexOf('function pairInfo(')
const afterStart = pairStart >= 0 ? timelineSrc.slice(pairStart) : ''
// Bound to the next top-level function so we only scan pairInfo's body.
const nextFn = afterStart.indexOf('\nfunction ', 1)
const pairBody =
  pairStart >= 0 ? afterStart.slice(0, nextFn > 0 ? nextFn : 2000) : null

const pairFields = new Set<string>()
if (pairBody) {
  for (const m of pairBody.matchAll(/p\['([a-zA-Z_]+)'\]/g)) {
    if (m[1]) pairFields.add(m[1])
  }
}
const preserveSet = new Set<string>(ELIDE_PRESERVE_KEYS)
const missing = [...pairFields].filter((f) => !preserveSet.has(f))

check(
  'pairInfo located + reads payload fields',
  pairBody !== null && pairFields.size >= 4,
  `fields=[${[...pairFields].join(', ')}]`,
)
check(
  'every pairInfo field is in ELIDE_PRESERVE_KEYS (no orphan-row regression)',
  missing.length === 0,
  missing.length > 0
    ? `MISSING from ELIDE_PRESERVE_KEYS: ${missing.join(', ')}`
    : `all covered: ${[...pairFields].join(', ')}`,
)

// ── 5. Static: backend run-detail wiring ──────────────────────────────────

console.log('\n• Static: backend run-detail route')

const runsSrc = await fs.readFile(
  path.join(REPO_ROOT, 'apps/backend/src/routes/runs.ts'),
  'utf8',
)

check(
  'run-detail list elides event payloads',
  runsSrc.includes('elideRunEventPayload('),
)
check(
  'lazy payload endpoint exists',
  runsSrc.includes(`'/:id/events/:eventId/payload'`),
)
check(
  'lazy endpoint validates eventId as digits',
  runsSrc.includes('regex(/^\\d+$/)'),
)
check(
  'lazy query is run-scoped (cannot read another run’s event)',
  runsSrc.includes('eq(schema.runEvents.runId, id)'),
)

// ── Summary ───────────────────────────────────────────────────────────────

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
