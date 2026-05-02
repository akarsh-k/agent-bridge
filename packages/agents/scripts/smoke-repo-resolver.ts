/**
 * Pure-fn smoke for `resolveRepoHint` + `normalizeRemoteUrl`.
 *
 * No DB, no LLM, no network. just a fixture array of `AttachedRepo`
 * rows and a series of `(input, expected)` cases run inline. Mirrors
 * the cases described in `docs/ARCHITECTURE.md` §10.3 (resolver).
 *
 * Exit codes:
 *   0   every case passed
 *   1   at least one case failed; stderr lists the failures
 *
 * Run from repo root:
 *   pnpm --filter @agent-bridge/agents resolver:smoke
 *
 * Why a smoke script and not vitest/jest:
 *   This monorepo deliberately ships no test runner. see
 *   `packages/agents/scripts/smoke.ts` for the existing convention.
 *   Adding vitest is an infra decision worth its own discussion;
 *   until then this is the canonical way to assert pure-fn
 *   behaviour.
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

import type { AttachedRepo, CodingAgentHint } from '@agent-bridge/shared'

import {
  normalizeRemoteUrl,
  urlTail,
} from '../src/coding-agent/url-normalize.js'
import {
  resolveRelatedRepos,
  resolveRepoHint,
} from '../src/coding-agent/repo-resolver.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

const traveller: AttachedRepo = {
  repo_id: '11111111-1111-4111-8111-111111111111',
  remote_url: 'https://github.com/company/traveller-web',
  branch: 'main',
  label: 'frontend',
  role: 'frontend',
  description: 'customer-facing storefront',
  aliases: ['web-app', 'fe', 'client'],
  status: 'ready',
}

const api: AttachedRepo = {
  repo_id: '22222222-2222-4222-8222-222222222222',
  remote_url: 'git@github.com:company/traveller-api.git',
  branch: 'main',
  label: 'backend',
  role: 'backend',
  description: 'core REST API',
  aliases: ['bff', 'api'],
  status: 'ready',
}

const mobile: AttachedRepo = {
  repo_id: '33333333-3333-4333-8333-333333333333',
  remote_url: 'https://github.com/company/traveller-mobile.git',
  branch: 'main',
  label: 'mobile',
  role: 'mobile',
  description: null,
  aliases: [],
  status: 'ready',
}

const indexing: AttachedRepo = {
  repo_id: '44444444-4444-4444-8444-444444444444',
  remote_url: 'https://github.com/company/traveller-workers',
  branch: 'main',
  label: 'workers',
  role: 'workers',
  description: null,
  aliases: [],
  status: 'indexing',
}

const ALL = [traveller, api, mobile, indexing] as const

// ─── Tiny assertion harness ──────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, predicate: boolean, detail?: string): void {
  if (predicate) {
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

// ─── url-normalize cases ─────────────────────────────────────────────────

group('normalizeRemoteUrl folds ssh and https forms', () => {
  const a = normalizeRemoteUrl('https://github.com/owner/repo.git')
  const b = normalizeRemoteUrl('git@github.com:owner/repo.git')
  const c = normalizeRemoteUrl('https://GitHub.com/owner/repo/')
  const d = normalizeRemoteUrl('ssh://git@github.com/owner/repo')
  const e = normalizeRemoteUrl('github.com/owner/repo')
  check('https/.git', a === 'github.com/owner/repo', `got "${a}"`)
  check('ssh short', b === 'github.com/owner/repo', `got "${b}"`)
  check('uppercase host + trailing slash', c === 'github.com/owner/repo', `got "${c}"`)
  check('ssh:// scheme', d === 'github.com/owner/repo', `got "${d}"`)
  check('bare host/path', e === 'github.com/owner/repo', `got "${e}"`)
})

group('urlTail extracts last segment', () => {
  check(
    'extracts repo name',
    urlTail('https://github.com/owner/traveller-web.git') === 'traveller-web',
  )
  check('handles ssh', urlTail('git@github.com:co/repo') === 'repo')
  check('empty input', urlTail('') === '')
})

// ─── resolver: no-signal shortcut ────────────────────────────────────────

group('no signal. empty hint', () => {
  const empty: CodingAgentHint = {}

  const zero = resolveRepoHint({ repos: [], hint: empty, allowAllRepos: true })
  check(
    'no repos attached',
    zero.scope === 'error' && zero.code === 'no_repos_attached',
  )

  const one = resolveRepoHint({
    repos: [traveller],
    hint: empty,
    allowAllRepos: true,
  })
  check(
    'single repo agent → high confidence single',
    one.scope === 'single' && one.confidence === 'high',
  )

  const many = resolveRepoHint({
    repos: ALL,
    hint: empty,
    allowAllRepos: true,
  })
  check(
    'multi-repo agent + allow_all → clarification',
    many.scope === 'clarification' &&
      many.kind === 'repo_or_all' &&
      many.allow_all_repos === true,
    many.scope === 'clarification' ? `kind=${many.kind}` : `scope=${many.scope}`,
  )

  const manySingle = resolveRepoHint({
    repos: ALL,
    hint: empty,
    allowAllRepos: false,
  })
  check(
    'multi-repo agent + single-only tool → clarification without all_repos',
    manySingle.scope === 'clarification' &&
      manySingle.allow_all_repos === false,
  )
})

// ─── resolver: __all__ sentinel ──────────────────────────────────────────

group('__all__ sentinel', () => {
  const accept = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: '__all__' },
    allowAllRepos: true,
  })
  check(
    'accept-list returns scope=all with ready repos only',
    accept.scope === 'all' &&
      accept.repos.length === 3 &&
      accept.repos.every((r) => r.status === 'ready'),
    accept.scope === 'all' ? `count=${accept.repos.length}` : `scope=${accept.scope}`,
  )

  const reject = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: '__all__' },
    allowAllRepos: false,
  })
  check(
    'reject-list returns clarification single_repo_required',
    reject.scope === 'clarification' && reject.kind === 'single_repo_required',
  )
})

// ─── resolver: remote_url exact match ────────────────────────────────────

group('remote_url exact match', () => {
  const httpsHit = resolveRepoHint({
    repos: ALL,
    hint: { remote_url: 'https://github.com/company/traveller-web.git' },
    allowAllRepos: true,
  })
  check(
    'https match (with .git) folds and resolves traveller',
    httpsHit.scope === 'single' &&
      httpsHit.repo.repo_id === traveller.repo_id &&
      httpsHit.matched_signal === 'remote_url' &&
      httpsHit.confidence === 'high',
  )

  const sshHit = resolveRepoHint({
    repos: ALL,
    hint: { remote_url: 'git@github.com:company/traveller-api.git' },
    allowAllRepos: true,
  })
  check(
    'ssh form folds and resolves api',
    sshHit.scope === 'single' && sshHit.repo.repo_id === api.repo_id,
  )

  const httpsForApi = resolveRepoHint({
    repos: ALL,
    hint: { remote_url: 'https://github.com/company/traveller-api' },
    allowAllRepos: true,
  })
  check(
    'https form for api (no .git) still folds to ssh-stored url',
    httpsForApi.scope === 'single' && httpsForApi.repo.repo_id === api.repo_id,
  )
})

// ─── resolver: exact role/alias match ────────────────────────────────────

group('exact role/alias match', () => {
  const role = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'frontend' },
    allowAllRepos: false,
  })
  check(
    'exact role match',
    role.scope === 'single' &&
      role.repo.repo_id === traveller.repo_id &&
      role.matched_signal === 'role',
  )

  const alias = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'web-app' },
    allowAllRepos: false,
  })
  check(
    'exact alias match resolves to traveller',
    alias.scope === 'single' &&
      alias.repo.repo_id === traveller.repo_id &&
      alias.matched_signal === 'alias',
  )

  const caseInsensitive = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'FRONTEND' },
    allowAllRepos: false,
  })
  check(
    'case-insensitive',
    caseInsensitive.scope === 'single' &&
      caseInsensitive.repo.repo_id === traveller.repo_id,
  )

  const localFolderAlias = resolveRepoHint({
    repos: ALL,
    hint: { local_folder: 'web-app' },
    allowAllRepos: false,
  })
  check(
    'local_folder hits alias and reports local_folder signal',
    localFolderAlias.scope === 'single' &&
      localFolderAlias.repo.repo_id === traveller.repo_id &&
      localFolderAlias.matched_signal === 'local_folder',
  )

  const urlTailMatch = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'traveller-web' },
    allowAllRepos: false,
  })
  check(
    'url tail exact match',
    urlTailMatch.scope === 'single' &&
      urlTailMatch.repo.repo_id === traveller.repo_id &&
      urlTailMatch.matched_signal === 'url_tail',
  )
})

// ─── resolver: fuzzy match ───────────────────────────────────────────────

group('fuzzy match', () => {
  const typo = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'frontnd' },
    allowAllRepos: false,
  })
  check(
    'typo against role → high or medium with frontend top',
    typo.scope === 'single' && typo.repo.repo_id === traveller.repo_id,
  )

  const folderFuzzy = resolveRepoHint({
    repos: [
      // Variant where alias does NOT include 'web-app'. exercise the
      // fuzzy fallback path.
      { ...traveller, aliases: [] },
      api,
      mobile,
    ],
    hint: { local_folder: 'traveller-web' },
    allowAllRepos: false,
  })
  check(
    'fuzzy on local_folder when no alias',
    folderFuzzy.scope === 'single' &&
      folderFuzzy.repo.repo_id === traveller.repo_id,
  )
})

// ─── resolver: ambiguous + not_found ─────────────────────────────────────

group('ambiguous + not_found', () => {
  // Two near-identical fuzzy hits → ambiguous.
  const ambigPool: AttachedRepo[] = [
    { ...traveller, role: 'frontend-web', aliases: [], label: 'frontend-web' },
    { ...api, role: 'frontend-api', aliases: [], label: 'frontend-api' },
  ]
  const ambig = resolveRepoHint({
    repos: ambigPool,
    hint: { repo_hint: 'frontend' },
    allowAllRepos: false,
  })
  check(
    'near-tied fuzzy match returns repo_ambiguous',
    ambig.scope === 'error' && ambig.code === 'repo_ambiguous',
    ambig.scope === 'error' ? `code=${ambig.code}` : `scope=${ambig.scope}`,
  )

  const miss = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'something-totally-different' },
    allowAllRepos: false,
  })
  check(
    'no plausible match returns repo_not_found',
    miss.scope === 'error' && miss.code === 'repo_not_found',
  )
})

// ─── resolver: status gate ───────────────────────────────────────────────

group('status gate', () => {
  const indexingHit = resolveRepoHint({
    repos: ALL,
    hint: { repo_hint: 'workers' },
    allowAllRepos: false,
  })
  check(
    'non-ready repo surfaces repo_not_ready',
    indexingHit.scope === 'error' &&
      indexingHit.code === 'repo_not_ready' &&
      indexingHit.status === 'indexing',
    indexingHit.scope === 'error' ? `code=${indexingHit.code}` : `scope=${indexingHit.scope}`,
  )
})

// ─── resolveRelatedRepos ─────────────────────────────────────────────────

group('resolveRelatedRepos', () => {
  const out = resolveRelatedRepos({
    repos: ALL,
    hints: ['frontend', 'web-app', 'unknown', 'mobile', '  '],
  })
  check(
    'dedupes alias + role hits (frontend + web-app → 1 repo)',
    out.resolved.length === 2 &&
      out.resolved.some((r) => r.repo_id === traveller.repo_id) &&
      out.resolved.some((r) => r.repo_id === mobile.repo_id),
    `resolved=${out.resolved.length}`,
  )
  check(
    'unresolved keeps unknown hint',
    out.unresolved.length === 1 && out.unresolved[0]?.hint === 'unknown',
    `unresolved=${JSON.stringify(out.unresolved)}`,
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
