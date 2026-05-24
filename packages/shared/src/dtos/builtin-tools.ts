/**
 * Workspace-level built-in tools that aren't part of the inspector
 * toolkit but ARE auto-mounted on every agent that meets their
 * activation condition. The Tools tab surfaces them under the same
 * "Built-in tools" subhead so the operator can see the full picture
 * of what the LLM has access to.
 *
 * Why a separate catalog: the inspector wrappers mount as a single
 * group when an agent has any indexed repo. These two mount on
 * orthogonal conditions (workspace embedding provider / agent's lazy
 * skills), so grouping them with the inspector list would muddy the
 * "they all turn on together" narrative.
 *
 * Adding a new built-in is a two-place change: this file + the
 * matching factory (`build*Tool` in `packages/agents`). Drift here is
 * a doc bug, not a runtime bug — the agent will still mount the real
 * tool; the catalog row will just be stale.
 */

export interface BuiltinToolDefinition {
  readonly name: 'search_knowledge' | 'read_skill'
  /** Description the LLM sees — matches the runtime
   *  `createTool({description})` call as closely as the dynamic part
   *  allows (the runtime descriptions interpolate attached file or
   *  skill names; this catalog version uses a generic phrasing). */
  readonly description: string
  /** Human-readable mount condition shown under the description in
   *  the Tools tab. Reflects the same gate the runtime applies in
   *  `buildAgent`. */
  readonly mountWhen: string
}

export type BuiltinToolName = BuiltinToolDefinition['name']

export const BUILTIN_TOOL_DEFINITIONS: ReadonlyArray<BuiltinToolDefinition> =
  Object.freeze([
    {
      name: 'search_knowledge',
      description:
        'Search uploaded knowledge files (markdown, text, PDF) for passages relevant to a query. Returns top chunks with file name, page, section, snippet, and a relevance score. Hybrid vector + BM25 retrieval, fused via Reciprocal Rank Fusion, then reranked by an LLM-as-judge pass. Use the returned snippets to ground your answer and cite by file name.',
      mountWhen:
        'Available when the workspace has an embedding provider configured (Library → Providers, role: embedding).',
    },
    {
      name: 'read_skill',
      description:
        'Read the full body of a skill by name. Lazy skills only emit their name + short description in the system prompt; call this when the LLM judges the skill might be relevant to the current task and needs the full text.',
      mountWhen:
        'Available when this agent has at least one skill attached without the "always include" flag (lazy skills).',
    },
  ])
