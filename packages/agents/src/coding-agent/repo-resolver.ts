/**
 * Pure resolver: given the agent's attached repos and an IDE-supplied
 * hint, decide which repo (or set of repos) the call targets.
 *
 * Algorithm (steady-state spec lives in `docs/ARCHITECTURE.md` §10.3):
 *
 *   1. No-signal shortcut. 0/1/many repos → resolved / clarification.
 *   2. `__all__` sentinel. fan out, gated by `allowAllRepos`.
 *   3. Exact `remote_url` match. highest-signal identifier.
 *   4. Exact id-or-slug. UUID, role, alias, URL-tail (case-insensitive).
 *   5. Token-set + Levenshtein over `[repoHint, localFolder, urlTail]`.
 *   6. Decision: high if (top ≥ .85 AND margin ≥ .15);
 *                medium if (top ≥ .6 AND margin ≥ .15);
 *                ambiguous if (top ≥ .6 AND margin < .15);
 *                not_found otherwise.
 *   7. Status check. non-`ready` repos surface as `repo_not_ready`.
 *
 * Pure function. no I/O, no DB, no random. Inputs are the loaded
 * candidate array (from `loadAttachedRepos`) and the parsed hint.
 * The audit-event publisher (P6) lives elsewhere; this module just
 * returns the structured outcome.
 */

import {
  ALL_REPOS_SENTINEL,
  type AttachedRepo,
  type CodingAgentHint,
  type MatchedSignal,
  type NeedsClarification,
  type RepoMatchScore,
  type RepoResolution,
  type RepoResolverError,
  type ResolvedAllRepos,
  type ResolvedSingleRepo,
  type SuggestedReply,
} from '@agent-bridge/shared'

import { normalizeRemoteUrl, urlTail } from './url-normalize.js'

// ─── Tunables ────────────────────────────────────────────────────────────

const HIGH_SCORE = 0.85
const MEDIUM_SCORE = 0.6
const MIN_MARGIN = 0.15
const READY_BONUS = 0.1
const ALIAS_FOLDER_BONUS = 0.05
const TOP_N_CANDIDATES = 3
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Public types ────────────────────────────────────────────────────────

export interface ResolveRepoHintInput {
  /** Candidate set, typically from `loadAttachedRepos(...)`. */
  readonly repos: readonly AttachedRepo[]
  /** Multi-signal hint object from the IDE coding agent. */
  readonly hint: CodingAgentHint
  /**
   * Whether the calling tool semantically supports
   * `repo_hint: '__all__'` (e.g. `ask_general` → true,
   * `plan_feature` → false).
   */
  readonly allowAllRepos: boolean
}

// ─── Public function ─────────────────────────────────────────────────────

export function resolveRepoHint(input: ResolveRepoHintInput): RepoResolution {
  const { repos, hint, allowAllRepos } = input

  // Step 0. agent has nothing attached. Guard before reading hint
  // fields so the IDE agent gets the correct first signal.
  if (repos.length === 0) {
    return errorResult('no_repos_attached', 'no repos attached to this agent')
  }

  const hintRepoHint = hint.repo_hint?.trim() ?? ''
  const hintRemoteUrl = hint.remote_url?.trim() ?? ''
  const hintLocalFolder = hint.local_folder?.trim() ?? ''
  const hintBranch = hint.branch?.trim() ?? ''

  // Step 2. `__all__` sentinel. Checked early so the IDE agent's
  // intent isn't accidentally matched against an alias literally
  // named "__all__" (vanishingly unlikely but cheap to handle).
  if (hintRepoHint === ALL_REPOS_SENTINEL) {
    if (!allowAllRepos) {
      return clarificationResult({
        kind: 'single_repo_required',
        candidates: repos,
        message:
          'this tool operates on a single repo. pick one instead of __all__.',
        allow_all_repos: false,
      })
    }
    const ready = repos.filter((r) => r.status === 'ready')
    return {
      scope: 'all',
      repos: ready,
    } satisfies ResolvedAllRepos
  }

  // Step 1. no-signal shortcut. Branches on repo count once we know
  // the IDE didn't hand us anything to score against.
  const anySignal =
    hintRepoHint.length > 0 ||
    hintRemoteUrl.length > 0 ||
    hintLocalFolder.length > 0
  if (!anySignal) {
    if (repos.length === 1) {
      const only = repos[0]!
      return statusGate(only, {
        scope: 'single',
        repo: only,
        confidence: 'high',
        matched_signal: 'role',
        score_table: [],
        warnings: [],
      })
    }
    return clarificationResult({
      kind: 'repo_or_all',
      candidates: repos,
      message:
        'multiple repos are attached. Specify a repo (via repo_hint / remote_url / local_folder) or pass repo_hint: "__all__" to ask across every repo.',
      allow_all_repos: allowAllRepos,
    })
  }

  // Step 3. exact remote_url match. Highest-signal identifier:
  // matching here short-circuits the scoring loop entirely.
  if (hintRemoteUrl.length > 0) {
    const normHint = normalizeRemoteUrl(hintRemoteUrl)
    const matches = repos.filter(
      (r) => normalizeRemoteUrl(r.remote_url) === normHint,
    )
    if (matches.length === 1) {
      const repo = matches[0]!
      return statusGate(repo, {
        scope: 'single',
        repo,
        confidence: 'high',
        matched_signal: 'remote_url',
        score_table: [
          {
            repo_id: repo.repo_id,
            label: repo.label,
            score: 1,
            matched_signal: 'remote_url',
          },
        ],
        warnings: [],
      })
    }
    if (matches.length > 1) {
      // Same URL on multiple branches. disambiguate by `hint.branch`.
      const branchMatch = matches.filter((r) => r.branch === hintBranch)
      if (branchMatch.length === 1) {
        const repo = branchMatch[0]!
        return statusGate(repo, {
          scope: 'single',
          repo,
          confidence: 'high',
          matched_signal: 'remote_url',
          score_table: matches.map((r) => ({
            repo_id: r.repo_id,
            label: r.label,
            score: r.repo_id === repo.repo_id ? 1 : 0.95,
            matched_signal: 'remote_url',
          })),
          warnings: [],
        })
      }
      // Same URL, multiple branches, no tiebreaker → clarification.
      return clarificationResult({
        kind: 'repo_or_all',
        candidates: matches,
        message: `${matches.length} repos share remote_url ${hintRemoteUrl} on different branches. pass branch as a tiebreaker.`,
        allow_all_repos: false,
      })
    }
    // No exact remote_url match. fall through to fuzzy scoring on
    // the URL tail in case the hint URL was slightly different.
  }

  // Step 4. exact id-or-slug. UUID, role, alias, URL tail.
  const exact = findExactMatch(repos, hintRepoHint, hintLocalFolder)
  if (exact) {
    const score: RepoMatchScore = {
      repo_id: exact.repo.repo_id,
      label: exact.repo.label,
      score: 1,
      matched_signal: exact.signal,
    }
    return statusGate(exact.repo, {
      scope: 'single',
      repo: exact.repo,
      confidence: 'high',
      matched_signal: exact.signal,
      score_table: [score],
      warnings: [],
    })
  }

  // Step 5. fuzzy scoring over the combined hint pool.
  const pool: ReadonlyArray<{ value: string; signal: MatchedSignal }> = [
    ...(hintRepoHint ? [{ value: hintRepoHint, signal: 'role' as const }] : []),
    ...(hintLocalFolder
      ? [{ value: hintLocalFolder, signal: 'local_folder' as const }]
      : []),
    ...(hintRemoteUrl
      ? [{ value: urlTail(hintRemoteUrl), signal: 'url_tail' as const }]
      : []),
  ]
  const scored = repos.map((r) => scoreCandidate(r, pool)).sort((a, b) => b.score - a.score)
  const scoreTable: RepoMatchScore[] = scored
    .slice(0, TOP_N_CANDIDATES)
    .map((s) => ({
      repo_id: s.repo.repo_id,
      label: s.repo.label,
      score: round(s.score),
      matched_signal: s.signal,
    }))

  const top = scored[0]
  const second = scored[1]
  const topScore = top?.score ?? 0
  const secondScore = second?.score ?? 0
  const margin = topScore - secondScore

  // Step 6. decision rule. Two thresholds: score (plausibility) and
  // margin (clear winner over runner-up).
  if (top && topScore >= HIGH_SCORE && margin >= MIN_MARGIN) {
    return statusGate(top.repo, {
      scope: 'single',
      repo: top.repo,
      confidence: 'high',
      matched_signal: top.signal,
      score_table: scoreTable,
      warnings: [],
    })
  }
  if (top && topScore >= MEDIUM_SCORE && margin >= MIN_MARGIN) {
    const warnings: string[] = []
    if (second && secondScore >= MEDIUM_SCORE) {
      warnings.push(
        `next-best candidate "${second.repo.label}" scored ${round(secondScore)} (winner ${round(topScore)}); double-check the match`,
      )
    }
    return statusGate(top.repo, {
      scope: 'single',
      repo: top.repo,
      confidence: 'medium',
      matched_signal: top.signal,
      score_table: scoreTable,
      warnings,
    })
  }
  if (top && topScore >= MEDIUM_SCORE) {
    // Plausible but too close to call. explicit ambiguity.
    return errorResult(
      'repo_ambiguous',
      `repo hint matched ${scoreTable.length} candidates within ${MIN_MARGIN.toFixed(2)} of each other; please disambiguate`,
      scoreTable,
    )
  }

  // Step 7 fallthrough. nothing scored above the medium threshold.
  // Surface the candidate list AND a hint to the operator about the
  // alias escape hatch (since this is the most common cause of a miss).
  const probe = hintRepoHint || hintLocalFolder || hintRemoteUrl || '<empty>'
  return errorResult(
    'repo_not_found',
    `no attached repo matches "${probe}". If this repo IS attached under a different name, add "${probe}" to its aliases on the agent's repo card.`,
    scoreTable,
  )
}

// ─── Internals ───────────────────────────────────────────────────────────

interface ExactMatch {
  readonly repo: AttachedRepo
  readonly signal: MatchedSignal
}

/**
 * Try to find a deterministic, no-fuzz match. Returns the first hit in
 * priority order (UUID, role, alias, URL tail) so an operator who has
 * intentionally aliased a repo doesn't get surprised by URL-tail
 * collisions on a similarly-named repo elsewhere.
 *
 * `hintRepoHint` and `hintLocalFolder` are both treated as
 * candidate names. operators commonly forget to copy the local
 * folder into aliases, so we let the local folder hit the same exact
 * comparators as the role/alias check.
 */
function findExactMatch(
  repos: readonly AttachedRepo[],
  hintRepoHint: string,
  hintLocalFolder: string,
): ExactMatch | null {
  const probes: ReadonlyArray<{ value: string; isFolder: boolean }> = [
    ...(hintRepoHint ? [{ value: hintRepoHint, isFolder: false }] : []),
    ...(hintLocalFolder ? [{ value: hintLocalFolder, isFolder: true }] : []),
  ]
  if (probes.length === 0) return null

  // UUID is unambiguous. only valid against the canonical repo_id.
  for (const p of probes) {
    if (UUID_RE.test(p.value)) {
      const hit = repos.find((r) => r.repo_id.toLowerCase() === p.value.toLowerCase())
      if (hit) return { repo: hit, signal: 'role' }
    }
  }

  // Role / alias / URL tail (case-insensitive). Walk repos in their
  // sorted order so two equally valid exact matches always pick the
  // same repo deterministically.
  for (const p of probes) {
    const lower = p.value.toLowerCase()
    for (const r of repos) {
      if (r.role && r.role.toLowerCase() === lower) {
        return {
          repo: r,
          signal: p.isFolder ? 'local_folder' : 'role',
        }
      }
      for (const a of r.aliases) {
        if (a.toLowerCase() === lower) {
          return {
            repo: r,
            signal: p.isFolder ? 'local_folder' : 'alias',
          }
        }
      }
      const tail = urlTail(r.remote_url)
      if (tail && tail.toLowerCase() === lower) {
        return {
          repo: r,
          signal: p.isFolder ? 'local_folder' : 'url_tail',
        }
      }
    }
  }

  return null
}

interface ScoredCandidate {
  readonly repo: AttachedRepo
  readonly score: number
  readonly signal: MatchedSignal
}

/**
 * Score one candidate against every entry in the hint pool, taking the
 * max. different signals contribute independently and we want the
 * best one. Bonuses are applied AFTER the per-pool max so they don't
 * compound across signals.
 */
function scoreCandidate(
  repo: AttachedRepo,
  pool: ReadonlyArray<{ value: string; signal: MatchedSignal }>,
): ScoredCandidate {
  const candidateLabels: ReadonlyArray<{
    value: string
    signal: MatchedSignal
  }> = [
    ...(repo.role ? [{ value: repo.role, signal: 'role' as const }] : []),
    ...repo.aliases.map((a) => ({ value: a, signal: 'alias' as const })),
    {
      value: urlTail(repo.remote_url) || repo.label,
      signal: 'url_tail' as const,
    },
  ]

  let best = 0
  let bestSignal: MatchedSignal = 'role'
  let matchedFromFolder = false

  for (const probe of pool) {
    for (const cand of candidateLabels) {
      const score = scorePair(probe.value, cand.value)
      if (score > best) {
        best = score
        bestSignal = probe.signal === 'local_folder' ? 'local_folder' : cand.signal
        matchedFromFolder = probe.signal === 'local_folder'
      }
    }
  }

  if (repo.status === 'ready') best += READY_BONUS
  if (matchedFromFolder && repo.aliases.length > 0) best += ALIAS_FOLDER_BONUS

  return {
    repo,
    score: clamp(best, 0, 2),
    signal: bestSignal,
  }
}

/**
 * Token-set Jaccard ∪ Levenshtein. Both axes contribute. token-set
 * catches "front-end" ↔ "frontend"; Levenshtein catches "frt" ↔
 * "frontend" (typo, same prefix). We take the max so a strong signal
 * on one axis isn't pulled down by a weak result on the other.
 */
function scorePair(hint: string, candidate: string): number {
  const a = hint.trim().toLowerCase()
  const b = candidate.trim().toLowerCase()
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1

  const tokensA = tokens(a)
  const tokensB = tokens(b)
  const jaccard = jaccardIndex(tokensA, tokensB)

  const lev = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  const levScore = maxLen === 0 ? 0 : 1 - lev / maxLen

  return Math.max(jaccard, levScore)
}

const SPLIT_RE = /[-_/.\s]+/

function tokens(s: string): Set<string> {
  return new Set(s.split(SPLIT_RE).filter((t) => t.length > 0))
}

function jaccardIndex(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Classic two-row Levenshtein. Inputs are tiny (≤ ~60 chars on either
 * side) so we don't bother with bit-parallel tricks. Returns the
 * edit distance, NOT a similarity score. the caller normalises.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const m = a.length
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const del = (prev[j] ?? 0) + 1
      const ins = (curr[j - 1] ?? 0) + 1
      const sub = (prev[j - 1] ?? 0) + cost
      curr[j] = Math.min(del, ins, sub)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n] ?? 0
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ─── Result builders ─────────────────────────────────────────────────────

function statusGate(
  repo: AttachedRepo,
  ok: ResolvedSingleRepo,
): RepoResolution {
  if (repo.status !== 'ready') {
    return {
      scope: 'error',
      code: 'repo_not_ready',
      message: `repo "${repo.label}" is currently ${repo.status}; try again after the indexing job finishes.`,
      candidates: [
        {
          repo_id: repo.repo_id,
          label: repo.label,
          score: 1,
          matched_signal: ok.matched_signal,
        },
      ],
      status: repo.status,
    } satisfies RepoResolverError
  }
  return ok
}

function errorResult(
  code: 'no_repos_attached' | 'repo_not_found' | 'repo_ambiguous',
  message: string,
  candidates: RepoMatchScore[] = [],
): RepoResolverError {
  return { scope: 'error', code, message, candidates }
}

function clarificationResult(args: {
  kind: 'repo_or_all' | 'single_repo_required'
  candidates: readonly AttachedRepo[]
  message: string
  allow_all_repos: boolean
}): NeedsClarification {
  const { kind, candidates, message, allow_all_repos } = args

  // Pre-bake `suggested_replies` so the IDE can render a one-click
  // picker. Per-repo replies set `repo_hint` to the friendly label;
  // the "Across all repos" reply only appears when the tool accepts
  // the `__all__` sentinel.
  const suggested: SuggestedReply[] = candidates.map((r) => ({
    label: `Use ${r.label}`,
    args_patch: { repo_hint: r.label },
  }))
  if (allow_all_repos) {
    suggested.push({
      label: 'Across all attached repos',
      args_patch: { repo_hint: ALL_REPOS_SENTINEL },
    })
  }

  return {
    scope: 'clarification',
    kind,
    candidates: [...candidates],
    allow_all_repos,
    message,
    suggested_replies: suggested,
  }
}

// ─── Convenience: type guards ────────────────────────────────────────────

export function isResolvedSingle(
  v: RepoResolution,
): v is ResolvedSingleRepo {
  return v.scope === 'single'
}
export function isResolvedAll(v: RepoResolution): v is ResolvedAllRepos {
  return v.scope === 'all'
}
export function isClarification(
  v: RepoResolution,
): v is NeedsClarification {
  return v.scope === 'clarification'
}
export function isResolverError(
  v: RepoResolution,
): v is RepoResolverError {
  return v.scope === 'error'
}

/**
 * Resolve an array of `related_repos` hints. Per §7.5 of the planning
 * doc: each hint is resolved independently; failures become
 * `unresolved` entries instead of failing the whole call (the field
 * is hint-typed by name).
 */
export function resolveRelatedRepos(args: {
  repos: readonly AttachedRepo[]
  hints: readonly string[]
}): {
  resolved: AttachedRepo[]
  unresolved: Array<{ hint: string; reason: string }>
} {
  const resolved: AttachedRepo[] = []
  const unresolved: Array<{ hint: string; reason: string }> = []
  const seen = new Set<string>()

  for (const hint of args.hints) {
    const trimmed = hint.trim()
    if (trimmed.length === 0) continue
    const result = resolveRepoHint({
      repos: args.repos,
      hint: { repo_hint: trimmed },
      // Related repos are a hint pool. the all-repos sentinel doesn't
      // belong here. Operators wanting "everything else" should leave
      // `related_repos` empty and rely on `gitnexus_impact`.
      allowAllRepos: false,
    })
    if (isResolvedSingle(result)) {
      if (!seen.has(result.repo.repo_id)) {
        seen.add(result.repo.repo_id)
        resolved.push(result.repo)
      }
    } else if (isClarification(result)) {
      unresolved.push({
        hint: trimmed,
        reason:
          result.kind === 'repo_or_all'
            ? 'matched multiple candidates'
            : 'tool requires a single repo',
      })
    } else if (isResolverError(result)) {
      unresolved.push({ hint: trimmed, reason: result.message })
    }
  }

  return { resolved, unresolved }
}

/**
 * Convenience for the bridge handler. convert a `RepoResolverError`
 * into a `CodingAgentErrorEnvelope` (defined in shared) without each
 * caller re-shaping the discriminated union by hand.
 */
export function repoResolverErrorToEnvelope(err: RepoResolverError): {
  ok: false
  code: 'no_repos_attached' | 'repo_not_found' | 'repo_ambiguous' | 'repo_not_ready'
  message: string
  candidates?: RepoMatchScore[]
} {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    ...(err.candidates.length > 0 ? { candidates: err.candidates } : {}),
  }
}
