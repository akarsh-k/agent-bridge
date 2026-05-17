/**
 * Resolve a repo from a hint against the agent's attached repos
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Two input shapes:
 *   1. A single string (legacy single-signal path — friendly label /
 *      alias / URL tail / `__all__`). Used by wrappers' LLM-supplied
 *      `repo_hint`.
 *   2. A structured `MultiSignalHint` carrying any of `repo_hint`,
 *      `remote_url`, `local_folder`, `branch`. Used by the bridge
 *      handler's pre-resolution step: the IDE knows `remote_url` from
 *      `git remote get-url origin`, which is the highest-fidelity
 *      signal we can get and bypasses the LLM-as-translator step
 *      entirely (no quote-mangling, no name guessing).
 *
 * Output is a discriminated union:
 *   - `{ok: true}`     — single repo resolved + `matched_signal`
 *   - `{ok: 'all'}`    — fan-out across every attached repo (`__all__`
 *                        sentinel or hint absent with `allowAll: true`)
 *   - `{ok: 'clarify'}`— multi-repo agent, signal weak or missing.
 *                        Carries pre-baked `suggested_replies` so the
 *                        IDE LLM (or a picker UI) can pick one without
 *                        guessing. Distinct from `ok: false` so callers
 *                        can short-circuit before dispatching a run.
 *   - `{ok: false}`    — unrecoverable (no repos attached) or hard miss
 *                        with no plausible candidate list.
 *
 * Lightweight by design: wrapper tools are called from inside our own
 * Mastra agent, which already has access to the attached repo inventory
 * and can re-prompt the user. A full multi-stage retrieval scorer is
 * overkill here.
 */

import type { AttachedRepo } from '@agent-bridge/shared'

import { normalizeRemoteUrl, urlTail } from './url-normalize.js'

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Which signal in the hint object produced the match. Surfaced on
 * successful resolutions so the IDE / operator can answer "why did
 * the resolver pick this repo?" without re-running the scorer.
 */
export type MatchedSignal =
  | 'remote_url'
  | 'role'
  | 'alias'
  | 'url_tail'
  | 'local_folder'
  /** Single-repo agent, no signal matched: we fall back to the only repo. */
  | 'fallback_single_repo'

/**
 * Structured hint object the bridge handler builds from the IDE's
 * `inspect_codebase` args. Mirrors the input keys advertised in
 * `INSPECT_CODEBASE_METADATA`.
 */
export interface MultiSignalHint {
  readonly repo_hint?: string | null
  readonly remote_url?: string | null
  readonly local_folder?: string | null
  readonly branch?: string | null
}

export interface ScoreEntry {
  readonly repo_id: string
  readonly label: string
  readonly score: number
  /** `null` when no signal matched this candidate. */
  readonly matched_signal: MatchedSignal | null
}

export interface SuggestedReply {
  readonly label: string
  readonly args_patch: MultiSignalHint
}

export type RepoResolveResult =
  | {
      ok: true
      repo: AttachedRepo
      matched_signal: MatchedSignal
      /** Top-N candidates with their best signal + score. Empty for single-repo fallback. */
      score_table: readonly ScoreEntry[]
    }
  | { ok: 'all'; repos: readonly AttachedRepo[] }
  | {
      ok: 'clarify'
      kind: 'repo_or_all' | 'single_repo_required'
      candidates: readonly AttachedRepo[]
      allow_all_repos: boolean
      message: string
      suggested_replies: readonly SuggestedReply[]
    }
  | {
      ok: false
      code: 'no_repos' | 'not_found' | 'ambiguous'
      message: string
      candidates: readonly string[]
    }

export interface ResolveInput {
  readonly repos: readonly AttachedRepo[]
  /**
   * Either a single string (legacy LLM-supplied `repo_hint`) or a
   * structured multi-signal hint object (bridge-handler pre-resolution).
   * `null` / `undefined` / empty string is treated as "no hint".
   */
  readonly hint: string | MultiSignalHint | null | undefined
  /**
   * When `true` and the hint is missing/ambiguous, allow returning the
   * full repo list. Wrappers like `find_in_codebase` opt in; single-repo
   * wrappers (`assess_change_impact`) leave this `false`.
   */
  readonly allowAll?: boolean
  /**
   * Optional pre-resolved repo to use as a default when `hint` is empty
   * (e.g. the bridge handler's structured-signal pre-resolution lives
   * here). LLM-supplied hints still take precedence so a multi-repo
   * agent can follow cross-repo relationships without being locked to the IDE's
   * pick.
   */
  readonly fallback?: {
    readonly repo: AttachedRepo
    readonly matched_signal: MatchedSignal
  } | null
}

// ─── Internals ───────────────────────────────────────────────────────────

const ALL_SENTINEL = '__all__'

/**
 * String values LLMs frequently emit for "no value" instead of omitting
 * the optional field. The wrapper-tool input schema marks `repo_hint`
 * as nullable + optional, but some models stringify `null` / `undefined`
 * directly into the tool-call args. Treat these the same as no hint.
 */
const EMPTY_HINT_LITERALS = new Set(['null', 'undefined', 'none', 'n/a', '-'])

function isEffectivelyEmpty(s: string | null | undefined): boolean {
  if (!s) return true
  const trimmed = s.trim()
  if (trimmed.length === 0) return true
  return EMPTY_HINT_LITERALS.has(trimmed.toLowerCase())
}

/**
 * Strip matching surrounding quote characters from a hint. IDE LLMs
 * (Cursor, Codex) sometimes stringify a repo name with the quotes
 * left in, producing `repo_hint: "\"react-stripe-js\""`. Without this,
 * the resolver compares `"react-stripe-js"` (with quotes) against
 * `react-stripe-js` and returns `not_found`, the model retries the
 * same wrong call, and the run wastes its step budget.
 *
 * Strip in a bounded loop to handle the (rarer) double-wrapped case.
 */
function unquote(s: string): string {
  let out = s
  for (let i = 0; i < 2; i++) {
    if (out.length < 2) return out
    const first = out[0]
    const last = out[out.length - 1]
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`') ||
      (first === '“' && last === '”') ||
      (first === '‘' && last === '’')
    ) {
      out = out.slice(1, -1).trim()
      continue
    }
    return out
  }
  return out
}

/** Normalised, deduplicated view of a `MultiSignalHint`. */
interface NormalizedHint {
  readonly repo_hint: string | null
  readonly remote_url: string | null
  readonly local_folder: string | null
}

function normalizeHint(
  hint: string | MultiSignalHint | null | undefined,
): NormalizedHint {
  if (hint == null) {
    return { repo_hint: null, remote_url: null, local_folder: null }
  }
  if (typeof hint === 'string') {
    const t = unquote(hint.trim())
    return {
      repo_hint: isEffectivelyEmpty(t) ? null : t,
      remote_url: null,
      local_folder: null,
    }
  }
  const norm = (raw: string | null | undefined): string | null => {
    if (raw == null) return null
    const t = unquote(raw.trim())
    return isEffectivelyEmpty(t) ? null : t
  }
  return {
    repo_hint: norm(hint.repo_hint),
    remote_url: norm(hint.remote_url),
    local_folder: norm(hint.local_folder),
  }
}

/**
 * Per-signal score weights. Higher = more reliable signal. The values
 * are spaced enough that one strong signal always beats two weak ones,
 * so a `remote_url` match never loses to a `local_folder` coincidence
 * on a different repo.
 */
const SIGNAL_WEIGHT: Record<MatchedSignal, number> = {
  remote_url: 1.0,
  role: 0.9,
  alias: 0.85,
  url_tail: 0.7,
  local_folder: 0.55,
  // Synthetic, never produced by scoreCandidate. Listed for completeness.
  fallback_single_repo: 0.5,
}

/**
 * Score one candidate repo against the normalised hint. Returns the
 * highest-fidelity signal that matched, or `null` if none did.
 */
function scoreCandidate(
  r: AttachedRepo,
  hint: NormalizedHint,
): { score: number; signal: MatchedSignal | null } {
  // 1. remote_url — strongest. Normalise both sides so trivial diffs
  //    (https vs git@, .git suffix, trailing slash) collapse.
  if (hint.remote_url) {
    const want = normalizeRemoteUrl(hint.remote_url)
    if (want.length > 0 && normalizeRemoteUrl(r.remote_url) === want) {
      return { score: SIGNAL_WEIGHT.remote_url, signal: 'remote_url' }
    }
  }
  // 2-4. repo_hint matched against role / alias / url_tail in that
  //      fidelity order. Lowercase comparison; role is operator-authored
  //      and most authoritative, alias is operator-curated, url_tail is
  //      derived from the URL.
  if (hint.repo_hint) {
    const lower = hint.repo_hint.toLowerCase()
    const role = r.role?.trim().toLowerCase() ?? ''
    if (role && role === lower) {
      return { score: SIGNAL_WEIGHT.role, signal: 'role' }
    }
    if (r.aliases.some((a) => a.toLowerCase() === lower)) {
      return { score: SIGNAL_WEIGHT.alias, signal: 'alias' }
    }
    const tail = urlTail(r.remote_url).toLowerCase()
    if (tail.length > 0 && tail === lower) {
      return { score: SIGNAL_WEIGHT.url_tail, signal: 'url_tail' }
    }
  }
  // 5. local_folder — weakest, only used when other signals missed.
  //    Match against role / alias / url_tail since the operator may
  //    have set any of them to match the workspace folder name.
  if (hint.local_folder) {
    const lower = hint.local_folder.toLowerCase()
    const role = r.role?.trim().toLowerCase() ?? ''
    if (role && role === lower) {
      return { score: SIGNAL_WEIGHT.local_folder, signal: 'local_folder' }
    }
    if (r.aliases.some((a) => a.toLowerCase() === lower)) {
      return { score: SIGNAL_WEIGHT.local_folder, signal: 'local_folder' }
    }
    const tail = urlTail(r.remote_url).toLowerCase()
    if (tail.length > 0 && tail === lower) {
      return { score: SIGNAL_WEIGHT.local_folder, signal: 'local_folder' }
    }
  }
  return { score: 0, signal: null }
}

/**
 * Build a `suggested_replies` list for a clarification. Each candidate
 * gets one reply whose `args_patch.repo_hint` is the repo's label —
 * cheap, deterministic, and the most readable form for a picker UI.
 * Operators with operator-curated aliases get those listed too, capped
 * to keep the payload bounded.
 */
function buildSuggestedReplies(
  candidates: readonly AttachedRepo[],
): SuggestedReply[] {
  const out: SuggestedReply[] = []
  for (const r of candidates) {
    out.push({
      label: r.label,
      args_patch: { repo_hint: r.label },
    })
  }
  return out
}

// ─── Public entry ────────────────────────────────────────────────────────

export function resolveRepoFromHint(input: ResolveInput): RepoResolveResult {
  const { repos, hint: rawHint, allowAll = false, fallback = null } = input

  if (repos.length === 0) {
    return {
      ok: false,
      code: 'no_repos',
      message: 'this agent has no repos attached',
      candidates: [],
    }
  }

  const hint = normalizeHint(rawHint)
  const hasAnySignal =
    hint.repo_hint !== null ||
    hint.remote_url !== null ||
    hint.local_folder !== null

  // No signal at all + IDE pre-resolved a repo → use it. The LLM
  // chose not to override; honor the IDE's structured choice. (If the
  // LLM DID supply a hint, fall through to normal resolution so it
  // can pivot to another repo for cross-repo follow-ups.)
  if (!hasAnySignal && fallback && repos.some((r) => r.repo_id === fallback.repo.repo_id)) {
    return {
      ok: true,
      repo: fallback.repo,
      matched_signal: fallback.matched_signal,
      score_table: [],
    }
  }

  // `__all__` sentinel — passed via repo_hint when the IDE explicitly
  // wants fan-out. Single-repo wrappers reject it; we still return a
  // structured clarification rather than a bare error so the IDE can
  // re-prompt with a specific repo from the suggested_replies.
  if (hint.repo_hint === ALL_SENTINEL) {
    if (allowAll) return { ok: 'all', repos }
    return {
      ok: 'clarify',
      kind: 'single_repo_required',
      candidates: repos,
      allow_all_repos: false,
      message: `this wrapper requires a single repo; ${ALL_SENTINEL} is not accepted`,
      suggested_replies: buildSuggestedReplies(repos),
    }
  }

  // No signals at all — let single-repo agents through unambiguously,
  // fan out for multi-repo when allowed, otherwise ask for clarification.
  if (!hasAnySignal) {
    if (repos.length === 1) {
      return {
        ok: true,
        repo: repos[0]!,
        matched_signal: 'fallback_single_repo',
        score_table: [],
      }
    }
    if (allowAll) return { ok: 'all', repos }
    return {
      ok: 'clarify',
      kind: 'repo_or_all',
      candidates: repos,
      allow_all_repos: false,
      message: `agent has ${repos.length} repos attached; pass repo_hint or remote_url`,
      suggested_replies: buildSuggestedReplies(repos),
    }
  }

  // Score every candidate. Top score wins; ties (within epsilon) surface
  // as a clarification with the tied repos as suggested replies.
  const scored = repos.map((r) => ({
    repo: r,
    ...scoreCandidate(r, hint),
  }))
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const scoreTable: ScoreEntry[] = sorted
    .filter((s) => s.score > 0)
    .map((s) => ({
      repo_id: s.repo.repo_id,
      label: s.repo.label,
      score: s.score,
      matched_signal: s.signal,
    }))

  const top = sorted[0]!
  const runnerUp = sorted[1]
  // `SCORE_MARGIN` is the minimum gap between top and runner-up to
  // call the top a clear winner. Any closer and we surface a
  // clarification instead of guessing.
  const SCORE_MARGIN = 0.05

  if (top.score > 0) {
    const runnerUpScore = runnerUp?.score ?? 0
    const isClear = runnerUpScore === 0 || top.score - runnerUpScore > SCORE_MARGIN
    if (isClear) {
      return {
        ok: true,
        repo: top.repo,
        matched_signal: top.signal!,
        score_table: scoreTable,
      }
    }
    // Top and runner-up are close. Group every candidate within the
    // margin and surface them all to the IDE as a clarification.
    const tied = sorted
      .filter((s) => s.score > 0 && top.score - s.score <= SCORE_MARGIN)
      .map((s) => s.repo)
    return {
      ok: 'clarify',
      kind: 'repo_or_all',
      candidates: tied,
      allow_all_repos: allowAll,
      message: `hint matched ${tied.length} repos with comparable confidence`,
      suggested_replies: buildSuggestedReplies(tied),
    }
  }

  // Zero matches.
  //   - Single repo attached → fall back to it (the LLM typo'd or
  //     hallucinated; the only repo is the obvious intent).
  //   - Multi-repo + clarification supported → ask which one.
  //   - Otherwise → hard not_found, surfacing the candidate list as a
  //     last-resort recovery hint for the LLM.
  if (repos.length === 1) {
    return {
      ok: true,
      repo: repos[0]!,
      matched_signal: 'fallback_single_repo',
      score_table: [],
    }
  }
  const hintLabel =
    hint.repo_hint ?? hint.remote_url ?? hint.local_folder ?? '(empty)'
  return {
    ok: 'clarify',
    kind: 'repo_or_all',
    candidates: repos,
    allow_all_repos: allowAll,
    message: `no attached repo matched "${hintLabel}"`,
    suggested_replies: buildSuggestedReplies(repos),
  }
}
