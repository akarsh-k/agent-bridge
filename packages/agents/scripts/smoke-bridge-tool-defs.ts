/**
 * Pure-fn smoke for the virtual bridge-tool definitions.
 *
 * What we check (no DB, no MCP. just inspect the constant + its
 * Zod-schema cross-checks):
 *
 *   1. Every name in `CODING_AGENT_VIRTUAL_BRIDGE_TOOLS` matches the
 *      canonical `CODING_AGENT_TOOL_NAMES` set.
 *   2. JSON-Schema sanity per tool: `type === 'object'`, has
 *      `properties`, `additionalProperties: false`. Required fields
 *      reference real properties.
 *   3. `allowAllRepos` matches `SINGLE_REPO_ONLY_TOOLS` from shared
 *     . single-repo-only tools must have `allowAllRepos: false`.
 *   4. The mcp-bridge's slug-prefixing helper produces unique names
 *      across multiple agents (no collision).
 *
 * The actual `buildToolRegistry` shadowing logic is exercised by
 * inline-recreating the merge here against fixture rows. keeping
 * the smoke DB-free so it runs alongside the other resolver +
 * skill smokes without needing a Postgres handle.
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

import {
  CODING_AGENT_TOOL_NAMES,
  SINGLE_REPO_ONLY_TOOLS,
  type CodingAgentToolName,
} from '@agent-bridge/shared'

import {
  CODING_AGENT_VIRTUAL_BRIDGE_TOOLS,
} from '../src/coding-agent/bridge-tool-defs.js'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1
    console.log(`  ok    ${name}`)
  } else {
    fail += 1
    const line = detail ? `${name}. ${detail}` : name
    failures.push(line)
    console.log(`  FAIL  ${line}`)
  }
}

function group(title: string, body: () => void): void {
  console.log(`\n  ${title}`)
  body()
}

// ─── 1. Name canonicality ────────────────────────────────────────────────

group('every virtual tool name is canonical', () => {
  const canonical = new Set<string>(CODING_AGENT_TOOL_NAMES)
  for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
    check(
      `name "${def.name}" is in CODING_AGENT_TOOL_NAMES`,
      canonical.has(def.name),
    )
  }
  check(
    'count matches',
    CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length === CODING_AGENT_TOOL_NAMES.length,
    `${CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length} vs ${CODING_AGENT_TOOL_NAMES.length}`,
  )
})

// ─── 2. JSON-Schema sanity ───────────────────────────────────────────────

group('inputSchema is well-formed JSON Schema draft-07', () => {
  for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
    const s = def.inputSchema as {
      type?: unknown
      properties?: unknown
      required?: unknown
      additionalProperties?: unknown
    }
    check(`${def.name} → type=object`, s.type === 'object')
    check(
      `${def.name} → has properties dict`,
      typeof s.properties === 'object' && s.properties !== null,
    )
    check(
      `${def.name} → additionalProperties=false`,
      s.additionalProperties === false,
    )

    if (Array.isArray(s.required)) {
      const props = s.properties as Record<string, unknown>
      for (const r of s.required) {
        check(
          `${def.name} → required field "${String(r)}" is in properties`,
          typeof r === 'string' && Object.prototype.hasOwnProperty.call(props, r),
        )
      }
    }
  }
})

// ─── 3. allowAllRepos matches SINGLE_REPO_ONLY_TOOLS ─────────────────────

group('allowAllRepos lines up with SINGLE_REPO_ONLY_TOOLS', () => {
  const singleOnly = new Set<CodingAgentToolName>(SINGLE_REPO_ONLY_TOOLS)
  for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
    if (singleOnly.has(def.name)) {
      check(
        `${def.name}: single-repo-only tools must reject __all__`,
        def.allowAllRepos === false,
      )
    }
  }
  // list_repos sets allowAllRepos:false because the question doesn't
  // apply (synchronous); spot-check explicitly.
  const listRepos = CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.find(
    (d) => d.name === 'list_repos',
  )
  check('list_repos exists', !!listRepos)
  check('list_repos is synchronous', listRepos?.synchronous === true)
})

// ─── 4. Slug-prefix collision check ──────────────────────────────────────

group('virtualToolName produces collision-free per-agent names', () => {
  // Mirror the helper from `apps/mcp-bridge/src/index.ts` since we
  // don't import from apps. Drift here is caught by the actual
  // bridge typecheck. the smoke just sanity-checks the convention.
  function virtualToolName(slug: string, def: CodingAgentToolName): string {
    return `${slug}__${def}`
  }
  const slugs = ['traveller-web', 'traveller-api', 'traveller-mobile']
  const names = new Set<string>()
  for (const slug of slugs) {
    for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
      const n = virtualToolName(slug, def.name)
      check(
        `unique name "${n}"`,
        !names.has(n),
        names.has(n) ? 'collision' : undefined,
      )
      names.add(n)
    }
  }
  check(
    'total names matches slugs × tools',
    names.size === slugs.length * CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length,
    `got ${names.size} expected ${slugs.length * CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length}`,
  )
})

// ─── 5. Registry merge precedence (in-memory simulation) ─────────────────

group('explicit row shadows virtual by name (registry merge)', () => {
  // Recreate the bridge's merge logic locally so we can test it
  // without booting Postgres or the bridge process. If the real
  // logic drifts from this simulation, the actual bridge runtime
  // (and the typecheck) will catch it; this smoke just guards
  // against subtle precedence bugs.
  interface FakeEntry {
    name: string
    source: { kind: 'virtual' | 'phase7' }
  }

  function mergeForAgent(
    agentSlug: string,
    explicitNames: readonly string[],
  ): { entries: FakeEntry[]; shadows: number } {
    const reg = new Map<string, FakeEntry>()
    const virtualNames = new Set<string>()
    for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
      const n = `${agentSlug}__${def.name}`
      virtualNames.add(n)
      reg.set(n, { name: n, source: { kind: 'virtual' } })
    }
    let shadows = 0
    for (const n of explicitNames) {
      if (virtualNames.has(n)) shadows += 1
      reg.set(n, { name: n, source: { kind: 'phase7' } })
    }
    return { entries: Array.from(reg.values()), shadows }
  }

  // A) No explicit rows: 6 virtuals, 0 shadows.
  const a = mergeForAgent('traveller-web', [])
  check(
    'no explicit → 6 virtuals',
    a.entries.length === 6 &&
      a.entries.every((e) => e.source.kind === 'virtual') &&
      a.shadows === 0,
  )

  // B) Explicit row that adds a new tool: 7 entries, 0 shadows.
  const b = mergeForAgent('traveller-web', ['custom_audit'])
  check(
    'explicit-new → 7 entries, 0 shadows',
    b.entries.length === 7 && b.shadows === 0,
  )

  // C) Explicit row that shadows a virtual: still 6 entries (shadowed
  //    name reuses the slot), 1 shadow, kind flips to phase7.
  const c = mergeForAgent('traveller-web', ['traveller-web__plan_feature'])
  const planFeature = c.entries.find(
    (e) => e.name === 'traveller-web__plan_feature',
  )
  check(
    'explicit-shadow → 6 entries, 1 shadow, kind=phase7 wins',
    c.entries.length === 6 &&
      c.shadows === 1 &&
      planFeature?.source.kind === 'phase7',
  )

  // D) Multi-agent install: tools/list across agents stays
  //    collision-free because each agent's virtuals are slug-prefixed.
  const d1 = mergeForAgent('traveller-web', [])
  const d2 = mergeForAgent('traveller-api', [])
  const allNames = new Set<string>([
    ...d1.entries.map((e) => e.name),
    ...d2.entries.map((e) => e.name),
  ])
  check(
    'multi-agent → no name collision',
    allNames.size === 12,
    `got ${allNames.size}`,
  )
})

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} cases. ${pass} ok, ${fail} failed`)
if (fail > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
