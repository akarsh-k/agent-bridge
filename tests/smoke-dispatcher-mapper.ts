/**
 * Dispatcher chunk-mapper smoke. Drives a synthetic Mastra-style
 * chunk stream through `mapChunk` and asserts the resulting
 * `run.model.result` event carries the right shape.
 *
 * Locks down the regression that motivated this file: certain
 * provider adapters (Qwen llama_cpp via Mastra's OpenAI-compatible
 * bridge) stream `text-delta` chunks correctly but omit a summarised
 * `text` field on `step-finish`. The dispatcher used to trust the
 * empty `step-finish.text` verbatim, leaving the audit log with
 * `text: ''` for that step even though the chat tab rendered tokens
 * fine. Fix was to accumulate `text-delta` chunks into
 * `state.pendingText` and fall back to it at step-finish.
 *
 * Pure-function smoke — no DB, no SSE, no embedder. Runs in <1s.
 *
 * Run from repo root:
 *   pnpm test:dispatcher-mapper
 */

/* eslint-disable no-console */

import {
  mapChunk,
  mapChunkToModelEvent,
  makeInitialMapChunkState,
  type MapChunkState,
} from '@agent-bridge/agents'

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

console.log('━'.repeat(60))
console.log(' Dispatcher chunk-mapper smoke')
console.log('━'.repeat(60))

const RUN_ID = 'test-run-12345'

const MODEL_ID = 'test-model'

/** Walk a sequence of chunks through BOTH `mapChunk` (lifecycle +
 *  tools) and `mapChunkToModelEvent` (model.called / model.result) —
 *  same shape the production dispatcher runs in
 *  `run-dispatcher.ts:398-499`. State survives across chunks. */
function drive(
  chunks: ReadonlyArray<unknown>,
  state: MapChunkState = makeInitialMapChunkState(),
): {
  state: MapChunkState
  events: Array<{ kind: string; data: Record<string, unknown> }>
} {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = []
  for (const c of chunks) {
    const lifecycle = mapChunk(c, RUN_ID, state)
    if (lifecycle) {
      events.push({
        kind: lifecycle.kind,
        data: lifecycle.data as Record<string, unknown>,
      })
    }
    // The production dispatcher only consults the model-event mapper
    // when the lifecycle mapper produced something (it shares the
    // timestamp). Match that to keep test = prod parity.
    if (lifecycle) {
      const model = mapChunkToModelEvent(
        c,
        RUN_ID,
        state,
        MODEL_ID,
        lifecycle.ts,
      )
      if (model) {
        events.push({
          kind: model.kind,
          data: model.data as Record<string, unknown>,
        })
      }
    }
  }
  return { state, events }
}

// ── 1. text-delta accumulates into pendingText ─────────────────────────────

console.log('\n• text-delta accumulation')

{
  const { state, events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'Hello' } },
    { type: 'text-delta', payload: { text: ', ' } },
    { type: 'text-delta', payload: { text: 'world!' } },
  ])
  check(
    'pendingText accumulates across chunks',
    state.pendingText === 'Hello, world!',
    `pendingText="${state.pendingText}"`,
  )
  check(
    'each text-delta emits a run.token event with sequential index',
    events.filter((e) => e.kind === 'run.token').length === 3 &&
      events.filter((e) => e.kind === 'run.token').every((e, i) => e.data['index'] === i),
  )
}

// ── 2. step-finish with empty text falls back to pendingText ──────────────

console.log('\n• step-finish text fallback (the bug)')

{
  // Simulates the Qwen-on-llama_cpp shape: text-deltas stream, but the
  // step-finish payload omits `text` entirely.
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'The answer is 42.' } },
    {
      type: 'step-finish',
      payload: {
        // NO `text` field — this is the bug condition.
        toolCalls: [],
        finishReason: 'stop',
        modelId: 'qwen-test',
      },
    },
  ])
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.model.result.text falls back to pendingText',
    result !== undefined && result.data['text'] === 'The answer is 42.',
    `text=${JSON.stringify(result?.data['text'])}`,
  )
}

// ── 3. step-finish with explicit text prefers that over pendingText ───────

console.log('\n• step-finish text preferred when provider supplies it')

{
  // Some providers (Anthropic, OpenAI direct) DO populate `text` on
  // step-finish. The fallback must not clobber that.
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'pieces' } },
    {
      type: 'step-finish',
      payload: {
        text: 'Authoritative response from provider',
        toolCalls: [],
        finishReason: 'stop',
        modelId: 'test',
      },
    },
  ])
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.model.result.text uses payload.text when present',
    result?.data['text'] === 'Authoritative response from provider',
    `text=${JSON.stringify(result?.data['text'])}`,
  )
}

// ── 4. pendingText resets between steps ────────────────────────────────────

console.log('\n• pendingText resets on step-start')

{
  const { state } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'first step' } },
    {
      type: 'step-finish',
      payload: { toolCalls: [{ toolName: 'foo', input: {} }], finishReason: 'tool-calls' },
    },
    { type: 'step-start', payload: { messageId: 'm2' } },
    { type: 'text-delta', payload: { text: 'second' } },
  ])
  check(
    'pendingText holds only the current step text',
    state.pendingText === 'second',
    `pendingText="${state.pendingText}"`,
  )
  check(
    'currentStepIndex advanced on second step-start',
    state.currentStepIndex === 1,
    `currentStepIndex=${state.currentStepIndex}`,
  )
}

// ── 5. reasoning-delta accumulator still works (regression guard) ─────────

console.log('\n• reasoning-delta accumulation')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'reasoning-delta', payload: { text: 'Let me think...' } },
    { type: 'reasoning-delta', payload: { text: ' the answer is X.' } },
    { type: 'text-delta', payload: { text: 'X' } },
    {
      type: 'step-finish',
      payload: { toolCalls: [], finishReason: 'stop', modelId: 'test' },
    },
  ])
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.model.result.reasoning carries the accumulated reasoning',
    result?.data['reasoning'] === 'Let me think... the answer is X.',
    `reasoning=${JSON.stringify(result?.data['reasoning'])}`,
  )
}

// ── 6. tool-call passthrough ───────────────────────────────────────────────

console.log('\n• tool-call event passthrough')

{
  const toolCalls = [{ toolName: 'find_in_codebase', input: { query: 'foo' } }]
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    {
      type: 'step-finish',
      payload: { toolCalls, finishReason: 'tool-calls', modelId: 'test' },
    },
  ])
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.model.result.toolCalls carries the array verbatim',
    Array.isArray(result?.data['toolCalls']) &&
      (result.data['toolCalls'] as unknown[]).length === 1,
    `len=${(result?.data['toolCalls'] as unknown[] | undefined)?.length}`,
  )
  check(
    'finishReason flows through',
    result?.data['finishReason'] === 'tool-calls',
  )
}

// ── 6b. tool-call chunk → fallback when step-finish.toolCalls is empty ────

console.log('\n• step-finish toolCalls fallback (the bug)')

{
  // Production shape: provider streams `tool-call` chunks during the
  // step, but its `step-finish` payload omits `toolCalls`. Without
  // the pendingToolCalls fallback the audit row claims the step
  // invoked nothing.
  const { events, state } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'Let me check that.' } },
    {
      type: 'tool-call',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'find_in_codebase',
        args: { query: 'Product', repo: 'shared' },
      },
    },
    {
      type: 'step-finish',
      payload: {
        // NO `toolCalls` field — the bug condition.
        finishReason: null,
        modelId: 'test',
      },
    },
  ])

  const result = events.find((e) => e.kind === 'run.model.result')
  const tcs = result?.data['toolCalls'] as unknown[] | undefined
  check(
    'run.model.result.toolCalls falls back to pendingToolCalls',
    Array.isArray(tcs) && tcs.length === 1,
    `len=${tcs?.length}`,
  )
  check(
    'fallback toolCall preserves toolName + input',
    Array.isArray(tcs) &&
      tcs.length === 1 &&
      (tcs[0] as Record<string, unknown>)['toolName'] === 'find_in_codebase' &&
      ((tcs[0] as Record<string, unknown>)['input'] as Record<string, unknown>)?.['query'] === 'Product',
  )
  check(
    'tool-call chunk also emitted run.tool.called event (no regression)',
    events.filter((e) => e.kind === 'run.tool.called').length === 1,
  )
  // State sanity: pendingToolCalls survived through step-finish (the
  // dispatcher reads it; step-start resets it for the next step).
  check(
    'state.pendingToolCalls has length 1 after step-finish',
    state.pendingToolCalls.length === 1,
  )
}

// ── 6c. pendingToolCalls resets between steps ────────────────────────────

console.log('\n• pendingToolCalls resets on step-start')

{
  const { state } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    {
      type: 'tool-call',
      payload: { toolCallId: 'tc-1', toolName: 'find_in_codebase', args: {} },
    },
    { type: 'step-finish', payload: { finishReason: 'tool-calls' } },
    { type: 'step-start', payload: { messageId: 'm2' } },
    { type: 'text-delta', payload: { text: 'reply' } },
  ])
  check(
    'pendingToolCalls cleared at the second step-start',
    state.pendingToolCalls.length === 0,
    `len=${state.pendingToolCalls.length}`,
  )
}

// ── 7. Empty text-delta chunks don't crash or emit ─────────────────────────

console.log('\n• empty text-delta is dropped, not crashed')

{
  const { state, events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: '' } },
    { type: 'text-delta', payload: { text: 'x' } },
  ])
  check(
    'empty text-delta does not emit run.token',
    events.filter((e) => e.kind === 'run.token').length === 1,
    `tokens=${events.filter((e) => e.kind === 'run.token').length}`,
  )
  check(
    "empty text-delta doesn't pollute pendingText",
    state.pendingText === 'x',
    `pendingText="${state.pendingText}"`,
  )
}

// ── 8. step-finish with neither payload.text nor accumulator stays empty ──

console.log('\n• step-finish with no text anywhere stays empty')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    {
      type: 'step-finish',
      payload: { toolCalls: [], finishReason: 'stop', modelId: 'test' },
    },
  ])
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    "run.model.result.text is '' when no text-deltas and no payload.text",
    result?.data['text'] === '',
    `text=${JSON.stringify(result?.data['text'])}`,
  )
}

// ── 9. finishReason: explicit payload value preserved, not inferred ──────

console.log('\n• finishReason flows through verbatim when provider supplies it')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'hi' } },
    {
      type: 'step-finish',
      payload: { toolCalls: [], finishReason: 'length', modelId: 'test' },
    },
  ])
  const step = events.find((e) => e.kind === 'run.step.finished')
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.step.finished.finishReason preserves explicit "length"',
    step?.data['finishReason'] === 'length',
    `got=${JSON.stringify(step?.data['finishReason'])}`,
  )
  check(
    'run.step.finished.finishReasonInferred absent when payload supplies value',
    step?.data['finishReasonInferred'] === undefined,
    `got=${JSON.stringify(step?.data['finishReasonInferred'])}`,
  )
  check(
    'run.model.result.finishReasonInferred absent when payload supplies value',
    result?.data['finishReasonInferred'] === undefined,
    `got=${JSON.stringify(result?.data['finishReasonInferred'])}`,
  )
}

// ── 10. finishReason derived to "tool-calls" when missing + tool-call seen ─

console.log('\n• finishReason derived from pendingToolCalls when omitted')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    {
      type: 'tool-call',
      payload: {
        toolCallId: 'tc1',
        toolName: 'find_in_codebase',
        args: { query: 'foo' },
      },
    },
    {
      type: 'step-finish',
      payload: { modelId: 'test' }, // no finishReason, no toolCalls array
    },
  ])
  const step = events.find((e) => e.kind === 'run.step.finished')
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.step.finished.finishReason inferred to "tool-calls"',
    step?.data['finishReason'] === 'tool-calls',
    `got=${JSON.stringify(step?.data['finishReason'])}`,
  )
  check(
    'run.step.finished.finishReasonInferred === true',
    step?.data['finishReasonInferred'] === true,
    `got=${JSON.stringify(step?.data['finishReasonInferred'])}`,
  )
  check(
    'run.model.result.finishReason inferred to "tool-calls"',
    result?.data['finishReason'] === 'tool-calls',
    `got=${JSON.stringify(result?.data['finishReason'])}`,
  )
  check(
    'run.model.result.finishReasonInferred === true',
    result?.data['finishReasonInferred'] === true,
    `got=${JSON.stringify(result?.data['finishReasonInferred'])}`,
  )
}

// ── 11. finishReason derived to "stop" when text-only step omits it ────────

console.log('\n• finishReason derived to "stop" when only text observed')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'text-delta', payload: { text: 'hello' } },
    {
      type: 'step-finish',
      payload: { text: 'hello', modelId: 'test' }, // no finishReason
    },
  ])
  const step = events.find((e) => e.kind === 'run.step.finished')
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.step.finished.finishReason inferred to "stop"',
    step?.data['finishReason'] === 'stop',
    `got=${JSON.stringify(step?.data['finishReason'])}`,
  )
  check(
    'run.step.finished.finishReasonInferred === true',
    step?.data['finishReasonInferred'] === true,
  )
  check(
    'run.model.result.finishReason inferred to "stop"',
    result?.data['finishReason'] === 'stop',
    `got=${JSON.stringify(result?.data['finishReason'])}`,
  )
  check(
    'run.model.result.finishReasonInferred === true',
    result?.data['finishReasonInferred'] === true,
  )
}

// ── 12. finishReason stays null when nothing observed and payload omits ───

console.log('\n• finishReason stays null + non-inferred when step did nothing')

{
  const { events } = drive([
    { type: 'step-start', payload: { messageId: 'm1' } },
    { type: 'step-finish', payload: { modelId: 'test' } },
  ])
  const step = events.find((e) => e.kind === 'run.step.finished')
  const result = events.find((e) => e.kind === 'run.model.result')
  check(
    'run.step.finished.finishReason stays null',
    step?.data['finishReason'] === null,
    `got=${JSON.stringify(step?.data['finishReason'])}`,
  )
  check(
    'run.step.finished.finishReasonInferred absent (no signal to derive from)',
    step?.data['finishReasonInferred'] === undefined,
    `got=${JSON.stringify(step?.data['finishReasonInferred'])}`,
  )
  check(
    'run.model.result.finishReason stays null',
    result?.data['finishReason'] === null,
    `got=${JSON.stringify(result?.data['finishReason'])}`,
  )
  check(
    'run.model.result.finishReasonInferred absent (no signal to derive from)',
    result?.data['finishReasonInferred'] === undefined,
    `got=${JSON.stringify(result?.data['finishReasonInferred'])}`,
  )
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
