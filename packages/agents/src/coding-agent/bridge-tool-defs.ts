/**
 * Virtual bridge-tool definitions. the six MCP tools the coding-agent
 * toolkit ships by default for every Agent Bridge agent.
 *
 * "Virtual" because they are NOT rows in the `bridge_tools` table -
 * they are code, defined here, registered at `apps/mcp-bridge` boot
 * time alongside any operator-authored explicit rows. Operators can
 * shadow a virtual tool by inserting a `bridge_tools` row with the
 * same name (precedence: explicit > virtual).
 *
 * Each definition carries:
 *   - `name`: the MCP tool identifier the IDE coding agent calls.
 *     Stable; never `query_*` (reserved for the Phase-5 default).
 *   - `description`: prose the IDE LLM reads when picking which tool
 *     to call. Rich enough that the choice is unambiguous; short
 *     enough that the tool list doesn't bloat. Includes the
 *     "pass `remote_url` whenever you can" nudge so well-behaved
 *     IDE clients send their highest-signal identifier.
 *   - `inputSchema`: JSON Schema draft-07 object. Shipped verbatim
 *     to the IDE on `tools/list`. Includes the multi-signal hint
 *     object (`repo_hint` / `remote_url` / `local_folder` / `branch`)
 *     plus per-tool fields.
 *   - `promptTemplate`: Mustache-ish template with `{{ argName }}`
 *     placeholders. P4's handler will (a) build the resolution
 *     preamble (`<coding_agent_call>...</coding_agent_call>`) from
 *     the resolver's output, (b) render this template against the
 *     IDE-supplied args, (c) concatenate the two as the LLM prompt.
 *   - `allowAllRepos`: per-tool gate for the `__all__` sentinel.
 *     `plan_feature` and `plan_bugfix` operate on a single repo -
 *     `__all__` is rejected with `clarification.kind = 'single_repo_required'`.
 *
 * Edits here ripple through the BuiltAgent cache via
 * `CODING_AGENT_SYSTEM_SKILL_VERSION` (system-skill.ts). bump it
 * when any tool's schema or template changes substantively, so the
 * Mastra agents pick up the new bridge surface on next access.
 */

import {
  ALL_REPOS_SENTINEL,
  CODING_AGENT_TOOL_NAMES,
  type CodingAgentToolName,
} from '@agent-bridge/shared'

// ─── Shared schema fragments ─────────────────────────────────────────────

/**
 * Multi-signal hint object. every tool except `list_repos` accepts
 * this. Lifted into a constant so the four tools that share it stay
 * literally identical (the IDE LLM is more likely to pass consistent
 * fields when the schemas are byte-identical across tools).
 *
 * Note the `description` strings on each field. these are what the
 * IDE LLM reads. The `pass remote_url whenever you can` nudge lives
 * on `remote_url` so it gets surfaced by clients that show field
 * descriptions in their UI.
 */
const HINT_FIELDS: Record<string, unknown> = {
  repo_hint: {
    type: 'string',
    description:
      'Friendly name for the target repo. fuzzy-matched against role / aliases / URL tail. Examples: `frontend`, `traveller-web`, `web-app`. Pass `__all__` to ask across every attached repo (only valid on tools that accept it). Omit to trigger a clarification round-trip when the agent has multiple repos.',
  },
  remote_url: {
    type: 'string',
    description:
      'If you can read it (e.g. `git remote get-url origin`), pass it. **Highest-signal identifier**. wins exact match over fuzzy hints. Always pass this when you know it.',
  },
  local_folder: {
    type: 'string',
    description:
      'The folder name your IDE workspace is open in (e.g. `web-app`). Used as a fallback signal when `repo_hint` and `remote_url` are missing or do not match an attached repo.',
  },
  branch: {
    type: 'string',
    description:
      'Current branch. only used as a tiebreaker when two attached repos share `remote_url` on different branches.',
  },
}

const STRICTNESS_FIELD: Record<string, unknown> = {
  strictness: {
    type: 'string',
    enum: ['strict', 'balanced', 'exploratory'],
    default: 'balanced',
    description:
      'How strict to be about grounding. `strict`: refuse claims you cannot ground. `balanced` (default): one flagged best-guess allowed per answer. `exploratory`: may suggest unverified investigation paths.',
  },
}

const RELATED_REPOS_FIELD: Record<string, unknown> = {
  related_repos: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Optional list of repo hints (same format as `repo_hint`) for repos that may be touched. Each is resolved independently; unresolved ones are reported as warnings rather than failing the call.',
  },
}

// ─── Per-tool input schemas ──────────────────────────────────────────────

const planFeatureInput: Record<string, unknown> = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description:
        'Feature description, user story, or design note describing what the developer wants to build.',
    },
    ...HINT_FIELDS,
    ...RELATED_REPOS_FIELD,
    files_or_symbols: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Anchors the IDE coding agent already knows about (file paths, function names, package names). Helps Agent Bridge focus its grounding.',
    },
    task_type: {
      type: 'string',
      enum: ['new_feature', 'enhancement', 'refactor'],
      default: 'new_feature',
      description: 'Shape of the work. narrows the kind of suggestions returned.',
    },
    ...STRICTNESS_FIELD,
  },
}

const planBugfixInput: Record<string, unknown> = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description:
        'Bug description in the developer\'s words. what is broken, what was expected, anything they have already tried.',
    },
    error_text: {
      type: 'string',
      maxLength: 16000,
      description:
        'Raw error message and/or stack trace. Pass verbatim. substring matches against indexed code drive grounding.',
    },
    repro_steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ordered list of reproduction steps, if known.',
    },
    severity: {
      type: 'string',
      enum: ['p0', 'p1', 'p2', 'p3'],
      default: 'p2',
      description: 'Severity hint. affects how aggressively to surface risks vs. suggestions.',
    },
    ...HINT_FIELDS,
    ...RELATED_REPOS_FIELD,
    files_or_symbols: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files / symbols you already suspect, if any.',
    },
    ...STRICTNESS_FIELD,
  },
}

const askGeneralInput: Record<string, unknown> = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description: 'Free-form question about the codebase.',
    },
    ...HINT_FIELDS,
    ...STRICTNESS_FIELD,
  },
}

const investigateCodebaseInput: Record<string, unknown> = {
  type: 'object',
  required: ['goal'],
  additionalProperties: false,
  properties: {
    goal: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description:
        'What you want to learn. e.g. "trace this API endpoint to the worker that consumes it", "find every caller of useCart".',
    },
    start: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'File path you already know about.' },
        symbol: { type: 'string', description: 'Function / class / variable name.' },
      },
      description:
        'Anchor the trace. Pass at least one of `path` or `symbol`. Omit to start from the resolved repo\'s entry points.',
    },
    ...HINT_FIELDS,
    ...STRICTNESS_FIELD,
  },
}

const assessImpactInput: Record<string, unknown> = {
  type: 'object',
  required: ['change_kind'],
  additionalProperties: false,
  properties: {
    change_kind: {
      type: 'string',
      enum: ['rename', 'remove', 'modify', 'add'],
      description: 'What you intend to do.',
    },
    proposed_change: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        symbols: { type: 'array', items: { type: 'string' } },
        package: { type: 'string', description: 'Package name (when the change is at package level).' },
      },
      description: 'What you are changing. At least one of `files`, `symbols`, or `package` is required.',
    },
    ...HINT_FIELDS,
    ...RELATED_REPOS_FIELD,
    ...STRICTNESS_FIELD,
  },
}

const listReposInput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

// ─── Prompt templates ────────────────────────────────────────────────────

/**
 * Templates are the operator-prompt half of the LLM input. The bridge
 * handler (P4) prepends a `<coding_agent_call>` resolution preamble
 * built from the resolver's output, so templates here focus on the
 * user-supplied content and tool-specific cues. Keep them short -
 * the system skill (`system-skill.md`) already carries the
 * grounding rules and output contract.
 *
 * `{{ name }}` placeholders match `[a-zA-Z_][a-zA-Z0-9_]*` (same
 * identifier rule the Phase-7 renderer enforces in
 * `apps/mcp-bridge/src/index.ts`). Unknown placeholders interpolate
 * as the empty string. the operator can still see the rendered
 * prompt in `runs.input_prompt` and fix the template.
 */
const planFeatureTemplate = [
  'A developer wants to build the following feature.',
  '',
  'Task type: {{task_type}}',
  '',
  'User query:',
  '{{query}}',
  '',
  'Anchors the IDE already knows about: {{files_or_symbols}}',
  '',
  'Return a `plan_feature` answer per the documented output schema:',
  'summary, affected_files, reusable, cross_repo, naming_patterns, risks,',
  'follow_ups, open_questions. Ground every file path / symbol in a',
  'gitnexus_* result on the resolved repo (or one of the related repos).',
].join('\n')

const planBugfixTemplate = [
  'A developer is debugging the following issue.',
  '',
  'Severity: {{severity}}',
  '',
  'User query:',
  '{{query}}',
  '',
  'Error text / stack trace:',
  '{{error_text}}',
  '',
  'Reproduction steps: {{repro_steps}}',
  '',
  'Suspected files / symbols: {{files_or_symbols}}',
  '',
  'Return a `plan_bugfix` answer per the documented output schema:',
  'summary, suspect_call_sites (path + line + reason),',
  'recent_related_changes, risks, follow_ups, open_questions.',
  'Ground every claim in a gitnexus_* result.',
].join('\n')

const askGeneralTemplate = [
  'A developer is asking a general question about the codebase.',
  '',
  'User query:',
  '{{query}}',
  '',
  'Return an `ask_general` answer per the documented output schema:',
  'summary, answer.text (markdown), answer.citations (array of',
  '{ repo, path, line? }), uncertainty_notes, open_questions.',
  'Cite every concrete claim. When the resolution preamble says scope=all,',
  'fan gitnexus_query across every attached repo.',
].join('\n')

const investigateCodebaseTemplate = [
  'The developer wants to investigate the codebase from a starting anchor.',
  '',
  'Goal:',
  '{{goal}}',
  '',
  'Starting anchor: {{start}}',
  '',
  'Return an `investigate_codebase` answer: a `trace` array of hops',
  '({ repo, path, symbol?, why }) walking from the start anchor toward',
  'the goal. Use gitnexus_cypher on the start, then gitnexus_query for',
  'each hop. Include a `mermaid` graph only when the trace is >= 3 hops.',
].join('\n')

const assessImpactTemplate = [
  'The developer is considering a change and wants its blast radius.',
  '',
  'Change kind: {{change_kind}}',
  '',
  'Proposed change: {{proposed_change}}',
  '',
  'Return an `assess_impact` answer: blast_radius array of',
  '{ repo, path, kind: "direct" | "transitive", reason }.',
  'Use gitnexus_impact on each entry of files/symbols/package.',
  'Combine with repo_edges for cross-repo expansion. Stop at depth 2',
  'unless the user asked for more.',
].join('\n')

const listReposTemplate = [
  '(list_repos is handled deterministically by the bridge. this',
  'template should never reach the LLM. If you are seeing this,',
  'something is wrong with the bridge handler.)',
].join('\n')

// ─── Definitions ─────────────────────────────────────────────────────────

export interface VirtualBridgeToolDefinition {
  readonly name: CodingAgentToolName
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly promptTemplate: string
  /**
   * Whether this tool accepts the `__all__` sentinel in `repo_hint`.
   * Mirrors `SINGLE_REPO_ONLY_TOOLS` in `@agent-bridge/shared`. Kept
   * inline here so the bridge's `executeCodingAgentTool` (P4) can
   * pull a single field instead of cross-referencing the constant.
   */
  readonly allowAllRepos: boolean
  /**
   * `true` for tools whose handler is purely deterministic (no LLM
   * call). The bridge short-circuits these in `executeToolCall`,
   * avoiding the dispatcher entirely. Today only `list_repos` is
   * synchronous; any future "metadata" tools would set this.
   */
  readonly synchronous: boolean
}

export const CODING_AGENT_VIRTUAL_BRIDGE_TOOLS: readonly VirtualBridgeToolDefinition[] =
  Object.freeze([
    {
      name: 'plan_feature',
      description:
        'Plan a new feature, enhancement, or refactor in a single attached repo. Returns: affected_files, reusable hooks/components/utils, cross-repo touch points, naming patterns, risks, follow-ups, open questions. Pass `remote_url` if you can. it removes ambiguity. Operates on ONE repo (does not accept `__all__`).',
      inputSchema: planFeatureInput,
      promptTemplate: planFeatureTemplate,
      allowAllRepos: false,
      synchronous: false,
    },
    {
      name: 'plan_bugfix',
      description:
        'Diagnose a bug and propose a fix in a single attached repo. Pass error text / stack trace / repro steps. Returns: suspect_call_sites (path + line + reason), recent_related_changes, risks, follow-ups, open questions. Pass `remote_url` if you can. Operates on ONE repo (does not accept `__all__`).',
      inputSchema: planBugfixInput,
      promptTemplate: planBugfixTemplate,
      allowAllRepos: false,
      synchronous: false,
    },
    {
      name: 'ask_general',
      description:
        'Free-form Q&A grounded in the multi-repo context. Returns markdown prose with cited file paths. Pass `repo_hint: "__all__"` to ask across every attached repo, or a specific hint to scope the answer.',
      inputSchema: askGeneralInput,
      promptTemplate: askGeneralTemplate,
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'investigate_codebase',
      description:
        'Targeted exploration starting from a known file or symbol toward a goal (e.g. "trace this API endpoint to the worker that consumes it"). Returns an ordered `trace` of hops across repos. Accepts `__all__`. investigations may legitimately span every repo.',
      inputSchema: investigateCodebaseInput,
      promptTemplate: investigateCodebaseTemplate,
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'assess_impact',
      description:
        'Cross-repo blast radius of a proposed change (rename / remove / modify / add). Pass the changed files / symbols / package. Returns a list of files in every repo that would be affected, classified as direct or transitive.',
      inputSchema: assessImpactInput,
      promptTemplate: assessImpactTemplate,
      allowAllRepos: true,
      synchronous: false,
    },
    {
      name: 'list_repos',
      description:
        'List the repositories attached to this Agent Bridge agent. id, friendly label, aliases, remote_url, branch, role, description, indexing status. Cheap, deterministic, no LLM call. Call this once at session start to populate `repo_hint` autocomplete.',
      inputSchema: listReposInput,
      promptTemplate: listReposTemplate,
      // Deterministic; the bridge handler answers without invoking
      // the resolver scope concept. The flag is conventionally
      // `false` because the question doesn't apply.
      allowAllRepos: false,
      synchronous: true,
    },
  ])

// ─── Cross-checks ────────────────────────────────────────────────────────

/**
 * Sanity guard: every tool name we ship must be in the canonical list
 * exported from `@agent-bridge/shared`. If the two ever drift the
 * runs-tab filter on `runs.bridge_tool_name` would miss new tools.
 * Throws at module init, NOT at first call. drift is a programming
 * error and we want a loud failure on the first import in dev.
 */
{
  const canonical = new Set<string>(CODING_AGENT_TOOL_NAMES)
  for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
    if (!canonical.has(def.name)) {
      throw new Error(
        `[bridge-tool-defs] virtual tool "${def.name}" is not in CODING_AGENT_TOOL_NAMES. keep them in sync`,
      )
    }
  }
  if (CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length !== CODING_AGENT_TOOL_NAMES.length) {
    throw new Error(
      `[bridge-tool-defs] virtual tool count (${CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length}) does not match CODING_AGENT_TOOL_NAMES (${CODING_AGENT_TOOL_NAMES.length})`,
    )
  }
}

/**
 * Re-export the sentinel here too so bridge handler code only has
 * to import from `@agent-bridge/agents` to get the full coding-agent
 * surface (defs + sentinel + resolver + loader).
 */
export { ALL_REPOS_SENTINEL }
