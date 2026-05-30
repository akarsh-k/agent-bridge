/**
 * Codebase inspection report token-cap smoke. Pure-function — no DB, no embedder, no
 * gitnexus subprocess. Runs in <1s.
 *
 * Locks down the regressions that motivated the per-agent
 * `agents.codebase_inspection_report_token_cap` work:
 *
 *   - `finalizeCodebaseInspectionReport` truncates oversized payloads down to the
 *     effective cap and stamps a "fit under N-token cap" warning so
 *     the Logs UI can surface it.
 *   - A wrapper that forgets to thread `codebaseInspectionReportTokenCap` into
 *     `finalizeCodebaseInspectionReport` would silently return oversized codebase inspection reports.
 *     We cover that by running `runListRepos` (the one wrapper that
 *     needs no gitnexus subprocess) with a tiny cap and a fan of
 *     synthetic repos that overflows it, then asserting tokens_used
 *     stays under the cap.
 *   - `list_repos` against an empty agent surfaces a
 *     `no_repos_attached` warning that now flows through the event
 *     payload and the IDE D17 envelope.
 *   - Omitting the cap argument falls back to the module-level
 *     default (12_000 at the time of writing), keeping the smoke
 *     fixture and other direct callers working without changes.
 *   - `packReportBundle` keeps the evidence bundle (`codebase_inspection_reports_json`)
 *     under a token budget by shedding the weakest evidence first — ranked by
 *     `confidence`, oldest-first as the tiebreak. Lowest-confidence reports are
 *     summarized (chunks dropped, summary + file paths kept, `BUNDLE_STUB_WARNING`
 *     stamped) and dropped only when summaries still overflow; the single
 *     strongest report is never touched.
 *
 * Run from repo root:
 *   pnpm test:codebase-inspection-report-cap
 */

/* eslint-disable no-console */

import {
  CODEBASE_INSPECTION_REPORT_TOKEN_CAP,
  CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER,
  type CodebaseInspectionReport,
} from '@agent-bridge/agents'

import {
  finalizeCodebaseInspectionReport,
  packReportBundle,
  BUNDLE_STUB_WARNING,
  type CodebaseInspectionReportDraft,
} from '../packages/agents/src/inspector/codebase-inspection-report.js'
import { runListRepos } from '../packages/agents/src/inspector/workflows/list-repos.js'

import type { AttachedRepo } from '@agent-bridge/shared'

// ─── Lightweight assertion harness (mirrors smoke-dispatcher-mapper.ts) ────

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
console.log(' Codebase inspection report token-cap smoke')
console.log('━'.repeat(60))

// ─── Helpers ───────────────────────────────────────────────────────────────

function fakeRepo(label: string): AttachedRepo {
  return {
    repo_id: `00000000-0000-0000-0000-${label.padStart(12, '0')}`.slice(0, 36),
    remote_url: `https://example.com/${label}.git`,
    branch: 'main',
    label,
    role: label,
    description: `synthetic repo "${label}" for cap-honoring smoke`,
    aliases: [],
    status: 'ready',
  }
}

/** Build a draft whose single file contains a chunk large enough to
 *  overflow any sensible cap. Realistic shape — multi-line content,
 *  not just one giant string — so we exercise the chunk-trimmer path. */
function oversizedDraft(): CodebaseInspectionReportDraft {
  const lines = Array.from(
    { length: 400 },
    (_, i) => `// line ${i.toString().padStart(3, ' ')}: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  )
  return {
    wrapper: 'find_in_codebase',
    summary: 'synthetic oversized draft for truncation smoke',
    intent: 'find',
    expansions: ['test'],
    files: [
      {
        repo_id: '00000000-0000-0000-0000-000000000001',
        repo_label: 'fake',
        path: 'src/big-file.ts',
        language: 'typescript',
        chunks: [
          {
            start_line: 1,
            end_line: lines.length,
            content: lines.join('\n'),
          },
        ],
        why: 'oversized synthetic fixture',
      },
    ],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
  }
}

function smallUnderCapDraft(): CodebaseInspectionReportDraft {
  return {
    wrapper: 'list_repos',
    summary: 'tiny draft that stays under the default cap without any truncation',
    intent: 'list_repos',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
  }
}

/** Build a finalized report of ~`approxTokens`, tagged via `summary` so the
 *  packing tests can identify it. Content is split into ~1 KB chunks (each
 *  small enough to survive finalize's chunk-trimmer) and finalized at a cap
 *  well above the content, so the result carries real chunks and a faithful
 *  `tokens_used`. Distinct from `oversizedDraft`, whose single monolithic
 *  chunk gets dropped whole. */
function sizedReport(
  tag: string,
  approxTokens: number,
  confidence?: 'high' | 'medium' | 'low',
): CodebaseInspectionReport {
  const chunkChars = 1000
  const chunkCount = Math.max(1, Math.round((approxTokens * 4) / chunkChars))
  const content = 'lorem ipsum dolor '
    .repeat(Math.ceil(chunkChars / 18))
    .slice(0, chunkChars)
  const chunks = Array.from({ length: chunkCount }, (_, i) => ({
    start_line: i * 12 + 1,
    end_line: i * 12 + 12,
    content,
  }))
  const draft: CodebaseInspectionReportDraft = {
    wrapper: 'find_in_codebase',
    summary: `report ${tag}`,
    intent: 'find',
    expansions: ['test'],
    files: [
      {
        repo_id: '00000000-0000-0000-0000-000000000001',
        repo_label: 'fake',
        path: 'src/file.ts',
        language: 'typescript',
        chunks,
        why: 'sizing fixture',
      },
    ],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
  }
  const report = finalizeCodebaseInspectionReport(
    draft,
    approxTokens * 2 + 10_000,
  )
  return confidence ? { ...report, confidence } : report
}

function bundleTokens(reports: readonly CodebaseInspectionReport[]): number {
  return reports.reduce((sum, r) => sum + r.tokens_used, 0)
}

function hasChunks(report: CodebaseInspectionReport): boolean {
  return report.files.some((f) => f.chunks.length > 0)
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. `finalizeCodebaseInspectionReport` honors an explicit cap and stamps a matching warning.
  {
    const cap = 2_500
    const result = finalizeCodebaseInspectionReport(oversizedDraft(), cap)
    check(
      'finalizeCodebaseInspectionReport truncates under explicit cap',
      result.tokens_used <= cap,
      `tokens_used=${result.tokens_used} cap=${cap}`,
    )
    check(
      'finalizeCodebaseInspectionReport stamps "fit under cap" warning',
      result.warnings.some((w: string) =>
        w.includes(`to fit under ${cap}-token cap`),
      ),
      `warnings=${JSON.stringify(result.warnings)}`,
    )
    check(
      'finalizeCodebaseInspectionReport records the effective cap on the envelope',
      result.tokens_cap === cap,
      `tokens_cap=${result.tokens_cap}`,
    )
  }

  // 2. Omitting the cap falls back to the module default.
  {
    const result = finalizeCodebaseInspectionReport(smallUnderCapDraft())
    check(
      'finalizeCodebaseInspectionReport default cap = CODEBASE_INSPECTION_REPORT_TOKEN_CAP',
      result.tokens_cap === CODEBASE_INSPECTION_REPORT_TOKEN_CAP,
      `tokens_cap=${result.tokens_cap} expected=${CODEBASE_INSPECTION_REPORT_TOKEN_CAP}`,
    )
    check(
      'finalizeCodebaseInspectionReport leaves under-cap drafts untouched',
      result.warnings.length === 0,
      `warnings=${JSON.stringify(result.warnings)}`,
    )
  }

  // 3. `runListRepos` on an empty agent surfaces `no_repos_attached`.
  //    No inspector context, so the helper's `emitInspectorEvent` /
  //    `appendCodebaseInspectionReport` short-circuit. We're only asserting the
  //    returned CodebaseInspectionReport's warnings here.
  {
    const result = await runListRepos({ repos: [] })
    check(
      'runListRepos() empty agent surfaces no_repos_attached warning',
      result.warnings.includes('no_repos_attached'),
      `warnings=${JSON.stringify(result.warnings)}`,
    )
  }

  // 4. `runListRepos` honors a tight per-call cap end-to-end.
  //    Fan of synthetic repos guarantees the rendered summary overflows
  //    a 2_500-token cap; if any layer drops `codebaseInspectionReportTokenCap` on the
  //    floor between input destructuring and `finalizeCodebaseInspectionReport`, this
  //    check fails.
  {
    const cap = 2_500
    const repos = Array.from({ length: 100 }, (_, i) =>
      fakeRepo(`repo-${i.toString().padStart(3, '0')}`),
    )
    const result = await runListRepos({ repos, codebaseInspectionReportTokenCap: cap })
    check(
      'runListRepos honors per-call codebaseInspectionReportTokenCap',
      result.tokens_used <= cap && result.tokens_cap === cap,
      `tokens_used=${result.tokens_used} cap=${result.tokens_cap}`,
    )
  }

  // 5. `packReportBundle` leaves an under-budget bundle untouched.
  {
    const reports = [sizedReport('a', 6_000), sizedReport('b', 6_000)]
    const budget = bundleTokens(reports) + 5_000 // comfortable headroom
    const packed = packReportBundle(reports, budget)
    check(
      'packReportBundle keeps an under-budget bundle intact',
      packed.reports.length === 2 &&
        packed.stubbed === 0 &&
        packed.dropped === 0 &&
        packed.reports.every(hasChunks) &&
        packed.reports.every((r) => !r.warnings.includes(BUNDLE_STUB_WARNING)),
      `len=${packed.reports.length} stubbed=${packed.stubbed} dropped=${packed.dropped}`,
    )
  }

  // 6. Over budget, equal confidence → recency tiebreak: newest stays full,
  //    older summarized (not dropped). (Confidence ranking is tests 10–11.)
  {
    const reports = [
      sizedReport('old', 12_000),
      sizedReport('mid', 12_000),
      sizedReport('new', 12_000),
    ]
    const budget =
      CODEBASE_INSPECTION_REPORT_TOKEN_CAP *
      CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER // 24k < ~36k total
    const packed = packReportBundle(reports, budget)
    const newest = packed.reports[packed.reports.length - 1]!
    const oldest = packed.reports[0]!
    check(
      'packReportBundle keeps the newest report full',
      hasChunks(newest) && newest.summary === 'report new',
      `chunks=${hasChunks(newest)} summary=${JSON.stringify(newest.summary)}`,
    )
    check(
      'packReportBundle summarizes the oldest report (chunks dropped, summary + warning kept)',
      !hasChunks(oldest) &&
        oldest.summary === 'report old' &&
        oldest.warnings.includes(BUNDLE_STUB_WARNING),
      `chunks=${hasChunks(oldest)} warnings=${JSON.stringify(oldest.warnings)}`,
    )
    check(
      'packReportBundle keeps every report (summaries, not deletions) and fits budget',
      packed.reports.length === 3 &&
        packed.dropped === 0 &&
        packed.stubbed >= 1 &&
        bundleTokens(packed.reports) <= budget,
      `len=${packed.reports.length} stubbed=${packed.stubbed} dropped=${packed.dropped} tokens=${bundleTokens(packed.reports)} budget=${budget}`,
    )
  }

  // 7. Equal confidence + extreme budget → recency tiebreak: drop oldest,
  //    keep ≥1 (the newest), full.
  {
    const reports = Array.from({ length: 5 }, (_, i) =>
      sizedReport(`r${i}`, 12_000),
    )
    const budget = 100 // smaller than one full report or all stubs combined
    const packed = packReportBundle(reports, budget)
    const kept = packed.reports[packed.reports.length - 1]!
    check(
      'packReportBundle drops oldest stubs when summaries still overflow, keeping the newest full',
      packed.reports.length === 1 &&
        packed.dropped === 4 &&
        kept.summary === 'report r4' &&
        hasChunks(kept),
      `len=${packed.reports.length} dropped=${packed.dropped} kept=${JSON.stringify(kept.summary)} chunks=${hasChunks(kept)}`,
    )
  }

  // 8. Re-packing an already-packed bundle is a no-op (no double-stub).
  {
    const reports = [
      sizedReport('a', 12_000),
      sizedReport('b', 12_000),
      sizedReport('c', 12_000),
    ]
    const budget =
      CODEBASE_INSPECTION_REPORT_TOKEN_CAP *
      CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER
    const once = packReportBundle(reports, budget)
    const twice = packReportBundle(once.reports, budget)
    const maxStubWarnings = Math.max(
      ...twice.reports.map(
        (r) => r.warnings.filter((w) => w === BUNDLE_STUB_WARNING).length,
      ),
    )
    check(
      'packReportBundle is idempotent — re-pack adds no stubs/drops and never doubles the warning',
      twice.stubbed === 0 &&
        twice.dropped === 0 &&
        twice.reports.length === once.reports.length &&
        maxStubWarnings <= 1,
      `stubbed=${twice.stubbed} dropped=${twice.dropped} len=${twice.reports.length} maxWarn=${maxStubWarnings}`,
    )
  }

  // 9. A lone report is never stubbed or dropped, even over budget.
  {
    const packed = packReportBundle([sizedReport('solo', 12_000)], 1_000) // ≪ 12k
    check(
      'packReportBundle keeps a lone over-budget report full',
      packed.reports.length === 1 &&
        packed.stubbed === 0 &&
        packed.dropped === 0 &&
        hasChunks(packed.reports[0]!),
      `len=${packed.reports.length} stubbed=${packed.stubbed} dropped=${packed.dropped} chunks=${hasChunks(packed.reports[0]!)}`,
    )
  }

  // 10. Confidence outranks recency: a high-confidence OLD report stays full
  //     while low-confidence newer ones are summarized first.
  {
    const reports = [
      sizedReport('old-high', 12_000, 'high'),
      sizedReport('mid-low', 12_000, 'low'),
      sizedReport('new-low', 12_000, 'low'),
    ]
    const budget =
      CODEBASE_INSPECTION_REPORT_TOKEN_CAP *
      CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER
    const packed = packReportBundle(reports, budget)
    const byTag = (t: string) =>
      packed.reports.find((r) => r.summary === `report ${t}`)!
    check(
      'packReportBundle keeps the highest-confidence report full even when it is the oldest',
      hasChunks(byTag('old-high')) &&
        !hasChunks(byTag('mid-low')) &&
        !hasChunks(byTag('new-low')) &&
        packed.dropped === 0,
      `old-high=${hasChunks(byTag('old-high'))} mid-low=${hasChunks(byTag('mid-low'))} new-low=${hasChunks(byTag('new-low'))} dropped=${packed.dropped}`,
    )
  }

  // 11. Extreme budget: the highest-confidence report survives a full drop
  //     even when it is mid-array (not the newest).
  {
    const reports = [
      sizedReport('low-old', 12_000, 'low'),
      sizedReport('high-mid', 12_000, 'high'),
      sizedReport('low-new', 12_000, 'low'),
    ]
    const packed = packReportBundle(reports, 100)
    check(
      'packReportBundle drops lowest-confidence first; the strongest survives mid-array',
      packed.reports.length === 1 &&
        packed.dropped === 2 &&
        packed.reports[0]!.summary === 'report high-mid' &&
        hasChunks(packed.reports[0]!),
      `len=${packed.reports.length} dropped=${packed.dropped} kept=${JSON.stringify(packed.reports[0]?.summary)}`,
    )
  }

  // 12. A report with nothing to shed (no chunks/graph, e.g. list_repos) is
  //     never falsely marked summarized — it stays full or is dropped, but
  //     does not get the "chunks dropped" warning for free.
  {
    const chunkless = finalizeCodebaseInspectionReport(
      { ...smallUnderCapDraft(), summary: 'report chunkless' },
      12_000,
    )
    const reports = [
      { ...chunkless, confidence: 'low' as const }, // weakest, nothing to shed
      sizedReport('big-low', 12_000, 'low'), // shreddable, summarized first
      sizedReport('big-high', 12_000, 'high'), // strongest, kept full
    ]
    const packed = packReportBundle(reports, 18_000)
    const kept = packed.reports.find((r) => r.summary === 'report chunkless')
    check(
      'packReportBundle does not stamp the summary warning on a report with nothing to shed',
      kept !== undefined && !kept.warnings.includes(BUNDLE_STUB_WARNING),
      `present=${kept !== undefined} warned=${kept?.warnings.includes(BUNDLE_STUB_WARNING)}`,
    )
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
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
  console.error('[codebase inspection report-cap-smoke] fatal:', err)
  process.exit(1)
})
