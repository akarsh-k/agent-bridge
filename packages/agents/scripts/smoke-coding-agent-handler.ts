/**
 * Pure-fn smoke for the coding-agent handler's pure pieces:
 *
 *   - The structural shape of the wire envelope as built by
 *     a `buildSuccessEnvelope`-style helper recreated inline.
 *   - JSON-parse fallback (pure JSON / fenced JSON / prose-with-JSON
 *     / unparseable → schema_unmatched).
 *
 * The handler in `apps/mcp-bridge/src/coding-agent-handler.ts`
 * pulls in `@agent-bridge/db` + the MCP SDK + the dispatcher;
 * smoking it directly would need a Postgres handle and a real LLM.
 * Instead this script reimplements just the helpers under test as
 * tiny copies (annotated as "mirror of <file>:<symbol>") and runs
 * them against fixture inputs. Drift between mirror and real impl
 * would surface as either:
 *
 *   - the real handler producing a different wire shape that the
 *     IDE coding agent rejects (caught in manual end-to-end), or
 *   - this smoke passing while the real path fails (caught in
 *     manual end-to-end too).
 *
 * Both failure modes are observable in P4's user-driven Cursor /
 * Claude Code session, so the smoke is a fast no-DB regression
 * floor. not the source of truth.
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

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

// ─── JSON-parse fallback (mirror of tryParseLlmJson + extractFirstObject)

type ParseResult =
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'error'; message: string }

function tryParseLlmJson(raw: string): ParseResult {
  if (raw.length === 0) return { kind: 'error', message: 'empty output' }
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed

  try {
    const parsed = JSON.parse(candidate) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'error', message: 'JSON is not an object' }
    }
    return { kind: 'ok', value: parsed as Record<string, unknown> }
  } catch {
    /* fall through */
  }

  const obj = extractFirstObject(candidate)
  if (!obj) return { kind: 'error', message: 'no JSON object found' }
  try {
    const parsed = JSON.parse(obj) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'error', message: 'JSON is not an object' }
    }
    return { kind: 'ok', value: parsed as Record<string, unknown> }
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'parse error',
    }
  }
}

function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inStr) {
      if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

group('JSON parse fallback handles real LLM output shapes', () => {
  const directOk = tryParseLlmJson('{"confidence":"high","answer":{"summary":"hi"}}')
  check(
    'pure JSON',
    directOk.kind === 'ok' &&
      typeof directOk.value['answer'] === 'object',
  )

  const fenced = tryParseLlmJson(
    '```json\n{"confidence":"medium","answer":{"summary":"x"}}\n```',
  )
  check(
    'fenced JSON',
    fenced.kind === 'ok' &&
      (fenced.value as { confidence?: string }).confidence === 'medium',
  )

  const proseWrapped = tryParseLlmJson(
    'Here is your answer:\n\n{"confidence":"high","answer":{"summary":"y"}}\n\nLet me know if you need more.',
  )
  check(
    'JSON embedded in prose',
    proseWrapped.kind === 'ok' &&
      typeof proseWrapped.value['answer'] === 'object',
  )

  const empty = tryParseLlmJson('')
  check('empty input → error', empty.kind === 'error')

  const bare = tryParseLlmJson('Just a sentence, no JSON.')
  check('no braces → error', bare.kind === 'error')

  const malformed = tryParseLlmJson('{this is not valid json}')
  check('malformed → error', malformed.kind === 'error')

  const arrayOnly = tryParseLlmJson('[1,2,3]')
  check('top-level array → error', arrayOnly.kind === 'error')

  // Brace-balance edge: braces inside strings shouldn't fool the
  // depth counter.
  const bracesInString = tryParseLlmJson('{"text":"a {nested} brace","ok":true}')
  check('braces inside strings handled', bracesInString.kind === 'ok')
})

// ─── Envelope shape sanity ──────────────────────────────────────────────
//
// Mirrors what `buildSuccessEnvelope` produces. We construct it inline
// here against fixture inputs so we can verify the shape without
// pulling the bridge module (which depends on the MCP SDK + DB).

interface MiniEnvelope {
  ok: true
  tool: string
  agent: { id: string; slug: string }
  resolved_repo: { id: string; label: string; remote_url: string; branch: string } | null
  related_repos: { id: string; label: string }[]
  scope: 'single' | 'all'
  confidence: 'high' | 'medium' | 'low'
  groundedness?: { claims: number; grounded: number; ungrounded: number }
  answer: Record<string, unknown>
  uncertainty_notes: string[]
  warnings: string[]
  schema_unmatched?: true
}

function buildSuccessEnvelopeMirror(args: {
  tool: string
  agent: { id: string; slug: string }
  resolvedRepo:
    | { id: string; label: string; remote_url: string; branch: string }
    | null
  relatedRepos: { id: string; label: string }[]
  rawOutput: string
  baseWarnings: string[]
}): MiniEnvelope {
  const parsed = tryParseLlmJson(args.rawOutput)
  if (parsed.kind === 'error') {
    return {
      ok: true,
      tool: args.tool,
      agent: args.agent,
      resolved_repo: args.resolvedRepo,
      related_repos: args.relatedRepos,
      scope: args.resolvedRepo === null ? 'all' : 'single',
      confidence: 'low',
      answer: { text: args.rawOutput },
      uncertainty_notes: [`LLM output did not parse as JSON: ${parsed.message}`],
      warnings: args.baseWarnings,
      schema_unmatched: true,
    }
  }
  const json = parsed.value as {
    confidence?: 'high' | 'medium' | 'low'
    groundedness?: { claims: number; grounded: number; ungrounded: number }
    uncertainty_notes?: string[]
    warnings?: string[]
    answer?: Record<string, unknown>
  }
  const confidence = json.confidence ?? 'medium'
  const answer =
    typeof json.answer === 'object' && json.answer !== null && !Array.isArray(json.answer)
      ? json.answer
      : json
  return {
    ok: true,
    tool: args.tool,
    agent: args.agent,
    resolved_repo: args.resolvedRepo,
    related_repos: args.relatedRepos,
    scope: args.resolvedRepo === null ? 'all' : 'single',
    confidence,
    ...(json.groundedness ? { groundedness: json.groundedness } : {}),
    answer,
    uncertainty_notes: Array.isArray(json.uncertainty_notes)
      ? json.uncertainty_notes
      : [],
    warnings: [
      ...args.baseWarnings,
      ...(Array.isArray(json.warnings) ? json.warnings : []),
    ],
  }
}

group('buildSuccessEnvelope packs LLM output cleanly', () => {
  const okOutput = JSON.stringify({
    confidence: 'high',
    groundedness: { claims: 3, grounded: 3, ungrounded: 0 },
    uncertainty_notes: [],
    answer: {
      summary: 'You will need to add a cart page.',
      affected_files: [{ repo: 'frontend', path: 'src/cart/page.tsx', why: 'new route' }],
    },
  })
  const e = buildSuccessEnvelopeMirror({
    tool: 'plan_feature',
    agent: { id: 'a', slug: 'traveller-web' },
    resolvedRepo: {
      id: 'r1',
      label: 'frontend',
      remote_url: 'github.com/co/web',
      branch: 'main',
    },
    relatedRepos: [{ id: 'r2', label: 'backend' }],
    rawOutput: okOutput,
    baseWarnings: [],
  })
  check('ok=true', e.ok === true)
  check('confidence carried over', e.confidence === 'high')
  check(
    'groundedness preserved',
    !!e.groundedness && e.groundedness.claims === 3,
  )
  check(
    'answer carries tool-specific fields',
    typeof e.answer === 'object' &&
      Array.isArray((e.answer as { affected_files?: unknown }).affected_files),
  )
  check('schema_unmatched not set', e.schema_unmatched === undefined)
  check('scope=single when resolved_repo set', e.scope === 'single')

  const allScope = buildSuccessEnvelopeMirror({
    tool: 'ask_general',
    agent: { id: 'a', slug: 'traveller-web' },
    resolvedRepo: null,
    relatedRepos: [],
    rawOutput: okOutput,
    baseWarnings: [],
  })
  check('scope=all when resolved_repo null', allScope.scope === 'all')

  const malformed = buildSuccessEnvelopeMirror({
    tool: 'plan_feature',
    agent: { id: 'a', slug: 'traveller-web' },
    resolvedRepo: {
      id: 'r1',
      label: 'frontend',
      remote_url: 'github.com/co/web',
      branch: 'main',
    },
    relatedRepos: [],
    rawOutput: 'not json',
    baseWarnings: ['unresolved hint "x"'],
  })
  check('malformed → schema_unmatched=true', malformed.schema_unmatched === true)
  check('malformed → confidence=low', malformed.confidence === 'low')
  check(
    'malformed → answer.text carries raw',
    typeof (malformed.answer as { text?: unknown }).text === 'string',
  )
  check(
    'malformed → uncertainty_notes mentions parse failure',
    malformed.uncertainty_notes.some((n) =>
      n.includes('did not parse as JSON'),
    ),
  )
  check(
    'malformed → baseWarnings preserved',
    malformed.warnings.includes('unresolved hint "x"'),
  )
})

// ─── Preamble sanity (mirror) ────────────────────────────────────────────

function buildPreambleMirror(args: {
  tool: string
  agent: { id: string; slug: string }
  scope: 'single' | 'all'
  strictness: 'strict' | 'balanced' | 'exploratory'
  resolved?: {
    id: string
    label: string
    remoteUrl: string
    branch: string
    matchedSignal: string
    confidence: string
  }
  allRepos?: Array<{ id: string; label: string }>
  related: Array<{ id: string; label: string }>
}): string {
  const parts: string[] = []
  parts.push('<coding_agent_call>')
  parts.push(`  <tool>${args.tool}</tool>`)
  parts.push(`  <agent slug="${args.agent.slug}" id="${args.agent.id}" />`)
  parts.push(`  <scope>${args.scope}</scope>`)
  parts.push(`  <strictness>${args.strictness}</strictness>`)
  if (args.scope === 'single' && args.resolved) {
    const r = args.resolved
    parts.push(
      `  <resolved_repo id="${r.id}" label=${JSON.stringify(r.label)} remote_url=${JSON.stringify(r.remoteUrl)} branch=${JSON.stringify(r.branch)} matched_signal="${r.matchedSignal}" confidence="${r.confidence}" />`,
    )
  } else if (args.scope === 'all' && args.allRepos) {
    parts.push('  <resolved_repo>__all__</resolved_repo>')
    parts.push(`  <all_repos count="${args.allRepos.length}">`)
    for (const r of args.allRepos) {
      parts.push(`    <repo id="${r.id}" label=${JSON.stringify(r.label)} />`)
    }
    parts.push('  </all_repos>')
  }
  if (args.related.length > 0) {
    parts.push(`  <related_repos count="${args.related.length}">`)
    for (const r of args.related) {
      parts.push(`    <repo id="${r.id}" label=${JSON.stringify(r.label)} />`)
    }
    parts.push('  </related_repos>')
  }
  parts.push('</coding_agent_call>')
  return parts.join('\n')
}

group('preamble carries resolution authoritatively', () => {
  const single = buildPreambleMirror({
    tool: 'plan_feature',
    agent: { id: 'a1', slug: 'traveller-web' },
    scope: 'single',
    strictness: 'balanced',
    resolved: {
      id: 'r1',
      label: 'frontend',
      remoteUrl: 'https://github.com/co/web',
      branch: 'main',
      matchedSignal: 'role',
      confidence: 'high',
    },
    related: [{ id: 'r2', label: 'backend' }],
  })
  check('contains tool tag', single.includes('<tool>plan_feature</tool>'))
  check(
    'contains resolved_repo with confidence',
    single.includes('matched_signal="role"') &&
      single.includes('confidence="high"'),
  )
  check('contains related_repos', single.includes('<related_repos count="1">'))
  check(
    'attributes are JSON-quoted (defensive)',
    single.includes('label="frontend"') &&
      single.includes('remote_url="https://github.com/co/web"'),
  )

  const all = buildPreambleMirror({
    tool: 'ask_general',
    agent: { id: 'a1', slug: 'traveller-web' },
    scope: 'all',
    strictness: 'strict',
    allRepos: [
      { id: 'r1', label: 'frontend' },
      { id: 'r2', label: 'backend' },
    ],
    related: [],
  })
  check('scope=all has __all__ marker', all.includes('<resolved_repo>__all__</resolved_repo>'))
  check('all_repos count', all.includes('<all_repos count="2">'))
})

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} cases. ${pass} ok, ${fail} failed`)
if (fail > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
