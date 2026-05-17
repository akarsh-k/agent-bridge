/**
 * Drizzle schema for Agent Bridge.
 *
 * Design decisions (see `docs/ARCHITECTURE.md`):
 *   - UUIDs via `gen_random_uuid()` on user-facing tables; `bigserial` on the
 *     append-only audit log (`run_events`).
 *   - `text`-backed "enums" (status columns) validated by Zod at the edges,
 *     not `pgEnum` — avoids `ALTER TYPE ... ADD VALUE` migration pain.
 *   - `jsonb` columns carry compile-time shapes via `.$type<…>()` from
 *     `@agent-bridge/shared`.
 *   - Repos are deduped globally (Option B): unique on `(remote_url, branch)`.
 *     Agents attach via the `agent_repos` join table; relationships between repos
 *     stay per-agent so two agents can model the relationship differently.
 *   - Secrets live in `*_envelope text` columns holding `v1.iv.tag.ct` strings
 *     from `@agent-bridge/shared/crypto`. Parsing never happens in SQL.
 *   - `updated_at` is driven by a Postgres trigger (applied via the initial
 *     migration's manual append), not by application code.
 */

import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  AgentMemoryConfig,
  LlmProviderKind,
  LlmProviderModelsCache,
  LlmProviderRole,
  McpAuthKind,
  McpTransport,
  RepoStatus,
  RepoWikiStatus,
  RunStatus,
  ToolConfig,
  ToolKind,
} from '@agent-bridge/shared'

/**
 * `timestamptz` column helper. All times are stored with timezone (UTC) and
 * default to `now()` when created. `updated_at` is bumped by the trigger
 * installed in the initial migration.
 */
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()

// ─── llm_providers ────────────────────────────────────────────────────────
// Global (single-operator app). Multiple agents can share one provider row.

export const llmProviders = pgTable(
  'llm_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<LlmProviderKind>().notNull(),
    /**
     * Whether this provider serves chat completions or text embeddings.
     * Immutable after creation — flipping a chat row to embedding (or
     * vice versa) silently changes how every consumer interprets
     * `default_model`. If you want a different role, create a new row.
     *
     * The partial unique index below enforces at most one row with
     * `role='embedding'`: the workspace has exactly one embedding
     * model so semantic recall, repo indexing, and any future vector
     * consumer share one geometry.
     */
    role: text('role').$type<LlmProviderRole>().notNull(),
    label: text('label').notNull(),
    /** Nullable for vendor APIs; required for local endpoints. */
    baseUrl: text('base_url'),
    /**
     * The model id this provider serves. `role` governs how it's used:
     * chat-role rows feed `/v1/chat/completions`, embedding-role rows
     * feed `/v1/embeddings`. Nullable until the operator picks one
     * from the refreshed catalog — agents bound to a row with no
     * `default_model` fail at build time with a clear error.
     */
    defaultModel: text('default_model'),
    /** AES-256-GCM envelope. Nullable for no-auth local endpoints. */
    apiKeyEnvelope: text('api_key_envelope'),
    /**
     * Cached `/v1/models` response. `null` until the operator clicks
     * "Refresh models" (POST /api/llm-providers/:id/models/refresh).
     * Single source of truth for the model dropdowns in agent +
     * provider + wiki UIs — see `LlmProviderModelsCache` in
     * `@agent-bridge/shared`.
     */
    modelsJson: jsonb('models_json').$type<LlmProviderModelsCache>(),
    /**
     * Embedding vector dimension count (`docs/ARCHITECTURE.md §10`).
     * Only meaningful for `role='embedding'` rows; chat-role rows
     * leave this NULL. The worker forwards it to gitnexus via the
     * `GITNEXUS_EMBEDDING_DIMS` env var so gitnexus's local embedder
     * sizing matches the remote model. Common values: 384 (gitnexus
     * default + many small models), 768 (all-mpnet-base), 1024
     * (BGE-large), 1536 (text-embedding-3-small / text-embedding-ada-002),
     * 3072 (text-embedding-3-large). Stored as smallint (max 32767)
     * since no production embedder exceeds 4096.
     */
    embeddingDims: smallint('embedding_dims'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('llm_providers_label_uq').on(t.label),
    // Partial unique index — at most one embedding-role row exists.
    // Many chat-role rows are fine (one OpenAI key, one local Ollama,
    // …); the workspace embedder is deliberately a singleton.
    uniqueIndex('llm_providers_embedding_singleton_uq')
      .on(t.role)
      .where(sql`${t.role} = 'embedding'`),
  ],
)

// ─── agents ───────────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe slug; used to derive MCP tool names. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    systemPrompt: text('system_prompt').notNull().default(''),
    /**
     * `set null` on delete: deleting a provider leaves the agent intact but
     * "unconfigured" — the UI can prompt the user to pick another.
     */
    llmProviderId: uuid('llm_provider_id').references(() => llmProviders.id, {
      onDelete: 'set null',
    }),
    memoryEnabled: boolean('memory_enabled').notNull().default(false),
    memoryConfig: jsonb('memory_config').$type<AgentMemoryConfig>(),
    /**
     * Opt-in to the auto-mounted Inspector toolkit (`docs/ARCHITECTURE.md`
     * §10). When `true` (default — Repo inspector template):
     *   - `mountInspectorTools` mounts the six wrappers + gitnexus subprocess
     *   - `composeInstructions` auto-attaches the Inspector toolkit prompt
     *   - the bridge auto-derives `<slug>__inspect_codebase` for the IDE
     *   - `buildAgent` boot-fails if any attached repo lacks an embedding provider
     * When `false` (Build-your-own-agent template):
     *   - none of the above; the agent runs with only operator-authored
     *     skills, external MCP allowlist, and `bridge_tools` rows
     *   - the bridge instead exposes `<slug>__ask_agent` (free-form Q&A)
     *   - repos can still be attached but won't be queried until the
     *     operator opts back in via the Tools tab
     * Existing rows default to `true` so no behavior changes for agents
     * created before this column landed.
     */
    inspectorEnabled: boolean('inspector_enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agents_slug_uq').on(t.slug)],
)

// ─── skills ───────────────────────────────────────────────────────────────
// Free-form markdown fragments merged into the agent's system prompt.

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    markdownBody: text('markdown_body').notNull().default(''),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('skills_agent_name_uq').on(t.agentId, t.name)],
)

// ─── tools ────────────────────────────────────────────────────────────────
// Native tools configured directly on the agent. MCP-sourced tools go through
// `agent_mcp_tools` instead.

export const tools = pgTable(
  'tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ToolKind>().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    configJson: jsonb('config_json').$type<ToolConfig>().notNull().default({}),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tools_agent_name_uq').on(t.agentId, t.name)],
)

// ─── repos ────────────────────────────────────────────────────────────────
// Deduped globally. Multiple agents attach via `agent_repos`.

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    remoteUrl: text('remote_url').notNull(),
    branch: text('branch').notNull().default('main'),
    /** Absolute path under `.agent-bridge-data/repos/<hash>/source/`. */
    localPath: text('local_path'),
    status: text('status')
      .$type<RepoStatus>()
      .notNull()
      .default('pending'),
    lastIndexedAt: timestamp('last_indexed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastError: text('last_error'),
    /** AES-256-GCM envelope. Nullable for public repos. */
    gitPatEnvelope: text('git_pat_envelope'),
    /**
     * Wiki state — orthogonal to `status`. A repo stays `ready`
     * for agents while its wiki regenerates. `wiki_status` drives the
     * inspector dot + button enablement; the worker owns every transition
     * out of `generating`. The four sibling columns mirror the `last_*` /
     * `last_error` shape used by the index lifecycle.
     */
    wikiStatus: text('wiki_status')
      .$type<RepoWikiStatus>()
      .notNull()
      .default('none'),
    wikiGeneratedAt: timestamp('wiki_generated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** Page count parsed from `gitnexus wiki` stdout (`Pages: N`). */
    wikiPages: integer('wiki_pages'),
    wikiLastError: text('wiki_last_error'),
    /**
     * Soft-delete flag. The DELETE route flips this to `true`, detaches
     * `agent_repos`, and enqueues a `delete-repo` job; the worker handler
     * waits for any in-flight clone/index/wiki for this repo to finish,
     * `rm -rf`s the on-disk source dir, then hard-deletes the row.
     *
     * Why a soft-delete instead of dropping the row immediately:
     *   - The on-disk artifacts (cloned source + gitnexus index) outlive
     *     the SQL DELETE — without a marker, the worker's cleanup job
     *     would have no way to look up the path after the row is gone.
     *   - Holding the row keeps FK cascades simple (`agent_repos` /
     *     `repo_relationships` continue to reference a real id) until cleanup
     *     finishes; the row only disappears once disk is clean.
     *   - List routes filter `deletion_pending = true` so the UI hides
     *     the repo immediately while cleanup runs in the background.
     */
    deletionPending: boolean('deletion_pending').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('repos_url_branch_uq').on(t.remoteUrl, t.branch)],
)

// ─── index summary (file-backed, no table) ───────────────────────────────
//
// Historical note: an earlier iteration
// duplicated `gitnexus analyze` counts into a `repo_index_summary` table.
// We dropped it in favour of reading `<source>/.gitnexus/meta.json` lazily
// on repo-read endpoints — gitnexus already persists the same data there,
// and a second copy in Postgres only invites drift between the two.
// See `@agent-bridge/shared/gitnexus`:`readIndexSummary(sourceDir)`.

// ─── agent_repos (join) ───────────────────────────────────────────────────
// Per-agent attachment. Connector/description for the *repo's role within
// this agent* lives here. Cross-repo relationships between two repos live
// in `repo_relationships` instead.

export const agentRepos = pgTable(
  'agent_repos',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** Optional short label ("frontend", "backend"). */
    role: text('role'),
    description: text('description'),
    /**
     * Operator-curated extra names this repo answers to: local folder
     * names, short codes, legacy names. Used by the inspector toolkit's
     * `resolveRepoHint` to fuzzy-match a coding agent's `repo_hint` /
     * `local_folder` against operator-known synonyms
     * (`packages/agents/src/inspector/repo-resolve.ts`).
     *
     * Always populated as `[]` rather than NULL so consumers don't
     * have to nullsafe every read. Strings are operator-trimmed,
     * de-duped, and lower-cased at the DTO layer; the DB just stores
     * whatever the validated input produced.
     */
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    /** React Flow canvas coordinates. Signed integers (can be negative). */
    positionX: integer('position_x').notNull().default(0),
    positionY: integer('position_y').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.repoId] })],
)

// ─── repo_relationships ───────────────────────────────────────────────────
// Agent-scoped directed relationships between two attached repos
// (operator-curated). Two agents can model the same pair of repos
// differently. Distinct from `graph_subset.edges` in mini-repos, which
// are code-symbol graph edges derived from gitnexus.

export const repoRelationships = pgTable(
  'repo_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    fromRepoId: uuid('from_repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    toRepoId: uuid('to_repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'repo_relationships_distinct_repos',
      sql`${t.fromRepoId} <> ${t.toRepoId}`,
    ),
    index('repo_relationships_agent_idx').on(t.agentId),
  ],
)

// ─── mcp_connections ──────────────────────────────────────────────────────
// Global (single-operator). Per-agent selection happens in `agent_mcp_tools`.

export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    transport: text('transport').$type<McpTransport>().notNull(),
    /** stdio: command path; http/sse: absolute URL. */
    commandOrUrl: text('command_or_url').notNull(),
    argsJson: jsonb('args_json').$type<string[]>().notNull().default([]),
    /** AES-256-GCM envelope over a JSON map of env-var name → value. */
    envEnvelope: text('env_envelope'),
    /** AES-256-GCM envelope over HTTP/SSE headers map. */
    headersEnvelope: text('headers_envelope'),
    /**
     * Authentication kind for the connection. `'none'` and `'headers'`
     * capture the pre-Phase-4H behavior — stdio rows and header-based
     * HTTP rows. `'oauth'` opts in to Mastra's `MCPOAuthClientProvider`
     * with tokens persisted in `mcp_oauth_state`. The wire-level
     * discriminator on the DTO mirrors this column 1:1.
     */
    authKind: text('auth_kind').$type<McpAuthKind>().notNull().default('none'),
    /**
     * Sandbox opt-out. When true, `spawnSandboxed` passes the real `$HOME`
     * so MCPs like `gh` that read `~/.config/gh` can see the user's CLI auth.
     * UI must warn explicitly; default is strict isolation.
     */
    allowHostHome: boolean('allow_host_home').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('mcp_connections_name_uq').on(t.name)],
)

// ─── mcp_oauth_state ──────────────────────────────────────────────────────
// Per-connection OAuth persistence used by Mastra's `MCPOAuthClientProvider`.
// One row per (connection, scope_key) — e.g. `tokens`, `client_info`,
// `code_verifier`, `state`. Values are `v1.iv.tag.ct` envelopes from
// `@agent-bridge/shared/crypto`, same discipline as `env_envelope`. Cascades
// with the parent connection so deleting an MCP also revokes its auth cache.

export const mcpOauthState = pgTable(
  'mcp_oauth_state',
  {
    mcpConnectionId: uuid('mcp_connection_id')
      .notNull()
      .references(() => mcpConnections.id, { onDelete: 'cascade' }),
    /**
     * Logical slot name. Matches the keys Mastra's `MCPOAuthClientProvider`
     * reads/writes via our `OAuthStorage` adapter. Kept as free-form text
     * (not a pgEnum) because the upstream set is defined by Mastra/the MCP
     * auth spec and may grow — e.g. a future `resource_metadata` cache.
     */
    scopeKey: text('scope_key').notNull(),
    valueEnvelope: text('value_envelope').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.mcpConnectionId, t.scopeKey] }),
  ],
)

// ─── agent_mcp_tools (join) ───────────────────────────────────────────────
// Allowlist: only tools present in this table are exposed to the agent.
// Users must explicitly opt in — never "everything on by default".

export const agentMcpTools = pgTable(
  'agent_mcp_tools',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    mcpConnectionId: uuid('mcp_connection_id')
      .notNull()
      .references(() => mcpConnections.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.agentId, t.mcpConnectionId, t.toolName],
    }),
  ],
)

// ─── bridge_tools ────────────────────────────────────────────────────────
// Outbound MCP tools an agent exposes to IDEs (Cursor, Claude Code) via
// `apps/mcp-bridge`. Distinct from `agent_mcp_tools` (which is the
// INBOUND allowlist of MCP tools the agent itself can invoke). See
// `docs/ARCHITECTURE.md` §8 for the inbound/outbound naming convention.
//
// Resolution at MCP-bridge boot (per agent):
//   1. If the agent has ≥1 row in `bridge_tools` with `enabled = true`,
//      expose those tools verbatim (one MCP tool per row).
//   2. Otherwise, fall back to the 1:1 default (`query_<slug>`).
//
// `name` is GLOBALLY unique (MCP spec requires per-server tool-name
// uniqueness; one bridge process = one MCP server). The `query_` prefix
// is reserved for the auto-derived defaults, enforced by a CHECK
// constraint so an explicit row can't shadow the implicit default.
//
// `input_schema` stores a JSON Schema draft-07 object — the format MCP
// clients actually consume. We don't store Zod (doesn't serialize)
// or our own schema language (would force translation at boot).

export const bridgeTools = pgTable(
  'bridge_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * MCP tool identifier as the IDE sees it. Must satisfy
     * `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` and must NOT start with `query_`
     * (reserved for the fallback). Both rules are enforced at the
     * DB layer via CHECK constraints — the application catches them
     * earlier with a friendlier error, but the DB is the last line.
     */
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /**
     * JSON Schema draft-07 object describing the tool's input. Stored
     * as opaque jsonb at the schema layer; the auth UI parses + the
     * mcp-bridge ships it verbatim to clients via `tools/list`.
     */
    inputSchema: jsonb('input_schema')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * Mustache-ish prompt template — placeholders are wrapped in `{{ … }}`
     * and resolve to the named arg at invocation time. The bridge
     * synthesises `runs.input_prompt` from this template + the
     * incoming arg map. We store the raw template (not the rendered
     * prompt) so future arg changes don't require migration.
     */
    promptTemplate: text('prompt_template').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bridge_tools_name_uq').on(t.name),
    index('bridge_tools_agent_idx').on(t.agentId),
    check(
      'bridge_tools_name_not_reserved',
      sql`${t.name} NOT LIKE 'query\\_%' ESCAPE '\\'`,
    ),
    check(
      'bridge_tools_name_format',
      sql`${t.name} ~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'`,
    ),
  ],
)

// ─── runs ─────────────────────────────────────────────────────────────────

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Matches the SSE `streamId`; what the browser tails. */
    streamId: text('stream_id').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('pending'),
    inputPrompt: text('input_prompt').notNull(),
    outputSummary: text('output_summary'),
    errorMessage: text('error_message'),
    /**
     * Soft link to `mastra.threads(id)`. Populated only when the agent
     * has `memoryEnabled=true` and a thread was resolved at dispatch
     * time (user-supplied or defaulted to `runId`). Nullable so one-off
     * agents without memory don't carry a phantom thread id. No FK —
     * the target table lives in the `mastra` schema which Drizzle
     * doesn't manage; cross-schema FKs are legal but would couple our
     * migration lifecycle to Mastra's auto-init ordering.
     */
    mastraThreadId: text('mastra_thread_id'),
    /**
     * Soft link to `mastra.resources(id)`. Same story as
     * `mastra_thread_id`; populated only when memory is enabled.
     * Defaults to `agent:<agentId>` so multiple users aren't needed to
     * scope things in the single-operator local-first MVP — future
     * multi-user auth will stamp real user ids here.
     */
    mastraResourceId: text('mastra_resource_id'),
    /**
     * Which bridge tool the IDE invoked, when this run was
     * started by `apps/mcp-bridge` AND the agent had ≥1 explicit
     * `bridge_tools` row. 1:1 default runs leave this NULL —
     * the auto-derived `query_<slug>` tool isn't a row in
     * `bridge_tools`, and giving it a synthetic name here would muddle
     * the "explicit vs default" filter. Soft column (no FK): bridge
     * tools can be deleted while a run row that referenced them
     * still exists, and we don't want to cascade-null on every edit.
     */
    bridgeToolName: text('bridge_tool_name'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /**
     * Token accounting from the LLM provider's response. Populated by
     * `markCompleted` when the dispatcher finalizes a run AND Mastra's
     * stream payload included a `usage` object. Nullable because
     * (a) errored runs may not have any usage, (b) some local OpenAI-
     * compatible servers don't report usage. Used for the Configure-
     * tab budget card (post-call truth) and per-thread cumulative
     * cost roll-ups.
     */
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /**
     * Mini-repos accumulated across this run's wrapper invocations
     * (`docs/ARCHITECTURE.md §10`). Each inspector wrapper appends
     * its `MiniRepo` payload as one element of this array. The IDE
     * bridge ships this verbatim under D17's `mini_repos[]` field;
     * chat-only runs that never invoke a wrapper leave it NULL.
     *
     * Capped at ~14 KiB total serialised size by the application
     * layer (`runsRepo.appendMinirepo`). When append would overflow,
     * the OLDEST entries drop first — D17's "newest evidence wins"
     * semantics for IDE consumers.
     */
    minirepoJson: jsonb('minirepo_json'),
    /**
     * Always-on per-run provenance + editor context. Populated at
     * dispatch time:
     *   - bridge handlers stamp the IDE clientInfo (cursor / claude-code
     *     / codex / …), the calling agent + tool, repo hints, and any
     *     cursor coordinates the IDE LLM passed
     *   - the chat backend synthesises `{client: {name: 'web-chat'},
     *     tool: {name: 'chat'}, …}` so web-chat runs carry the same
     *     shape and operator skills can branch on `client.name`
     *
     * Callers (bridge handler, web-chat backend) prepend a single
     * italic `_Request origin: …_` metadata line to the user prompt
     * when this is set, so the LLM sees provenance before the question.
     * NOT injected as a system message (that path tripped the Mastra
     * working-memory + Jinja issue on local templates).
     *
     * Wire shape: `Callsite` in `@agent-bridge/shared/dtos/runs`. Null
     * only on legacy callers that predate the column.
     */
    callsiteJson: jsonb('callsite_json'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('runs_stream_id_uq').on(t.streamId),
    index('runs_agent_started_idx').on(t.agentId, t.startedAt),
    // Chat-history replay: "give me all runs for this Mastra thread,
    // newest first". Partial index skips the NULL rows that dominate
    // for memory-disabled agents so the index stays cheap.
    index('runs_mastra_thread_idx')
      .on(t.mastraThreadId, t.startedAt)
      .where(sql`${t.mastraThreadId} IS NOT NULL`),
    // "Runs of bridge tool X for this agent" filter for the bridge tools UI.
    // Partial index drops the NULL rows from chat / 1:1 default runs
    // so it stays small even after years of usage.
    index('runs_agent_bridge_tool_idx')
      .on(t.agentId, t.bridgeToolName, t.startedAt)
      .where(sql`${t.bridgeToolName} IS NOT NULL`),
  ],
)

// ─── run_events (append-only audit log) ───────────────────────────────────
// Mirrors the RunEvent envelope. `bigserial` rather than uuid — high volume,
// insert-only, clustered access pattern.

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    kind: text('kind').notNull(),
    payloadJson: jsonb('payload_json'),
  },
  (t) => [index('run_events_run_ts_idx').on(t.runId, t.ts)],
)

// ─── agent_config_events (append-only audit log) ─────────────────────────
// Persisted history of `agent.config.changed` events (skill added, repo
// attached, MCP allowlist replaced, etc). Originally these only existed
// as live SSE frames — but operators wanted "when did I attach repo X?"
// to be answerable across page reloads, so we now also write a row here
// whenever `publishAgentConfig` fires. The Activity timeline reads from
// this table for past events and stitches in the live SSE frames as
// they arrive.
export const agentConfigEvents = pgTable(
  'agent_config_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    label: text('label').notNull(),
    detail: text('detail'),
  },
  (t) => [index('agent_config_events_agent_ts_idx').on(t.agentId, t.ts)],
)

// ─── worker_jobs (lifecycle row per repo background job) ─────────────────
// Mirrors the `runs` table for agent invocations: one row per discrete
// clone / index / wiki attempt, with start/finish timestamps and a
// status enum. The /logs page renders these alongside agent runs so
// the operator has one timeline for "everything that happened in the
// workspace". `worker_events` carries the granular per-line events.
//
// `job_kind` is `text` rather than `pgEnum` for the same reason
// `RunStatus` is — adds-without-migration. Enforced at the edges via
// Zod / TS literal types in `@agent-bridge/shared`.

export const workerJobs = pgTable(
  'worker_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    jobKind: text('job_kind').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', {
      withTimezone: true,
      mode: 'date',
    }),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
  },
  (t) => [
    // "Recent jobs for this repo, newest first" — drives both the
    // /logs feed (when filtered to one repo) and the run-detail
    // sheet's "previous attempts" affordance.
    index('worker_jobs_repo_started_idx').on(t.repoId, t.startedAt),
    // Global "all recent worker jobs" — same access pattern the
    // runs router uses for its newest-first list.
    index('worker_jobs_started_idx').on(t.startedAt),
  ],
)

// ─── worker_events (append-only audit log for worker jobs) ───────────────
// Same shape as `run_events`, just keyed by `job_id` (worker_jobs).
// `bigserial` because volume is high — a long index job emits hundreds
// of progress lines. ON DELETE CASCADE so a job removal cleans up.

export const workerEvents = pgTable(
  'worker_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => workerJobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    kind: text('kind').notNull(),
    payloadJson: jsonb('payload_json'),
  },
  (t) => [index('worker_events_job_ts_idx').on(t.jobId, t.ts)],
)

// ─── Inferred row / insert types ──────────────────────────────────────────

export type LlmProviderRow = typeof llmProviders.$inferSelect
export type LlmProviderInsert = typeof llmProviders.$inferInsert

export type AgentRow = typeof agents.$inferSelect
export type AgentInsert = typeof agents.$inferInsert

export type SkillRow = typeof skills.$inferSelect
export type SkillInsert = typeof skills.$inferInsert

export type ToolRow = typeof tools.$inferSelect
export type ToolInsert = typeof tools.$inferInsert

export type RepoRow = typeof repos.$inferSelect
export type RepoInsert = typeof repos.$inferInsert

export type AgentRepoRow = typeof agentRepos.$inferSelect
export type AgentRepoInsert = typeof agentRepos.$inferInsert

export type RepoRelationshipRow = typeof repoRelationships.$inferSelect
export type RepoRelationshipInsert = typeof repoRelationships.$inferInsert

export type McpConnectionRow = typeof mcpConnections.$inferSelect
export type McpConnectionInsert = typeof mcpConnections.$inferInsert

export type AgentMcpToolRow = typeof agentMcpTools.$inferSelect
export type AgentMcpToolInsert = typeof agentMcpTools.$inferInsert

export type BridgeToolRow = typeof bridgeTools.$inferSelect
export type BridgeToolInsert = typeof bridgeTools.$inferInsert

export type McpOauthStateRow = typeof mcpOauthState.$inferSelect
export type McpOauthStateInsert = typeof mcpOauthState.$inferInsert

export type RunRow = typeof runs.$inferSelect
export type RunInsert = typeof runs.$inferInsert

export type RunEventRow = typeof runEvents.$inferSelect
export type RunEventInsert = typeof runEvents.$inferInsert

export type AgentConfigEventRow = typeof agentConfigEvents.$inferSelect
export type AgentConfigEventInsert = typeof agentConfigEvents.$inferInsert

export type WorkerJobRow = typeof workerJobs.$inferSelect
export type WorkerJobInsert = typeof workerJobs.$inferInsert

export type WorkerEventRow = typeof workerEvents.$inferSelect
export type WorkerEventInsert = typeof workerEvents.$inferInsert

/**
 * Canonical table list. Used by `/api/health/db` to build the row-count map
 * without hardcoding table names in two places. Skip `run_events` for the
 * health check (append-only audit; counts can be huge) but include it
 * separately if needed.
 */
export const allTables = [
  llmProviders,
  agents,
  skills,
  tools,
  repos,
  agentRepos,
  repoRelationships,
  mcpConnections,
  mcpOauthState,
  agentMcpTools,
  bridgeTools,
  runs,
  runEvents,
  agentConfigEvents,
  workerJobs,
  workerEvents,
] as const

/**
 * Human-readable table name for each `pgTable` instance above. Drizzle's
 * `getTableName` would work too, but keeping this explicit documents the
 * full list of tables in one place.
 */
export const tableNames = [
  'llm_providers',
  'agents',
  'skills',
  'tools',
  'repos',
  'agent_repos',
  'repo_relationships',
  'mcp_connections',
  'mcp_oauth_state',
  'agent_mcp_tools',
  'bridge_tools',
  'runs',
  'run_events',
  'agent_config_events',
  'worker_jobs',
  'worker_events',
] as const

export type TableName = (typeof tableNames)[number]

/**
 * Tables that carry `foreign_key_*` constraints requiring `updated_at`
 * triggers. Kept separate because `agent_mcp_tools` and `run_events` are
 * insert/delete only (no meaningful `updated_at`).
 */
export const tablesWithUpdatedAt = [
  'llm_providers',
  'agents',
  'skills',
  'tools',
  'repos',
  'agent_repos',
  'repo_relationships',
  'mcp_connections',
  'mcp_oauth_state',
  'bridge_tools',
  'runs',
] as const
