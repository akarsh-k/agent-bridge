/**
 * Mini-repo token-cap smoke. Pure-function — no DB, no embedder, no
 * gitnexus subprocess. Runs in <1s.
 *
 * Locks down the regressions that motivated the per-agent
 * `agents.mini_repo_token_cap` work:
 *
 *   - `finalizeMiniRepo` truncates oversized payloads down to the
 *     effective cap and stamps a "fit under N-token cap" warning so
 *     the Logs UI can surface it.
 *   - A wrapper that forgets to thread `miniRepoTokenCap` into
 *     `finalizeMiniRepo` would silently return oversized mini-repos.
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
 *   pnpm test:mini-repo-cap
 */

/* eslint-disable no-console */

import { MINI_REPO_TOKEN_CAP } from '@agent-bridge/agents'

import {
  finalizeMiniRepo,
  type MiniRepoDraft,
} from '../packages/agents/src/inspector/mini-repo.js'
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
console.log(' Mini-repo token-cap smoke')
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
function oversizedDraft(): MiniRepoDraft {
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

function smallUnderCapDraft(): MiniRepoDraft {
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
  // 1. `finalizeMiniRepo` honors an explicit cap and stamps a matching warning.
  {
    const cap = 2_500
    const result = finalizeMiniRepo(oversizedDraft(), cap)
    check(
      'finalizeMiniRepo truncates under explicit cap',
      result.tokens_used <= cap,
      `tokens_used=${result.tokens_used} cap=${cap}`,
    )
    check(
      'finalizeMiniRepo stamps "fit under cap" warning',
      result.warnings.some((w: string) =>
        w.includes(`to fit under ${cap}-token cap`),
      ),
      `warnings=${JSON.stringify(result.warnings)}`,
    )
    check(
      'finalizeMiniRepo records the effective cap on the envelope',
      result.tokens_cap === cap,
      `tokens_cap=${result.tokens_cap}`,
    )
  }

  // 2. Omitting the cap falls back to the module default.
  {
    const result = finalizeMiniRepo(smallUnderCapDraft())
    check(
      'finalizeMiniRepo default cap = MINI_REPO_TOKEN_CAP',
      result.tokens_cap === MINI_REPO_TOKEN_CAP,
      `tokens_cap=${result.tokens_cap} expected=${MINI_REPO_TOKEN_CAP}`,
    )
    check(
      'finalizeMiniRepo leaves under-cap drafts untouched',
      result.warnings.length === 0,
      `warnings=${JSON.stringify(result.warnings)}`,
    )
  }

  // 3. `runListRepos` on an empty agent surfaces `no_repos_attached`.
  //    No inspector context, so the helper's `emitInspectorEvent` /
  //    `appendMinirepo` short-circuit. We're only asserting the
  //    returned MiniRepo's warnings here.
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
  //    a 2_500-token cap; if any layer drops `miniRepoTokenCap` on the
  //    floor between input destructuring and `finalizeMiniRepo`, this
  //    check fails.
  {
    const cap = 2_500
    const repos = Array.from({ length: 100 }, (_, i) =>
      fakeRepo(`repo-${i.toString().padStart(3, '0')}`),
    )
    const result = await runListRepos({ repos, miniRepoTokenCap: cap })
    check(
      'runListRepos honors per-call miniRepoTokenCap',
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
  console.error('[mini-repo-cap-smoke] fatal:', err)
  process.exit(1)
})
