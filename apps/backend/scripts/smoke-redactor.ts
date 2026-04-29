/**
 * Quick smoke for the Phase 3f redactor binding.
 *
 * Runs in-process (no DB / Redis / LLM needed) and checks that:
 *   1. An empty plaintexts list returns identity helpers.
 *   2. Plaintexts shorter than 4 chars are silently dropped.
 *   3. `redactString` masks every occurrence.
 *   4. `redactEvent` walks nested `data` payloads — tool args, header
 *      dicts, array leaves — and masks every match, returning a NEW
 *      object (input is untouched).
 *   5. Error payloads have their `message` string masked.
 *
 * Prints `[smoke-redactor] ok` on success; throws (and exits non-zero)
 * on any assertion failure so CI / a human running `pnpm --filter
 * backend tsx apps/backend/scripts/smoke-redactor.ts` sees the
 * regression immediately.
 */

import { createRunRedactor } from '@agent-bridge/agents'

const SECRET = 'sk-TESTREDACT-01234567ABCDEF'
const SHORT = 'ab'

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`[smoke-redactor] FAIL: ${label}`)
    process.exit(1)
  }
}

function main(): void {
  const empty = createRunRedactor([])
  assert(empty.redactString('keep me') === 'keep me', 'empty list is identity')
  assert(empty.plaintexts.length === 0, 'empty list reports zero plaintexts')

  const shortOnly = createRunRedactor([SHORT])
  assert(
    shortOnly.redactString('ab ab ab') === 'ab ab ab',
    'short plaintexts ignored',
  )
  assert(
    shortOnly.plaintexts.length === 0,
    'short-only list reports zero plaintexts',
  )

  const r = createRunRedactor([SECRET])
  assert(r.plaintexts.length === 1, 'one plaintext recorded')

  const masked = r.redactString(`Bearer ${SECRET} is the key`)
  assert(!masked.includes(SECRET), 'string scrub removes plaintext')
  assert(masked.includes('«redacted»'), 'string scrub inserts mask')

  const event = {
    kind: 'run.tool.called' as const,
    ts: Date.now(),
    streamId: 'run:abc',
    data: {
      runId: 'abc',
      stepIndex: 0,
      toolCallId: 'call_1',
      toolName: 'do_thing',
      input: {
        prompt: `echo this: ${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}` },
        history: ['line one', `${SECRET} slipped here`],
      },
    },
  }
  const scrubbed = r.redactEvent(event)
  const dump = JSON.stringify(scrubbed)
  assert(!dump.includes(SECRET), 'event scrub removes plaintext from all leaves')
  assert(
    JSON.stringify(event).includes(SECRET),
    'original event is untouched (immutable)',
  )

  const errEvent = {
    kind: 'run.error' as const,
    ts: Date.now(),
    streamId: 'run:abc',
    data: {
      runId: 'abc',
      kind: 'auth' as const,
      message: `401 unauthorized — provided ${SECRET} is not valid`,
    },
  }
  const errScrubbed = r.redactEvent(errEvent)
  assert(
    !JSON.stringify(errScrubbed).includes(SECRET),
    'error payload message is masked',
  )
  const data = errScrubbed.data as { message: string }
  assert(data.message.includes('«redacted»'), 'error payload retains mask marker')

  console.log('[smoke-redactor] ok')
}

main()
