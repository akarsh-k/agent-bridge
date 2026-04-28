/**
 * Drizzle schema for Agent Bridge.
 *
 * Design decisions (see `docs/PLAN.md` § Phase 1):
 *   - UUIDs via `gen_random_uuid()` on user-facing tables; `bigserial` on the
 *     append-only audit log (`run_events`).
 *   - `text`-backed "enums" (status columns) validated by Zod at the edges,
 *     not `pgEnum` — avoids `ALTER TYPE ... ADD VALUE` migration pain.
 *   - `jsonb` columns carry compile-time shapes via `.$type<…>()` from
 *     `@agent-bridge/shared`.
 *   - Repos are deduped globally (Option B): unique on `(remote_url, branch)`.
 *     Agents attach via the `agent_repos` join table; edges between repos
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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  AgentMemoryConfig,
  LlmProviderKind,
  McpAuthKind,
  McpTransport,
  RepoStatus,
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
    label: text('label').notNull(),
    /** Nullable for vendor APIs; required for local endpoints. */
    baseUrl: text('base_url'),
    defaultModel: text('default_model'),
    /** AES-256-GCM envelope. Nullable for no-auth local endpoints. */
    apiKeyEnvelope: text('api_key_envelope'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('llm_providers_label_uq').on(t.label)],
)

// ─── agents ───────────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe slug; used to derive MCP tool names in Phase 5. */
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
    /** Specific model; falls back to `llm_providers.default_model`. */
    model: text('model'),
    memoryEnabled: boolean('memory_enabled').notNull().default(false),
    memoryConfig: jsonb('memory_config').$type<AgentMemoryConfig>(),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('repos_url_branch_uq').on(t.remoteUrl, t.branch)],
)

// ─── index summary (file-backed, no table) ───────────────────────────────
//
// Historical note: an earlier iteration (Phase 2B as initially landed)
// duplicated `gitnexus analyze` counts into a `repo_index_summary` table.
// We dropped it in favour of reading `<source>/.gitnexus/meta.json` lazily
// on repo-read endpoints — gitnexus already persists the same data there,
// and a second copy in Postgres only invites drift between the two.
// See `@agent-bridge/shared/gitnexus`:`readIndexSummary(sourceDir)`.

// ─── agent_repos (join) ───────────────────────────────────────────────────
// Per-agent attachment. Connector/description for the *repo's role within
// this agent* lives here. Connector edges between two repos live in
// `repo_edges` instead.

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
    /** React Flow canvas coordinates. Signed integers (can be negative). */
    positionX: integer('position_x').notNull().default(0),
    positionY: integer('position_y').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.repoId] })],
)

// ─── repo_edges ───────────────────────────────────────────────────────────
// Agent-scoped directed edges between two attached repos. Two agents can
// model the same pair of repos differently.

export const repoEdges = pgTable(
  'repo_edges',
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
    check('repo_edges_distinct_repos', sql`${t.fromRepoId} <> ${t.toRepoId}`),
    index('repo_edges_agent_idx').on(t.agentId),
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
     * scope things in the single-operator local-first MVP — Phase 5
     * multi-user auth will stamp real user ids here.
     */
    mastraResourceId: text('mastra_resource_id'),
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

export type RepoEdgeRow = typeof repoEdges.$inferSelect
export type RepoEdgeInsert = typeof repoEdges.$inferInsert

export type McpConnectionRow = typeof mcpConnections.$inferSelect
export type McpConnectionInsert = typeof mcpConnections.$inferInsert

export type AgentMcpToolRow = typeof agentMcpTools.$inferSelect
export type AgentMcpToolInsert = typeof agentMcpTools.$inferInsert

export type McpOauthStateRow = typeof mcpOauthState.$inferSelect
export type McpOauthStateInsert = typeof mcpOauthState.$inferInsert

export type RunRow = typeof runs.$inferSelect
export type RunInsert = typeof runs.$inferInsert

export type RunEventRow = typeof runEvents.$inferSelect
export type RunEventInsert = typeof runEvents.$inferInsert

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
  repoEdges,
  mcpConnections,
  mcpOauthState,
  agentMcpTools,
  runs,
  runEvents,
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
  'repo_edges',
  'mcp_connections',
  'mcp_oauth_state',
  'agent_mcp_tools',
  'runs',
  'run_events',
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
  'repo_edges',
  'mcp_connections',
  'mcp_oauth_state',
  'runs',
] as const
