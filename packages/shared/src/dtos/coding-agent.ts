/**
 * Coding-agent toolkit DTOs. See `docs/ARCHITECTURE.md` §10.
 *
 * The toolkit is a set of MCP tools `apps/mcp-bridge` exposes to IDE
 * coding agents (Cursor / Claude Code / …). This file owns the wire
 * shapes the bridge produces and consumes:
 *
 *   - the multi-signal `hint` object every tool accepts (`repo_hint`
 *     + `remote_url` + `local_folder` + `branch`);
 *   - the resolver's discriminated-union result type. `ResolvedSingle`
 *     vs `ResolvedAll` vs `NeedsClarification` vs `RepoResolverError`;
 *   - the success / error envelopes the IDE sees on `tools/call`.
 *
 * Per-tool input / output answer shapes intentionally land in P3/P4 of
 * the rollout. they only matter once the handlers exist. For now the
 * `answer` field on `codingAgentSuccessSchema` is left as
 * `z.unknown()` so the resolver layer in P1 can be wired without
 * blocking on six per-tool schemas.
 */

import { z } from 'zod'

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Canonical list of tool names the bridge exposes for the coding-agent
 * toolkit. Keep this in sync with the bridge-tool-defs registry
 * (P3). `apps/mcp-bridge/src/index.ts` reads this as the source of
 * truth for what counts as a "coding-agent" tool when filtering runs
 * in the UI (`runs.bridge_tool_name IN (...)`).
 */
export const CODING_AGENT_TOOL_NAMES = [
  'plan_feature',
  'plan_bugfix',
  'ask_general',
  'investigate_codebase',
  'assess_impact',
  'list_repos',
] as const

export type CodingAgentToolName = (typeof CODING_AGENT_TOOL_NAMES)[number]

/**
 * Tools that semantically operate on a single repo. The resolver
 * rejects `repo_hint: '__all__'` for these and returns
 * `needs_clarification` with `kind: 'single_repo_required'`. Mirrors
 * §7.3 step 7 in the planning doc.
 */
export const SINGLE_REPO_ONLY_TOOLS: readonly CodingAgentToolName[] = [
  'plan_feature',
  'plan_bugfix',
] as const

/**
 * Slim, browser-safe metadata for each virtual coding-agent tool.
 * Frontend imports this directly to render the "Coding-agent toolkit"
 * card without a network round-trip; the runtime defs in
 * `@agent-bridge/agents/coding-agent/bridge-tool-defs.ts` extend this
 * shape with the prompt template used by the bridge handler.
 *
 * Drift between this metadata and the runtime defs is caught by
 * `bridge-tool-defs.ts`'s module-init guard (cross-checks names
 * against `CODING_AGENT_TOOL_NAMES`); keep this list in sync by
 * editing both when adding / renaming a tool.
 */
export interface CodingAgentToolMetadata {
  readonly name: CodingAgentToolName
  /** One-line summary the IDE picker reads. */
  readonly summary: string
  /** Two- or three-sentence description for the operator-facing card. */
  readonly description: string
  /** Whether the tool accepts `repo_hint: '__all__'`. */
  readonly allowAllRepos: boolean
  /** True for `list_repos`. bridge handles it without a model call. */
  readonly synchronous: boolean
}

export const CODING_AGENT_TOOL_METADATA: ReadonlyArray<CodingAgentToolMetadata> =
  Object.freeze([
    {
      name: 'plan_feature',
      summary: 'Plan a feature in one repo with cross-repo touch points.',
      description:
        'Given a feature description and a target repo, returns affected files, reusable hooks/components/utilities, cross-repo touch points, naming patterns, and risks. Operates on one repo at a time.',
      allowAllRepos: false,
      synchronous: false,
    },
    {
      name: 'plan_bugfix',
      summary: 'Diagnose a bug and propose a fix in one repo.',
      description:
        'Given an error / stack trace / repro steps, returns suspect call sites with line numbers, recent related changes, and risks. Pairs well with the IDE’s "share file context" feature.',
      allowAllRepos: false,
      synchronous: false,
    },
    {
      name: 'ask_general',
      summary: 'Free-form Q&A grounded in the multi-repo context.',
      description:
        'Markdown answer with cited file paths. Pass a specific `repo_hint` to scope the answer, or `repo_hint: "__all__"` to ask across every attached repo.',
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'investigate_codebase',
      summary: 'Trace a code path from an anchor toward a goal.',
      description:
        'Pass a starting `path` or `symbol` and a goal. the agent returns an ordered trace of hops across repos, optionally with a Mermaid graph for ≥3-hop traces.',
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'assess_impact',
      summary: 'Cross-repo blast radius of a proposed change.',
      description:
        'Pass the files / symbols / package you intend to rename, remove, modify, or add. the agent returns every direct and transitive consumer across attached repos.',
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'list_repos',
      summary: 'List the repos attached to this agent.',
      description:
        'Cheap, deterministic, no LLM call. The IDE coding agent should call this once at session start to populate `repo_hint` autocomplete.',
      allowAllRepos: false,
      synchronous: true,
    },
  ])

/**
 * Reserved `repo_hint` value meaning "the question is general across
 * every attached repo". The resolver short-circuits on this; tools
 * in `SINGLE_REPO_ONLY_TOOLS` reject it.
 */
export const ALL_REPOS_SENTINEL = '__all__'

/**
 * Resolver error / clarification codes. Distinct from the HTTP-edge
 * `errorCodes` in `common.ts`. those are validation/auth-shaped
 * (`validation_failed`, `not_found`, …) and live on the API layer.
 * These describe domain-level outcomes the IDE coding agent needs to
 * distinguish to decide how to recover (re-prompt the user, ask for
 * indexing to finish, fall back to `__all__`, …).
 */
export const codingAgentErrorCodes = [
  'no_repos_attached',
  'repo_not_found',
  'repo_ambiguous',
  'repo_not_ready',
  'needs_clarification',
  'missing_input',
  'internal',
] as const

export type CodingAgentErrorCode = (typeof codingAgentErrorCodes)[number]

/**
 * Confidence the resolver / LLM attaches to its answer. `low` should
 * always co-occur with at least one entry in `uncertainty_notes`.
 */
export const codingAgentConfidenceLevels = ['high', 'medium', 'low'] as const
export type CodingAgentConfidence =
  (typeof codingAgentConfidenceLevels)[number]

/**
 * Which signal in the hint object was the deciding factor for the
 * matched candidate. Surfaced in the `coding-agent.repo.resolved`
 * audit event (P6) so operators can debug bad matches at a glance.
 */
export const matchedSignals = [
  'remote_url',
  'role',
  'alias',
  'local_folder',
  'url_tail',
] as const
export type MatchedSignal = (typeof matchedSignals)[number]

// ─── Hint object ─────────────────────────────────────────────────────────

/**
 * What the IDE coding agent passes to identify a target repo. All
 * fields are optional. the resolver accepts whatever the IDE could
 * glean locally and returns `needs_clarification` when the agent has
 * multiple repos and no signal was provided.
 *
 * Field names use snake_case on the wire (matching the JSON-Schema
 * input shape we ship in `bridge_tools.input_schema`). The resolver's
 * internal `Hint` type renames to camelCase via `transform`.
 */
export const codingAgentHintSchema = z
  .object({
    repo_hint: z.string().trim().min(1).max(200).optional(),
    remote_url: z.string().trim().min(1).max(500).optional(),
    local_folder: z.string().trim().min(1).max(200).optional(),
    branch: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

export type CodingAgentHint = z.infer<typeof codingAgentHintSchema>

// ─── Attached-repo loader output ─────────────────────────────────────────

/**
 * Single source of truth for "what repos does this agent see?". Both
 * `list_repos` and the resolver consume this exact shape from
 * `loadAttachedRepos` (in `@agent-bridge/agents`). Fields are flat -
 * the resolver doesn't need the full `agent_repos` join.
 *
 * `aliases` is populated from `agent_repos.aliases` once that column
 * lands (P5). Until then the loader returns `[]`. Resolver scoring
 * is robust to empty alias arrays.
 */
export const attachedRepoSchema = z.object({
  repo_id: z.uuid(),
  remote_url: z.string(),
  branch: z.string(),
  /** `agent_repos.role` if set, otherwise the URL tail. Already non-null. */
  label: z.string(),
  /** `agent_repos.role` raw. null when operator left it blank. */
  role: z.string().nullable(),
  /** `agent_repos.description`. operator-authored "what this repo gives the agent". */
  description: z.string().nullable(),
  /** Operator-curated fuzzy-match handles. P1 ships this as []; P5 fills it in. */
  aliases: z.array(z.string()),
  /** Mirrors `repos.status`. The resolver only returns `ready` repos as resolved. */
  status: z.string(),
})

export type AttachedRepo = z.infer<typeof attachedRepoSchema>

// ─── Resolver result types ───────────────────────────────────────────────

/**
 * Per-candidate score row attached to the resolved or error result so
 * the audit event has a debuggable trace of how the decision was made.
 * Sorted desc by score; top entry is what the resolver picked (or
 * would have picked if not gated by margin / threshold).
 */
export const repoMatchScoreSchema = z.object({
  repo_id: z.uuid(),
  label: z.string(),
  score: z.number().min(0).max(2),
  matched_signal: z.enum(matchedSignals),
})

export type RepoMatchScore = z.infer<typeof repoMatchScoreSchema>

export const resolvedSingleRepoSchema = z.object({
  scope: z.literal('single'),
  repo: attachedRepoSchema,
  confidence: z.enum(codingAgentConfidenceLevels),
  matched_signal: z.enum(matchedSignals),
  /**
   * Top-N score table for audit. Always populated when the resolver
   * had to score (i.e. the input had at least one hint signal).
   * Empty when the resolver short-circuited (single-repo agent, no hint).
   */
  score_table: z.array(repoMatchScoreSchema),
  /**
   * Soft warnings the resolver wants the LLM to consider. e.g. "you
   * matched X with score 0.62 but Y at 0.55 was close". Empty in the
   * `high`-confidence path.
   */
  warnings: z.array(z.string()),
})

export type ResolvedSingleRepo = z.infer<typeof resolvedSingleRepoSchema>

export const resolvedAllReposSchema = z.object({
  scope: z.literal('all'),
  repos: z.array(attachedRepoSchema),
})

export type ResolvedAllRepos = z.infer<typeof resolvedAllReposSchema>

/**
 * Returned to the IDE when the resolver wants a question, not an
 * error. Two kinds today:
 *   - `repo_or_all`: the agent has multiple repos and no hint was
 *     given. The IDE asks the human or auto-selects `__all__`.
 *   - `single_repo_required`: the IDE passed `__all__` to a tool that
 *     only operates on a single repo (e.g. `plan_feature`).
 *
 * Always carries the full candidate list and pre-baked
 * `suggested_replies` so the IDE can render a one-click picker.
 */
export const clarificationKinds = [
  'repo_or_all',
  'single_repo_required',
] as const
export type ClarificationKind = (typeof clarificationKinds)[number]

export const suggestedReplySchema = z.object({
  label: z.string(),
  args_patch: codingAgentHintSchema,
})

export type SuggestedReply = z.infer<typeof suggestedReplySchema>

export const needsClarificationSchema = z.object({
  scope: z.literal('clarification'),
  kind: z.enum(clarificationKinds),
  candidates: z.array(attachedRepoSchema),
  allow_all_repos: z.boolean(),
  message: z.string(),
  suggested_replies: z.array(suggestedReplySchema),
})

export type NeedsClarification = z.infer<typeof needsClarificationSchema>

/**
 * Hard error from the resolver. Distinct from `NeedsClarification` -
 * an error means the call cannot proceed even with operator
 * intervention (or, in `repo_not_ready`, can only proceed after
 * the indexing job finishes).
 */
export const repoResolverErrorSchema = z.object({
  scope: z.literal('error'),
  code: z.enum([
    'no_repos_attached',
    'repo_not_found',
    'repo_ambiguous',
    'repo_not_ready',
  ]),
  message: z.string(),
  /** Top-N candidates with scores; empty for `no_repos_attached`. */
  candidates: z.array(repoMatchScoreSchema),
  /** Set when `code === 'repo_not_ready'`. */
  status: z.string().optional(),
})

export type RepoResolverError = z.infer<typeof repoResolverErrorSchema>

/**
 * Discriminated union over `scope` so callers can `switch` on it
 * without unwrapping nested ok/err shells. The bridge handler
 * `executeCodingAgentTool` (P4) does this switch and converts each
 * branch into the wire envelope.
 */
export const repoResolutionSchema = z.discriminatedUnion('scope', [
  resolvedSingleRepoSchema,
  resolvedAllReposSchema,
  needsClarificationSchema,
  repoResolverErrorSchema,
])

export type RepoResolution = z.infer<typeof repoResolutionSchema>

// ─── Wire envelope ───────────────────────────────────────────────────────

/**
 * Structured groundedness counter the LLM is required to emit. Used
 * by the system skill (rule 6) to gate `confidence`. Schema enforces
 * non-negative integers. anything else is an LLM mistake worth
 * surfacing as a parse error.
 */
export const groundednessSchema = z.object({
  claims: z.number().int().min(0),
  grounded: z.number().int().min(0),
  ungrounded: z.number().int().min(0),
})

export type Groundedness = z.infer<typeof groundednessSchema>

/**
 * Identifying slice of the resolved repo for inclusion in the wire
 * envelope. Strips `aliases` + `description` to keep responses
 * compact; the IDE agent already has those from `list_repos`.
 */
export const resolvedRepoWireSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  remote_url: z.string(),
  branch: z.string(),
})

export type ResolvedRepoWire = z.infer<typeof resolvedRepoWireSchema>

/**
 * Lightweight repo descriptor for the `related_repos` array on the
 * envelope. just enough for the IDE to render labels and route
 * follow-up calls.
 */
export const relatedRepoWireSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  /** Free-form: typically the `repo_edges` connector + description. */
  via: z.string().optional(),
})

export type RelatedRepoWire = z.infer<typeof relatedRepoWireSchema>

/**
 * Successful tool response. `answer` is intentionally `unknown` at
 * P1. per-tool answer shapes ship in P4 alongside the handlers.
 * Once those exist, change this to a discriminated union keyed off
 * `tool` so the frontend can narrow.
 */
export const codingAgentSuccessSchema = z.object({
  ok: z.literal(true),
  tool: z.enum(CODING_AGENT_TOOL_NAMES),
  agent: z.object({
    id: z.uuid(),
    slug: z.string(),
  }),
  /**
   * The repo the resolver picked. `null` when scope was `all`
   * (`__all__` sentinel). the `related_repos` array carries the
   * fan-out set in that case.
   */
  resolved_repo: resolvedRepoWireSchema.nullable(),
  related_repos: z.array(relatedRepoWireSchema),
  scope: z.enum(['single', 'all']),
  confidence: z.enum(codingAgentConfidenceLevels),
  groundedness: groundednessSchema.optional(),
  answer: z.unknown(),
  uncertainty_notes: z.array(z.string()),
  warnings: z.array(z.string()),
  /** True when the LLM emitted text that didn't parse to the tool's documented schema. */
  schema_unmatched: z.boolean().optional(),
})

export type CodingAgentSuccess = z.infer<typeof codingAgentSuccessSchema>

/**
 * Error / clarification envelope returned from a tool call. Mirrors
 * §6 of the planning doc: a `needs_clarification` is delivered as
 * `{ ok: false, code: 'needs_clarification', clarification: {...} }`,
 * NOT as a thrown exception, so the IDE can render a picker.
 */
export const codingAgentErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.enum(codingAgentErrorCodes),
  message: z.string(),
  /** Populated for `repo_not_found` / `repo_ambiguous`. */
  candidates: z.array(repoMatchScoreSchema).optional(),
  /** Populated for `needs_clarification`. */
  clarification: z
    .object({
      kind: z.enum(clarificationKinds),
      candidates: z.array(attachedRepoSchema),
      allow_all_repos: z.boolean(),
      suggested_replies: z.array(suggestedReplySchema),
    })
    .optional(),
})

export type CodingAgentErrorEnvelope = z.infer<
  typeof codingAgentErrorEnvelopeSchema
>

export const codingAgentEnvelopeSchema = z.union([
  codingAgentSuccessSchema,
  codingAgentErrorEnvelopeSchema,
])

export type CodingAgentEnvelope = z.infer<typeof codingAgentEnvelopeSchema>

/**
 * Tiny narrowing helper so handlers can branch without re-checking the
 * `ok` literal twice.
 */
export function isCodingAgentError(
  v: CodingAgentEnvelope,
): v is CodingAgentErrorEnvelope {
  return v.ok === false
}
