/**
 * Inspector toolkit DTOs. See `docs/ARCHITECTURE.md` §10.
 *
 * Exports:
 *   - `attachedRepoSchema` / `AttachedRepo` — wire shape for "what repos
 *     does this inspector agent see?", produced by `loadAttachedRepos`
 *     and consumed by every inspector wrapper.
 *   - `INSPECTOR_TOOL_DEFINITIONS` + helpers — six-wrapper catalog the
 *     agent runtime + frontend both render from.
 *   - `INSPECT_CODEBASE_METADATA` — the single MCP tool the bridge
 *     advertises per inspector agent (`<slug>__inspect_codebase`).
 *   - `ASK_AGENT_DEFAULTS` — defaults for the auto-created
 *     `<slug>__ask_agent` bridge_tool row that blank agents get on
 *     insert.
 */

import { z } from 'zod'

// ─── Attached repos ─────────────────────────────────────────────────────

/**
 * Single source of truth for "what repos does this agent see?". Both
 * `list_repos` and the resolver consume this exact shape from
 * `loadAttachedRepos` (in `@agent-bridge/agents`). Fields are flat;
 * the resolver doesn't need the full `agent_repos` join.
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
  /** Operator-curated fuzzy-match handles. */
  aliases: z.array(z.string()),
  /** Mirrors `repos.status`. The resolver only returns `ready` repos as resolved. */
  status: z.string(),
})

export type AttachedRepo = z.infer<typeof attachedRepoSchema>

// ─── Inspector wrapper catalog ──────────────────────────────────────────

/**
 * Single source of truth for the inspector wrappers' names + descriptions.
 *
 * Consumed in two places:
 *   - The agent runtime (`packages/agents/src/inspector/index.ts`) reads
 *     each `description` to populate the Mastra `createTool({...})` calls.
 *     These are the strings the LLM actually sees in its tool dict at
 *     run time.
 *   - The frontend Resources tab + Bridge dashboard render the same
 *     catalog read-only so operators see what their agent is auto-
 *     attached to.
 *
 * Edit descriptions HERE; both consumers pick up the change. Adding /
 * removing wrappers is still a two-place change (this file + the
 * matching `buildXxxTool` factory in `inspector/index.ts`) because the
 * wrappers each have their own input schema + execute body.
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

export type InspectorToolName = InspectorToolDefinition['name']

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
        'Find code in the attached repos using hybrid keyword + semantic search. Returns a mini-repo: a list of matched files with snippets, language tags, and the reason each was matched. Pass a free-form `query` (user-language is fine) and optionally a `repo_hint` to scope to one repo. Read-only. Never edits or proposes file changes.',
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

/**
 * Lookup helper for `INSPECTOR_TOOL_DEFINITIONS`. Throws on miss so the
 * agent runtime fails loudly at boot if a wrapper name drifts away
 * from the catalog. Better than silently shipping a tool with an
 * empty description to the LLM.
 */
export function inspectorToolDescription(name: InspectorToolName): string {
  const found = INSPECTOR_TOOL_DEFINITIONS.find((t) => t.name === name)
  if (!found) {
    throw new Error(
      `[inspectorToolDescription] no entry for "${name}" in INSPECTOR_TOOL_DEFINITIONS. ` +
        `update the catalog in @agent-bridge/shared/dtos/inspector.ts.`,
    )
  }
  return found.description
}

// ─── inspect_codebase MCP tool ──────────────────────────────────────────

/**
 * Slim, browser-safe metadata for the single MCP tool the bridge ships
 * per inspector agent (`docs/ARCHITECTURE.md` §10).
 *
 * Mirrors what `apps/mcp-bridge/src/index.ts:INSPECT_CODEBASE_INPUT_SCHEMA`
 * advertises on `tools/list`. Exposed here so the frontend can render
 * the bridge dashboard without a network round-trip; the IDE is what
 * actually receives this from the live `tools/list`.
 */
export interface InspectCodebaseMetadata {
  /** Suffix appended to `<agent.slug>__` in the live tool name. */
  readonly nameSuffix: 'inspect_codebase'
  readonly summary: string
  readonly description: string
  /** Argument keys the IDE LLM is expected to pass. */
  readonly inputKeys: ReadonlyArray<{
    readonly name:
      | 'query'
      | 'repo_hint'
      | 'remote_url'
      | 'local_folder'
      | 'branch'
      | 'with_topology'
    readonly required: boolean
    readonly description: string
  }>
}

export const INSPECT_CODEBASE_METADATA: InspectCodebaseMetadata = Object.freeze({
  nameSuffix: 'inspect_codebase',
  summary:
    'Ask any question about the agent’s attached codebases. The agent picks the right wrapper internally.',
  description:
    'One MCP tool per agent. The IDE LLM passes a free-form `query` plus optional repo hints; the agent runs its inspector wrappers (find / trace / impact / debug / understand / list) and returns one of two response shapes:\n\n' +
    '  • Code question (the agent called at least one wrapper) → ' +
    '`{ ok, mini_repos: [...], warnings }`. Structured evidence: ' +
    'file paths, code chunks, graph slices, cross-repo edges. ' +
    'No `prose_summary` field. The IDE LLM is the synthesizer here. ' +
    'Read the mini-repos, write the answer.\n' +
    '  • Chit-chat / clarification (no wrapper ran) → ' +
    '`{ ok, prose_summary: "≤ 1 KB", warnings }`. The agent\'s ' +
    'free-form reply. No `mini_repos` field.\n\n' +
    '`ok` is always `true` (chit-chat is a valid response). ' +
    'Read-only. Never edits files.',
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
      description: 'Current branch. Used as a tiebreaker only.',
    },
    {
      name: 'with_topology' as const,
      required: false,
      description:
        'When true, the response carries the full repo topology (`agent_repos`, `repo_edges`). Default false: the response is scoped to the resolved repo and exposes `next_actions` instead. Set true when you need the broad view in one shot.',
    },
  ]),
})

// ─── ask_agent auto-created bridge_tool defaults ────────────────────────

/**
 * Defaults the backend uses when auto-creating the `<slug>__ask_agent`
 * `bridge_tools` row for a Build-your-own-agent at insert time. After
 * creation the row is fully operator-controlled (rename, edit
 * description, change input schema, change prompt template, delete).
 * These constants only seed the initial values.
 *
 * Kept as a single source of truth so the auto-create path AND any
 * UI-side preview/copy stay in lockstep.
 */
export interface AskAgentDefaults {
  /** Suffix appended to `<safeSlug>__` in the auto-created bridge_tools.name. */
  readonly nameSuffix: 'ask_agent'
  /** Default `bridge_tools.description` shown to the IDE LLM. */
  readonly description: string
  /** Default `bridge_tools.input_schema`. */
  readonly inputSchema: Record<string, unknown>
  /** Default `bridge_tools.prompt_template`. Pure pass-through. */
  readonly promptTemplate: string
}

export const ASK_AGENT_DEFAULTS: AskAgentDefaults = Object.freeze({
  nameSuffix: 'ask_agent',
  description:
    'Free-form Q&A with this agent. Replies in plain text. ' +
    'IMPORTANT: this agent has NO codebase access, file-system access, or external retrieval beyond what the operator wired in. It can only reason about: (a) its system prompt + authored skills, (b) anything you literally include in `query`, and (c) operator-attached external MCPs (if any). ' +
    'DO NOT paste file contents into `query` expecting the agent to retrieve more from disk. Include any context verbatim. ' +
    'For codebase Q&A (file paths, code search, call-graph, change impact), route to a Repo-inspector agent\'s `inspect_codebase` tool instead.',
  inputSchema: Object.freeze({
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description:
          'Free-form question or instruction. Include any context verbatim. The agent will not fetch anything else.',
      },
    },
  }),
  promptTemplate: '{{ query }}',
})
