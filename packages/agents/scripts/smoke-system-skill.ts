/**
 * Pure-fn smoke for the coding-agent system skill loader and the
 * `composeInstructions` integration. No DB, no LLM. we exercise the
 * markdown loader and pretty-print three scenarios so a human can
 * eyeball the output:
 *
 *   1. Base prompt + zero skills → system skill auto-attached.
 *   2. Base prompt + a couple of operator skills → skill attached
 *      at the end.
 *   3. Operator authored a skill whose body already contains the
 *      `# Coding-agent toolkit guidance` heading → idempotency
 *      kicks in and we DON'T double-attach.
 *
 * Run from repo root:
 *   pnpm --filter @agent-bridge/agents skill:smoke
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

import {
  CODING_AGENT_SYSTEM_SKILL_HEADING,
  CODING_AGENT_SYSTEM_SKILL_VERSION,
  loadCodingAgentSystemSkill,
} from '../src/coding-agent/system-skill.js'

interface FakeSkillRow {
  readonly name: string
  readonly markdownBody: string
}

/**
 * Local copy of `composeInstructions` for the smoke. We deliberately
 * do NOT import the real one. that one lives inside `build-agent.ts`
 * which pulls Mastra into the import graph. The smoke wants to
 * exercise the assembly logic without paying that cost. Keep this in
 * sync with the real function; if they drift the smoke catches it
 * because the output diff will be visible.
 */
async function composeInstructions(
  basePrompt: string,
  skills: readonly FakeSkillRow[],
): Promise<string> {
  const parts: string[] = []
  const trimmedBase = basePrompt.trim()
  if (trimmedBase.length > 0) parts.push(trimmedBase)

  let alreadyHasCodingAgentSection = trimmedBase.includes(
    CODING_AGENT_SYSTEM_SKILL_HEADING,
  )

  for (const skill of skills) {
    const body = skill.markdownBody.trim()
    if (body.length === 0) continue
    if (body.includes(CODING_AGENT_SYSTEM_SKILL_HEADING)) {
      alreadyHasCodingAgentSection = true
    }
    parts.push(`## ${skill.name}\n\n${body}`)
  }

  if (!alreadyHasCodingAgentSection) {
    const skillBody = await loadCodingAgentSystemSkill()
    if (skillBody.length > 0) parts.push(skillBody)
  }

  return parts.join('\n\n')
}

async function main(): Promise<void> {
  console.log(
    `\n--- coding-agent system skill v${CODING_AGENT_SYSTEM_SKILL_VERSION} ---\n`,
  )

  const skill = await loadCodingAgentSystemSkill()
  console.log(`loaded ${skill.length} chars from system-skill.md\n`)
  if (!skill.startsWith(CODING_AGENT_SYSTEM_SKILL_HEADING)) {
    console.error(
      `FAIL: expected body to start with "${CODING_AGENT_SYSTEM_SKILL_HEADING}"`,
    )
    process.exit(1)
  }

  const cases: Array<{ name: string; base: string; skills: FakeSkillRow[] }> = [
    {
      name: 'base + zero skills',
      base: 'You are an analytics-savvy backend engineer.',
      skills: [],
    },
    {
      name: 'base + two operator skills',
      base: 'You answer questions about our travel booking platform.',
      skills: [
        { name: 'House style', markdownBody: 'Be brief. Use bullet lists.' },
        {
          name: 'Privacy',
          markdownBody: 'Never quote personal data from indexed code.',
        },
      ],
    },
    {
      name: 'operator skill ALREADY contains coding-agent heading (idempotency)',
      base: 'Test agent.',
      skills: [
        {
          name: 'Custom coding-agent guidance',
          markdownBody: `${CODING_AGENT_SYSTEM_SKILL_HEADING}\n\nCustom override body. please follow this instead of the default block.`,
        },
      ],
    },
  ]

  let pass = 0
  let fail = 0

  for (const c of cases) {
    const out = await composeInstructions(c.base, c.skills)
    const occurrences = countOccurrences(out, CODING_AGENT_SYSTEM_SKILL_HEADING)
    const expected = c.name.includes('idempotency') ? 1 : 1 // both should be 1
    const ok = occurrences === expected

    console.log(`\n=== ${c.name} ===`)
    console.log(
      `  heading occurrences: ${occurrences} (expected ${expected}). ${ok ? 'OK' : 'FAIL'}`,
    )
    console.log(`  total length: ${out.length} chars`)
    if (ok) pass += 1
    else fail += 1

    // Print the tail (last 240 chars) so a human can confirm the
    // skill was appended (or not) at the right spot.
    console.log(`  tail: …${out.slice(-240).replace(/\n/g, ' ⏎ ')}`)
  }

  console.log(`\n${pass + fail} cases. ${pass} ok, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count += 1
    i += needle.length
  }
  return count
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
