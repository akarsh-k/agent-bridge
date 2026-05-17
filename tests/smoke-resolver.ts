/**
 * Resolver scenarios smoke. Pure-function tests of
 * `resolveRepoFromHint` — no DB, no LLM, no infra; runs in <1s.
 *
 * Covers every path the bridge handler and wrappers depend on:
 *
 *   1. Empty hint
 *      - single repo  → ok:true, matched_signal='fallback_single_repo'
 *      - multi-repo + allowAll → ok:'all'
 *      - multi-repo + !allowAll → ok:'clarify' (repo_or_all)
 *      - multi-repo + fallback (bridge pre-resolution) → ok:true
 *   2. Single-signal hint (LLM-supplied `repo_hint`)
 *      - role match           → matched_signal='role'
 *      - alias match          → matched_signal='alias'
 *      - url_tail match       → matched_signal='url_tail'
 *      - unmatched + multi    → ok:'clarify'
 *      - unmatched + single   → ok:true (fallback to only repo)
 *   3. Quote-mangling regression
 *      - `"label"`            → unquoted, matches
 *      - `'label'`            → unquoted, matches
 *      - `\`label\``          → unquoted, matches
 *      - `""label""`          → double-unquoted, matches
 *      - smart quotes ("…")   → unquoted, matches
 *   4. Multi-signal precedence
 *      - remote_url match wins over weaker signals on a different repo
 *      - local_folder used when other signals miss
 *   5. `__all__` sentinel
 *      - allowAll  → ok:'all'
 *      - !allowAll → ok:'clarify' (single_repo_required)
 *   6. No repos attached → ok:false (no_repos)
 *   7. Score table + suggested_replies shapes
 *
 * Run from repo root:
 *   pnpm -w run test:resolver
 */

/* eslint-disable no-console */

import {
  resolveRepoFromHint,
  type MultiSignalHint,
  type RepoResolveResult,
} from '@agent-bridge/agents'
import type { AttachedRepo } from '@agent-bridge/shared'

// ─── Synthetic fixtures ──────────────────────────────────────────────────

const REPO_BACKEND: AttachedRepo = {
  repo_id: 'rid-backend',
  remote_url: 'https://github.com/acme/backend.git',
  branch: 'main',
  label: 'backend',
  role: 'backend',
  description: null,
  aliases: ['api', 'svc'],
  status: 'ready',
}

const REPO_FRONTEND: AttachedRepo = {
  repo_id: 'rid-frontend',
  remote_url: 'https://github.com/acme/frontend.git',
  branch: 'main',
  label: 'frontend',
  role: 'frontend',
  description: null,
  aliases: ['web', 'fe'],
  status: 'ready',
}

const REPO_SHARED: AttachedRepo = {
  repo_id: 'rid-shared',
  remote_url: 'https://github.com/acme/shared.git',
  branch: 'main',
  label: 'shared',
  role: null,
  description: null,
  aliases: ['types'],
  status: 'ready',
}

const ALL_THREE = [REPO_BACKEND, REPO_FRONTEND, REPO_SHARED]
const ONLY_BACKEND = [REPO_BACKEND]

// ─── Tiny assertion harness ──────────────────────────────────────────────

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

function expectOk(
  res: RepoResolveResult,
  predicate: (r: Extract<RepoResolveResult, { ok: true }>) => boolean,
  label: string,
): boolean {
  if (res.ok !== true) {
    failures.push(`expected ok:true, got ok=${String(res.ok)} (${label})`)
    return false
  }
  return predicate(res)
}

// ─── Test cases ──────────────────────────────────────────────────────────

console.log('═'.repeat(60))
console.log(' Resolver scenarios smoke')
console.log('═'.repeat(60))

// ── 1. Empty hint ─────────────────────────────────────────────────────
{
  const r = resolveRepoFromHint({ repos: ONLY_BACKEND, hint: null })
  check(
    'empty hint + single repo → fallback_single_repo',
    expectOk(r, (s) => s.matched_signal === 'fallback_single_repo' && s.repo.repo_id === 'rid-backend', 'single'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: null, allowAll: true })
  check(
    'empty hint + multi-repo + allowAll → ok:all',
    r.ok === 'all' && r.repos.length === 3,
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: null, allowAll: false })
  check(
    'empty hint + multi-repo + !allowAll → clarify(repo_or_all)',
    r.ok === 'clarify' && r.kind === 'repo_or_all' && r.candidates.length === 3,
    r.ok === 'clarify' ? `candidates=${r.candidates.map((c) => c.label).join(',')}` : '',
  )
}

{
  const r = resolveRepoFromHint({
    repos: ALL_THREE,
    hint: null,
    allowAll: true,
    fallback: { repo: REPO_FRONTEND, matched_signal: 'remote_url' },
  })
  check(
    'empty hint + multi-repo + fallback → use fallback',
    expectOk(r, (s) => s.repo.repo_id === 'rid-frontend' && s.matched_signal === 'remote_url', 'fallback'),
  )
}

// ── 2. Single-signal hint ─────────────────────────────────────────────
{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'backend' })
  check(
    'repo_hint=role → matched_signal=role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'role', 'role'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'api' })
  check(
    'repo_hint=alias → matched_signal=alias',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'alias', 'alias'),
  )
}

{
  // `shared` has no role; alias is `types`. URL tail is `shared` after
  // .git suffix is stripped by urlTail's normalization. Match on url_tail.
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'shared' })
  check(
    'repo_hint=url_tail (no role match) → matched_signal=url_tail',
    expectOk(r, (s) => s.repo.repo_id === 'rid-shared' && s.matched_signal === 'url_tail', 'url_tail'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'nonexistent', allowAll: true })
  check(
    'unmatched hint + multi-repo → clarify',
    r.ok === 'clarify' && r.kind === 'repo_or_all',
  )
}

{
  const r = resolveRepoFromHint({ repos: ONLY_BACKEND, hint: 'nonexistent' })
  check(
    'unmatched hint + single repo → fallback to only repo',
    expectOk(r, (s) => s.matched_signal === 'fallback_single_repo', 'fallback-single'),
  )
}

// ── 3. Quote-mangling regression (the user's original bug) ────────────
{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '"backend"' })
  check(
    'double-quoted hint unquoted + matches role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'role', 'role'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: "'backend'" })
  check(
    'single-quoted hint unquoted + matches role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend', 'role'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '`backend`' })
  check(
    'backtick-quoted hint unquoted + matches role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend', 'role'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '""backend""' })
  check(
    'double-wrapped quotes → both layers stripped + matches role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend', 'role'),
  )
}

{
  // U+201C / U+201D — smart double quotes.
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '“backend”' })
  check(
    'smart double quotes (“…”) unquoted + matches role',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend', 'role'),
  )
}

// ── 4. Multi-signal precedence ────────────────────────────────────────
{
  // remote_url on backend, repo_hint on frontend's alias. remote_url wins.
  const hint: MultiSignalHint = {
    remote_url: 'https://github.com/acme/backend.git',
    repo_hint: 'fe',
  }
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint })
  check(
    'remote_url match wins over repo_hint alias on a different repo',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'remote_url', 'precedence'),
  )
}

{
  // No repo_hint, no remote_url; local_folder names `backend`'s role.
  const hint: MultiSignalHint = { local_folder: 'backend' }
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint })
  check(
    'local_folder used when other signals are absent',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'local_folder', 'local_folder'),
  )
}

{
  // Same remote_url with `git@host:owner/repo` SSH form should normalise
  // to the same canonical URL as the https one.
  const hint: MultiSignalHint = { remote_url: 'git@github.com:acme/backend.git' }
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint })
  check(
    'remote_url SSH form normalises to match HTTPS-stored URL',
    expectOk(r, (s) => s.repo.repo_id === 'rid-backend' && s.matched_signal === 'remote_url', 'ssh-form'),
  )
}

// ── 5. `__all__` sentinel ─────────────────────────────────────────────
{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '__all__', allowAll: true })
  check(
    '__all__ + allowAll → ok:all',
    r.ok === 'all' && r.repos.length === 3,
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: '__all__', allowAll: false })
  check(
    '__all__ + !allowAll → clarify(single_repo_required)',
    r.ok === 'clarify' && r.kind === 'single_repo_required',
    r.ok === 'clarify' ? `kind=${r.kind}` : '',
  )
}

// ── 6. No repos attached ──────────────────────────────────────────────
{
  const r = resolveRepoFromHint({ repos: [], hint: 'backend' })
  check(
    'empty repo set → ok:false, code:no_repos',
    r.ok === false && r.code === 'no_repos',
  )
}

// ── 7. Score table + suggested_replies shapes ────────────────────────
{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'backend' })
  check(
    'success score_table is an array',
    expectOk(r, (s) => Array.isArray(s.score_table), 'score_table'),
  )
}

{
  const r = resolveRepoFromHint({ repos: ALL_THREE, hint: 'nonexistent', allowAll: true })
  check(
    'clarify suggested_replies covers every candidate',
    r.ok === 'clarify' &&
      r.suggested_replies.length === r.candidates.length &&
      r.suggested_replies.every(
        (sr) => typeof sr.label === 'string' && typeof sr.args_patch.repo_hint === 'string',
      ),
  )
}

// ── 8. Effectively-empty LLM literals don't trip the resolver ────────
for (const lit of ['null', 'undefined', 'none', 'n/a', '-']) {
  const r = resolveRepoFromHint({ repos: ONLY_BACKEND, hint: lit })
  check(
    `repo_hint=${JSON.stringify(lit)} treated as no hint`,
    expectOk(r, (s) => s.matched_signal === 'fallback_single_repo', `lit=${lit}`),
  )
}

// ─── Report ──────────────────────────────────────────────────────────────

console.log('═'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failures:')
  for (const f of failures) console.log(`   - ${f}`)
  console.log('═'.repeat(60))
  process.exit(1)
}
console.log(' All checks passed.')
console.log('═'.repeat(60))
