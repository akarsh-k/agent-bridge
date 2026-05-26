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
 *
 * Run from repo root:
 *   pnpm test:codebase-inspection-report-cap
 */

/* eslint-disable no-console */

import { CODEBASE_INSPECTION_REPORT_TOKEN_CAP } from '@agent-bridge/agents'

import {
  finalizeCodebaseInspectionReport,
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
