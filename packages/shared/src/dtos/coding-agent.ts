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

/**
 * @deprecated The V1 six-virtual model (plan_feature, plan_bugfix, …) was
 * replaced by the wrapper-tool architecture. The bridge now exposes ONE
 * MCP tool per agent (`<slug>__inspect_codebase`) plus operator-authored
 * `bridge_tools` rows. New code should consume {@link INSPECT_CODEBASE_METADATA}.
 *
 * Left in place because event types in `events.ts` still reference the
 * underlying name union; ripping them out is a separate cleanup.
 */
export const CODING_AGENT_TOOL_METADATA: ReadonlyArray<CodingAgentToolMetadata> =
  Object.freeze([])

/**
 * Slim, browser-safe metadata for the single MCP tool the bridge ships
 * per agent under the wrapper-tool architecture
 * (`docs/ARCHITECTURE.md` §10).
 *
 * Mirrors what `apps/mcp-bridge/src/index.ts:INSPECT_CODEBASE_INPUT_SCHEMA`
 * advertises on `tools/list`. Exposed here so the frontend can render
 * the bridge dashboard without a network round-trip — the IDE is what
 * actually receives this from the live `tools/list`.
 */
export interface InspectCodebaseMetadata {
  /** Suffix appended to `<agent.slug>__` in the live tool name. */
  readonly nameSuffix: 'inspect_codebase'
  readonly summary: string
  readonly description: string
  /** Argument keys the IDE LLM is expected to pass. */
  readonly inputKeys: ReadonlyArray<{
    readonly name: 'query' | 'repo_hint' | 'remote_url' | 'local_folder' | 'branch'
    readonly required: boolean
    readonly description: string
  }>
}

/**
 * Static catalog of the six inspector wrappers the agent's LLM
 * actually sees as tools. The Resources tab's "Built-in" section reads
 * this to render what's auto-attached without spawning a subprocess.
 *
 * Descriptions are mirrored verbatim from
 * `packages/agents/src/inspector/index.ts`'s `createTool({ description })`
 * calls. Keep these in sync when editing one or the other — drift is
 * a documentation bug, not a runtime bug, but the operator-facing
 * description should match what the LLM is shown.
 */
export interface InspectorToolDefinition {
  readonly name:
    | 'find_in_codebase'
    | 'list_repos'
    | 'trace_flow'
    | 'assess_change_impact'
    | 'debug_help'
    | 'understand_module'
  readonly description: string
}

export const INSPECTOR_TOOL_DEFINITIONS: ReadonlyArray<InspectorToolDefinition> =
  Object.freeze([
    {
      name: 'list_repos',
      description:
        'List the repositories attached to this agent. Use this once at the start of a conversation when you do not know which repos you have. Returns a mini-repo whose `summary` carries the inventory inline (label, role, status, aliases, description). Cheap, deterministic, no gitnexus calls.',
    },
    {
      name: 'find_in_codebase',
      description:
        'Find code in the attached repos using hybrid keyword + semantic search. Returns a mini-repo: a list of matched files with snippets, language tags, and the reason each was matched. Pass a free-form `query` (user-language is fine) and optionally a `repo_hint` to scope to one repo. Read-only — never edits or proposes file changes.',
    },
    {
      name: 'trace_flow',
      description:
        'Walk the call/import graph from a starting file or symbol toward a goal. Returns a mini-repo with `graph_subset` (nodes + edges) and `files` chunks for the closest hops. Single-repo only. Pass `repo_hint` when the agent has more than one repo. Read-only.',
    },
    {
      name: 'assess_change_impact',
      description:
        'Compute blast radius for a proposed change (rename / remove / modify / add). Returns a mini-repo where each `files` row classifies a path as `direct` or `transitive` at depth N, plus operator-curated cross-repo edges in `cross_repo_edges`. Single primary repo. Read-only.',
    },
    {
      name: 'debug_help',
      description:
        'Diagnose a bug from raw error text. Extracts file paths + symbol names via language-agnostic regex, runs the codebase search for each, fetches surrounding context for the top suspect call sites. Returns a mini-repo with file chunks and the matched candidate per row. Read-only.',
    },
    {
      name: 'understand_module',
      description:
        'Explain what a file or symbol does. Returns a mini-repo with the anchor file body + its outgoing dependencies (depth ≤ 2). Use when the developer asks "what does X do?" or "how does X work?". Read-only.',
    },
  ])

export const INSPECT_CODEBASE_METADATA: InspectCodebaseMetadata = Object.freeze({
  nameSuffix: 'inspect_codebase',
  summary:
    'Ask any question about the agent’s attached codebases. The agent picks the right wrapper internally.',
  description:
    'One MCP tool per agent. The IDE LLM passes a free-form `query` plus optional repo hints; the agent runs its inspector wrappers (find / trace / impact / debug / understand / list) and returns a bounded `mini_repos[]` envelope: file paths + chunks + graph slices + cross-repo edges. Read-only — never edits files.',
  inputKeys: Object.freeze([
    {
      name: 'query' as const,
      required: true,
      description:
        'Free-form question or instruction. The agent picks find / trace / impact / debug / understand / list internally.',
    },
    {
      name: 'repo_hint' as const,
      required: false,
      description:
        'Friendly label of an attached repo (role, alias, URL tail). Omit when the agent has only one repo or you want all repos searched.',
    },
    {
      name: 'remote_url' as const,
      required: false,
      description:
        'Highest-signal repo identifier; pass it when readable from the IDE (`git remote get-url origin`).',
    },
    {
      name: 'local_folder' as const,
      required: false,
      description: 'IDE workspace folder name as a fallback signal.',
    },
    {
      name: 'branch' as const,
      required: false,
      description: 'Current branch — used as a tiebreaker only.',
    },
  ]),
})

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
