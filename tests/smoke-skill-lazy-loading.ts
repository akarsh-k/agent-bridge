/**
 * Lazy-skill loading smoke. Locks down the core promise of the
 * `alwaysInclude` + `description` design: a skill body MUST stay out
 * of the system prompt when the operator opts the skill into lazy
 * loading, and MUST land in the prompt otherwise.
 *
 * Pure-function smoke — no DB, no SSE, no LLM. Drives
 * `composeInstructions` and `buildReadSkillTool` over synthetic
 * `SkillRow` inputs and asserts:
 *
 *   1. An `alwaysInclude=true` skill's body lands in the composed
 *      instructions.
 *   2. A lazy skill (`alwaysInclude=false` + non-empty description +
 *      non-empty body) keeps its body OUT of the composed
 *      instructions; only its description appears via the
 *      "Available skills" catalog bullet.
 *   3. A skill missing a description falls back to eager (body
 *      lands in the prompt) — the LLM can't choose a lazy skill it
 *      can't see in the catalog.
 *   4. An empty-body skill is dropped entirely, regardless of the
 *      always-include flag. The tool would have nothing to return.
 *   5. `buildReadSkillTool` returns null when there are no lazy
 *      skills, and a Tool with id `read_skill` when there are.
 *   6. The returned tool's `execute` resolves to the body for a known
 *      name, and a soft `{ ok: false }` envelope for an unknown one.
 *
 * Run from repo root:
 *   pnpm test:skill-lazy
 */

/* eslint-disable no-console */

import {
  buildReadSkillTool,
  composeInstructions,
  splitSkills,
} from '@agent-bridge/agents'
import type { SkillRow } from '@agent-bridge/db/schema'

// ── Lightweight assertion harness (mirrors smoke-dispatcher-mapper.ts) ─

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
console.log(' Skill lazy-loading smoke')
console.log('━'.repeat(60))

// ── Synthetic fixtures ────────────────────────────────────────────────
//
// Each skill has a unique token in its body so we can grep for it in
// the composed instructions string without ambiguity. Using all-caps
// hex-ish tokens avoids accidental substring collisions with anything
// `composeInstructions` injects on its own.

const EAGER_BODY_TOKEN = 'XYZ-EAGER-ALWAYS-ON-BODY-MARKER'
const LAZY_BODY_TOKEN = 'XYZ-LAZY-ON-DEMAND-BODY-MARKER'
const NO_DESC_BODY_TOKEN = 'XYZ-NODESC-FALLS-EAGER-BODY-MARKER'
const EMPTY_BODY_DESC = 'Empty body skill description should never surface.'
const LAZY_DESCRIPTION = 'Use when reviewing pull requests for migration safety.'

function mkSkill(overrides: Partial<SkillRow>): SkillRow {
  const now = new Date('2026-05-23T00:00:00Z')
  return {
    id: overrides.id ?? `skill-${overrides.name ?? 'x'}`,
    agentId: 'test-agent',
    name: 'unnamed',
    description: '',
    markdownBody: '',
    alwaysInclude: false,
    position: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const eagerSkill = mkSkill({
  name: 'eager-always-on',
  description: 'This skill is force-included.',
  markdownBody: `# Eager body\n\n${EAGER_BODY_TOKEN}`,
  alwaysInclude: true,
})

const lazySkill = mkSkill({
  name: 'pr-reviewer',
  description: LAZY_DESCRIPTION,
  markdownBody: `# PR reviewer\n\n${LAZY_BODY_TOKEN}`,
  alwaysInclude: false,
})

const noDescriptionSkill = mkSkill({
  name: 'no-description-skill',
  description: '',
  markdownBody: `# Fallback eager\n\n${NO_DESC_BODY_TOKEN}`,
  alwaysInclude: false,
})

const emptyBodyLazySkill = mkSkill({
  name: 'empty-body-skill',
  description: EMPTY_BODY_DESC,
  markdownBody: '',
  alwaysInclude: false,
})

const allSkills: ReadonlyArray<SkillRow> = [
  eagerSkill,
  lazySkill,
  noDescriptionSkill,
  emptyBodyLazySkill,
]

// ── splitSkills classification ────────────────────────────────────────

const split = splitSkills(allSkills)

check(
  'alwaysInclude=true classified eager',
  split.eager.some((s) => s.name === 'eager-always-on'),
  'eager bucket',
)
check(
  'lazy (description + body, alwaysInclude=false) classified lazy',
  split.lazy.some((s) => s.name === 'pr-reviewer'),
  'lazy bucket',
)
check(
  'no-description skill falls back to eager',
  split.eager.some((s) => s.name === 'no-description-skill'),
  'LLM has no signal without a description',
)
check(
  'empty-body lazy candidate falls back to eager (will be dropped)',
  split.eager.some((s) => s.name === 'empty-body-skill'),
  'composeInstructions filters empty bodies from the eager list',
)

// ── composeInstructions: lazy body MUST NOT appear ────────────────────
//
// `inspectorEnabled: false` keeps the assertion focused on skill
// composition (the inspector toolkit prompt is loaded from disk under
// inspectorEnabled=true; we don't need it here).

const basePrompt = 'You are a helpful test agent.'
const instructions = await composeInstructions(basePrompt, allSkills, false)

console.log('')
console.log('── composed instructions (truncated) ──')
console.log(
  instructions.length > 600
    ? instructions.slice(0, 600) + '\n[...truncated...]'
    : instructions,
)
console.log('────────────────────────────────────────')
console.log('')

check(
  'base prompt preserved at the head of instructions',
  instructions.trimStart().startsWith(basePrompt),
  `first line: ${instructions.split('\n')[0]?.slice(0, 60)}`,
)

check(
  'eager skill body lands in the prompt',
  instructions.includes(EAGER_BODY_TOKEN),
  `looking for ${EAGER_BODY_TOKEN}`,
)

check(
  'LAZY SKILL BODY DOES NOT LAND IN THE PROMPT',
  !instructions.includes(LAZY_BODY_TOKEN),
  `must not find ${LAZY_BODY_TOKEN}`,
)

check(
  'no-description skill body still lands (eager fallback)',
  instructions.includes(NO_DESC_BODY_TOKEN),
  `looking for ${NO_DESC_BODY_TOKEN}`,
)

check(
  'empty-body skill leaves no trace in the prompt',
  !instructions.includes(EMPTY_BODY_DESC),
  'description of empty-body skill must not appear in either prompt or catalog',
)

check(
  'lazy skill description appears via catalog bullet',
  instructions.includes(LAZY_DESCRIPTION) &&
    instructions.includes(lazySkill.name),
  `catalog should advertise "${lazySkill.name}"`,
)

check(
  'catalog header is emitted exactly once',
  (instructions.match(/## Available skills/g) ?? []).length === 1,
  'expected one "## Available skills" header',
)

check(
  'instructions mention `read_skill` so the LLM knows the affordance',
  instructions.includes('read_skill'),
  'tool name should appear in the catalog preamble',
)

// ── buildReadSkillTool: presence + lookup ─────────────────────────────

const emptyTool = buildReadSkillTool([])
check(
  'no lazy skills → no read_skill tool',
  emptyTool === null,
  emptyTool === null ? 'returned null as expected' : `unexpected tool ${emptyTool?.id}`,
)

const tool = buildReadSkillTool([lazySkill])
check(
  'lazy skill present → tool is mounted',
  tool !== null,
  tool ? `id=${tool.id}` : 'returned null',
)
check(
  'tool id is exactly "read_skill"',
  tool?.id === 'read_skill',
  `id=${tool?.id}`,
)
check(
  'tool description lists the loadable skill name',
  typeof tool?.description === 'string' &&
    tool.description.includes(lazySkill.name),
  'description should mention `pr-reviewer`',
)

// ── tool.execute: known + unknown name ────────────────────────────────
//
// The tool's execute returns the body for a known name and a soft
// `{ ok: false }` envelope for an unknown one. We invoke it directly
// — Mastra wraps this in tool-call plumbing at runtime, but the
// function itself is plain async and safe to call with no context.

interface SuccessResult { ok: true; name: string; body: string }
interface FailureResult { ok: false; error: string }
type ReadSkillResult = SuccessResult | FailureResult

function isSuccess(r: unknown): r is SuccessResult {
  return (
    !!r &&
    typeof r === 'object' &&
    (r as { ok?: unknown }).ok === true &&
    typeof (r as { body?: unknown }).body === 'string'
  )
}
function isFailure(r: unknown): r is FailureResult {
  return (
    !!r &&
    typeof r === 'object' &&
    (r as { ok?: unknown }).ok === false &&
    typeof (r as { error?: unknown }).error === 'string'
  )
}

if (tool?.execute) {
  // Mastra passes (input, context). The context isn't needed for our
  // pure lookup — pass an empty object cast to any so the test stays
  // honest about driving the function directly.
  const okResult = (await tool.execute(
    { name: lazySkill.name } as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  )) as ReadSkillResult
  check(
    'tool.execute returns the body for a known name',
    isSuccess(okResult) && okResult.body.includes(LAZY_BODY_TOKEN),
    isSuccess(okResult)
      ? `body length ${okResult.body.length}`
      : `unexpected shape: ${JSON.stringify(okResult).slice(0, 120)}`,
  )

  const missResult = (await tool.execute(
    { name: 'no-such-skill' } as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  )) as ReadSkillResult
  check(
    'tool.execute soft-fails on an unknown name',
    isFailure(missResult) && missResult.error.toLowerCase().includes('no skill'),
    isFailure(missResult)
      ? `error: ${missResult.error.slice(0, 80)}`
      : `unexpected success: ${JSON.stringify(missResult).slice(0, 120)}`,
  )
} else {
  check('tool.execute is defined', false, 'tool returned without an execute fn')
}

// ── Summary ───────────────────────────────────────────────────────────

console.log('')
console.log('━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(` Failed:`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  console.log('━'.repeat(60))
  process.exitCode = 1
} else {
  console.log(' All checks passed.')
  console.log('━'.repeat(60))
}
