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

/**
 * All supported providers speak the OpenAI HTTP API
 * (`/v1/chat/completions`, `/v1/models`). This is deliberate: Anthropic
 * and Gemini require their own request/response envelopes, auth
 * schemes, and model-list quirks, and the value of supporting them
 * natively (two extra SDKs, two extra connector files, two extra error
 * taxonomies) is low compared to running them behind a compat proxy
 * (LiteLLM, vLLM, etc.) and configuring them as `openai_compatible`.
 *
 * Kind acts as a UI/UX hint (default base URL, form labels, icons);
 * the connector code is the same for all four.
 */
export const llmProviderKinds = [
  'openai',
  'llama_cpp',
  'ollama',
  'openai_compatible',
] as const

export type LlmProviderKind = (typeof llmProviderKinds)[number]

/**
 * Snapshot of `/v1/models` for a configured provider, cached on the
 * `llm_providers.models_json` jsonb column. Populated by the
 * `POST /api/llm-providers/:id/models/refresh` endpoint and read by every
 * model-picker UI (agent inspector, wiki button, llm-new-form). `null`
 * when the operator hasn't refreshed yet — pickers render as plain
 * free-text inputs in that case.
 *
 * `models` are stored verbatim from the upstream `/v1/models` response
 * (`data[].id`); we don't merge multiple fetches or curate. `fetchedAt`
 * lets the UI render "refreshed 3m ago" hints + lets a future TTL
 * eviction job decide what's stale.
 */
export interface LlmProviderModelsCache {
  readonly models: readonly string[]
  readonly fetchedAt: string
}

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

/**
 * Wiki generation is orthogonal to the main `RepoStatus` state machine —
 * a repo stays `ready` (i.e. usable by agents + indexable) regardless of
 * whether its wiki is current. This decoupling matters because wiki gen
 * can take minutes against an LLM and we don't want it to make the repo
 * look unusable for chat in the meantime.
 *
 *   - `none`        — wiki has never been generated for this repo.
 *   - `generating`  — a `gitnexus wiki` job is in flight.
 *   - `ready`       — wiki is on disk under `<source>/.gitnexus/wiki/`.
 *   - `error`       — last wiki run failed; `wiki_last_error` carries why.
 */
export const repoWikiStatuses = [
  'none',
  'generating',
  'ready',
  'error',
] as const

export type RepoWikiStatus = (typeof repoWikiStatuses)[number]

/**
 * Structural counts from a `gitnexus analyze` pass, mirrored from gitnexus's
 * own `RepoMeta.stats` shape (see
 * node_modules/gitnexus/dist/storage/repo-manager.d.ts).
 *
 * Every count is optional because older gitnexus versions — or edge cases
 * like a `--skip-git` analyze of an empty directory — may omit fields.
 * `indexedAt` + `indexedCommitSha` are derived from `meta.json`'s
 * `indexedAt` and `lastCommit` so the UI has one self-contained payload to
 * render.
 *
 * The DB layer stores the raw `meta.json` in a sibling `jsonb` column
 * (`raw_meta_json`) so future gitnexus fields are recoverable without a
 * schema migration.
 */
export interface RepoIndexSummary {
  readonly indexedAt: string
  readonly indexedCommitSha: string | null
  readonly files: number | null
  readonly nodes: number | null
  readonly edges: number | null
  readonly communities: number | null
  readonly processes: number | null
  readonly embeddings: number | null
}

// ─── MCP connections ──────────────────────────────────────────────────────

export const mcpTransports = ['stdio', 'http', 'sse'] as const

export type McpTransport = (typeof mcpTransports)[number]

/**
 * Authentication strategy for an MCP connection:
 *   - `'none'`     — no auth; stdio default, and the implicit choice for
 *                    http/sse MCPs that don't require any credential.
 *   - `'oauth'`    — http/sse only. Uses Mastra's `MCPOAuthClientProvider`
 *                    with dynamic client registration + PKCE; tokens
 *                    persisted in `mcp_oauth_state`.
 *   - `'headers'`  — http/sse only. Static headers (bearer / API key /
 *                    whatever the server expects) from the
 *                    `headers_envelope` column.
 */
export const mcpAuthKinds = ['none', 'oauth', 'headers'] as const

export type McpAuthKind = (typeof mcpAuthKinds)[number]

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
