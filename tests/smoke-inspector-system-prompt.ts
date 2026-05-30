/**
 * Inspector system-prompt guard. Pure file read — no agent build, no model.
 *
 * Locks in the fix for the "agent skips the wrapper on repeat questions"
 * regression (traced from run 2c46015c): the prompt used to tell the model the
 * bridge accumulated reports across turns ("no need to repeat"), so on a
 * multi-turn IDE thread the model answered codebase questions from prior
 * context and the per-run `codebase_inspection_reports_json` came back empty
 * (the bridge then fell back to prose). The prompt now states the per-run
 * reality and tells IDE (`inspect_codebase`) requests to run a fresh wrapper
 * even when the answer is already in context.
 *
 * Also guards the cache-invalidation contract: editing the prompt must bump
 * `INSPECTOR_SYSTEM_PROMPT_VERSION` (the BuiltAgent cache hash includes it),
 * and the `# Inspector toolkit` heading marker that `composeInstructions`
 * keys off must stay intact.
 *
 * Run from repo root:
 *   pnpm test:inspector-prompt
 */

/* eslint-disable no-console */

import { readFile } from 'node:fs/promises'

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
console.log(' Inspector system-prompt guard')
console.log('━'.repeat(60))

async function main(): Promise<void> {
  const promptUrl = new URL(
    '../packages/agents/src/inspector/system-prompt.md',
    import.meta.url,
  )
  const versionUrl = new URL(
    '../packages/agents/src/inspector/system-prompt.ts',
    import.meta.url,
  )
  const prompt = await readFile(promptUrl, 'utf8')
  const versionSrc = await readFile(versionUrl, 'utf8')

  // 1. The misleading cross-turn "no need to repeat" claim is gone.
  check(
    'prompt no longer claims reports accumulate across turns ("no need to repeat")',
    !/no need to repeat/i.test(prompt),
    'that line let the model answer code questions from prior context',
  )

  // 2. The per-run reality is stated.
  check(
    'prompt states a report is stored only on its own run',
    /stored only on the run/i.test(prompt),
    'so the model knows later turns start empty for the IDE consumer',
  )

  // 3. IDE requests are told to run a fresh wrapper despite prior context.
  check(
    'prompt tells inspect_codebase requests to run a wrapper even with prior context',
    /inspect_codebase/.test(prompt) &&
      /run the matching wrapper even if/i.test(prompt),
    'the IDE needs a fresh structured report per call',
  )

  // 4. Idempotency heading marker intact (composeInstructions keys off it).
  check(
    'the "# Inspector toolkit" heading marker is intact',
    prompt.includes('# Inspector toolkit'),
    'composeInstructions skips auto-attach when an operator skill already has it',
  )

  // 5. Editing the prompt requires bumping the version (cache invalidation).
  const m = versionSrc.match(/INSPECTOR_SYSTEM_PROMPT_VERSION = '([\d.]+)'/)
  check(
    'INSPECTOR_SYSTEM_PROMPT_VERSION was bumped past 0.6.1',
    m !== null && m[1] !== undefined && m[1] !== '0.6.1',
    `version=${m?.[1] ?? '«unparsed»'}`,
  )

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
  console.error('[inspector-system-prompt-smoke] fatal:', err)
  process.exit(1)
})
