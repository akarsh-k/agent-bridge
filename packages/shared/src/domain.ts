/**
 * Domain-level enums and shapes that describe data stored in Postgres but are
 * also consumed by the frontend. Kept browser-safe — no Node-only imports —
 * so `@agent-bridge/shared` can be imported from React components as well as
 * from `@agent-bridge/db`'s Drizzle schema.
 *
 * The Drizzle schema attaches these to `jsonb` columns via `.$type<…>()` so we
 * get compile-time safety without runtime enum/schema churn on migrations.
 */

// ─── LLM providers ────────────────────────────────────────────────────────

export const llmProviderKinds = [
  'openai',
  'anthropic',
  'gemini',
  'llama_cpp',
  'ollama',
  'openai_compatible',
] as const

export type LlmProviderKind = (typeof llmProviderKinds)[number]

// ─── Tools ────────────────────────────────────────────────────────────────

export const toolKinds = [
  'http',
  'shell',
  'mastra_builtin',
  'custom',
] as const

export type ToolKind = (typeof toolKinds)[number]

/**
 * Tool `config_json` is kind-dependent. The DB stores it as opaque jsonb; the
 * application layer narrows it with Zod before executing the tool. Keeping
 * the schema type open (`Record<string, unknown>`) avoids churning migrations
 * every time a new tool kind is added.
 */
export type ToolConfig = Record<string, unknown>

// ─── Repositories ─────────────────────────────────────────────────────────

export const repoStatuses = [
  'pending',
  'cloning',
  'cloned',
  'indexing',
  'ready',
  'error',
] as const

export type RepoStatus = (typeof repoStatuses)[number]

// ─── MCP connections ──────────────────────────────────────────────────────

export const mcpTransports = ['stdio', 'http', 'sse'] as const

export type McpTransport = (typeof mcpTransports)[number]

// ─── Runs ─────────────────────────────────────────────────────────────────

export const runStatuses = [
  'pending',
  'running',
  'completed',
  'error',
  'aborted',
] as const

export type RunStatus = (typeof runStatuses)[number]

// ─── Agent memory ─────────────────────────────────────────────────────────

/**
 * Memory scope. `resource` persists memory across all threads for the same
 * `resourceId` (typically a user). `thread` scopes it to one conversation.
 * Mastra's default is `resource` for both working memory and semantic recall.
 */
export const memoryScopes = ['thread', 'resource'] as const
export type MemoryScope = (typeof memoryScopes)[number]

/**
 * Mirrors Mastra's `MemoryOptions` (see https://mastra.ai/reference/memory).
 * Stored as a single jsonb blob on `agents` so the schema doesn't churn when
 * Mastra adds an option. At runtime the backend passes this straight into
 * `new Memory({ options: … })`, so the shape MUST match Mastra's API — any
 * drift is a runtime error.
 *
 * Drift-avoidance rule: before adding a field here, check Mastra's docs. If
 * we need an Agent-Bridge-specific knob that Mastra doesn't understand, keep
 * it on a sibling column (not inside this blob).
 */
export interface AgentMemoryConfig {
  /**
   * How many recent messages to inject on each call. `false` disables
   * recency-based history. Mastra default: `10`.
   */
  lastMessages?: number | false

  /**
   * Mastra surfaces two mutually-exclusive shapes for working memory:
   *   - `template: string` — markdown template the agent fills in.
   *   - `schema: JSONSchema7-like` — structured shape (we store only the
   *     JSON-Schema form; Zod objects are compiled at runtime and can't live
   *     in jsonb).
   * If both are set we defer to Mastra's own precedence rule at runtime.
   */
  workingMemory?: {
    enabled: boolean
    template?: string
    /** JSON Schema (draft-07+) object describing structured working memory. */
    schema?: Record<string, unknown>
    /** Default: `'resource'`. */
    scope?: MemoryScope
  }

  /**
   * Retrieves semantically similar historical messages. Requires a vector
   * store to be configured at the Memory instance level (Phase 3 wiring).
   */
  semanticRecall?: {
    /** Default: `4`. */
    topK?: number
    /**
     * How many neighbor messages to include on either side of each hit, for
     * context. Mastra default: `{ before: 1, after: 1 }`. Numeric shorthand
     * applies symmetrically.
     */
    messageRange?: number | { before: number; after: number }
    /** Default: `'resource'`. */
    scope?: MemoryScope
  }

  /**
   * When true, Mastra auto-generates a title for the thread from the first
   * exchange. Useful for the chat-history UI. Default: `false`.
   */
  generateTitle?: boolean
}
