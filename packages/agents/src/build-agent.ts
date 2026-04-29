/**
 * Factory: build a Mastra `Agent` instance from its DB rows.
 *
 * Why this package exists (and why it's the ONLY place allowed to import
 * `@mastra/*` — enforced by the root ESLint guard rail):
 *
 *   - The runtime shape of a Mastra Agent is a tangle of internal types
 *     (`AgentConfig`, `MastraModelConfig`, `MemoryConfigInternal`, …) that
 *     change across minor versions. Keeping the surface behind one thin
 *     `buildAgent(…)` export means the rest of the monorepo upgrades
 *     mechanically when Mastra changes.
 *   - Apps (`apps/backend`, `apps/worker`) only ever see the returned
 *     object and the `.agent` field. They call Mastra methods on it
 *     (`.stream(...)`, `.generate(...)`) but never construct one.
 *
 * Design choices locked in here:
 *
 *   - Providers are unified behind the `OpenAICompatibleConfig` path.
 *     Every kind we ship (`openai | llama_cpp | ollama | openai_compatible`)
 *     speaks the OpenAI HTTP API, so we always pass `{ providerId, modelId,
 *     url, apiKey }`. Mastra skips its internal provider registry as soon
 *     as `url` is set — that's exactly what we want (we own the base URL;
 *     Mastra shouldn't try to reach `https://api.openai.com` on us).
 *   - The `pg.Pool` from `@agent-bridge/db` is reused. Mastra's
 *     `PostgresStore` supports `{ pool }` directly via `PoolInstanceConfig`.
 *     Creating a second pool would double our connection count on a tiny
 *     dev DB for no reason.
 *   - Mastra tables live in a dedicated `mastra` schema (`schemaName:
 *     'mastra'`) so our own Drizzle migrations and Mastra's auto-init
 *     never fight over the `public` schema. Restore/reset is a one-line
 *     `DROP SCHEMA mastra CASCADE`.
 *   - System prompt assembly: `agents.system_prompt` first, then each
 *     skill's markdown body in `position` order, each fenced with a
 *     markdown `##` heading. Rows with empty bodies are skipped so a
 *     placeholder skill doesn't leave a trailing blank section.
 *   - API keys are decrypted inside this function and never logged. The
 *     envelope comes from `llm_providers.api_key_envelope`; decryption
 *     uses `@agent-bridge/shared`'s AES-256-GCM helper which errors on
 *     tamper/wrong-key so a corrupted envelope fails loudly.
 *   - Phase 3c — GitNexus MCP mount: when the agent has at least one
 *     `status='ready'` repo attached, we spawn ONE sandboxed
 *     `gitnexus mcp` subprocess (via `@mastra/mcp`'s `MCPClient`) and pass
 *     the resulting tools into the `Agent` constructor. The subprocess
 *     multiplexes across every attached repo via the `repo` arg on each
 *     tool — there is deliberately NOT one subprocess per repo. Callers
 *     tear the subprocess down via `BuiltAgent.disconnect()`.
 *   - Semantic recall / vector store / arbitrary MCPs remain out of scope
 *     here (Phase 3+ and Phase 4).
 *
 * Failure modes are explicit:
 *
 *   - Agent row missing          → `Error: Agent ${id} not found`
 *   - No provider attached       → `Error: ...has no llm_provider configured`
 *   - Provider row missing       → `Error: references missing llm_provider`
 *   - No model on either row     → `Error: no model configured and provider
 *                                   ... has no default_model`
 *   - Local provider sans URL    → `Error: requires a base URL`
 *   - GitNexus MCP mount fails   → propagated from `mountGitnexusMcp`;
 *                                   means the subprocess exists but
 *                                   couldn't list tools. Treat as config
 *                                   (bad install, corrupt index) not 500.
 *
 * Callers should catch and surface these as 409/422 on the HTTP edge — an
 * agent that can't be built is a user-configuration problem, not a 500.
 */

import { Agent } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import type { Tool } from '@mastra/core/tools'
import { Memory } from '@mastra/memory'
import { PgVector, PostgresStore } from '@mastra/pg'
import { and, asc, eq } from 'drizzle-orm'
import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import type { LlmProviderRow, SkillRow } from '@agent-bridge/db/schema'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import type { AgentMemoryConfig, LlmProviderKind } from '@agent-bridge/shared'

import {
  emptyGitnexusMountMeta,
  mountGitnexusMcp,
  type GitnexusMountMeta,
  type MountedGitnexus,
} from './mcp/gitnexus-mcp.js'
import {
  emptyExternalMcpsMountMeta,
  mountExternalMcps,
  type ExternalMcpsMountMeta,
  type McpLogHandler,
  type MountedExternalMcps,
} from './mcp/external-mcps.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface BuildAgentInput {
  /** Shared DB handle. The raw `pg.Pool` is reused for Mastra storage. */
  readonly db: AgentBridgeDb
  /** UUID of the `agents` row to build. */
  readonly agentId: string
  /**
   * Skip spawning the `gitnexus mcp` subprocess even if ready repos are
   * attached. Useful for the smoke script (LLM-only sanity check) and
   * for the imminent Phase 3d HTTP edge when we want to construct the
   * Agent on one request and serve many runs without paying the spawn
   * cost per call.
   */
  readonly disableGitnexus?: boolean
  /**
   * Skip mounting external MCP connections even when the agent has an
   * allowlist. Same role as `disableGitnexus` — lets the smoke script
   * isolate LLM failures from MCP failures without editing DB rows.
   */
  readonly disableExternalMcps?: boolean
}

export interface BuiltAgent {
  /** Constructed Mastra Agent. Call `.stream(...)` / `.generate(...)` on it. */
  readonly agent: Agent
  /**
   * Non-sensitive metadata useful for log lines and run records. Does NOT
   * include the API key or the full base URL (kept internal to Mastra's
   * model config) — just enough to trace a run back to its configuration.
   */
  readonly meta: BuiltAgentMeta
  /**
   * Plaintext secrets that were decrypted to construct this agent.
   * Callers MUST pass these through `redactSecrets` / `redactMany`
   * before publishing any event or persisting any string that may have
   * been echoed by the LLM or a tool. Today this holds at most the
   * provider apiKey; Phase 4 adds per-MCP credentials here. Empty when
   * the agent uses only no-auth local endpoints.
   *
   * Kept on the built agent (not re-derived by the dispatcher) so we
   * don't pay the decryption cost twice, and so a future "pooled built
   * agent" cache keeps secret lifetime scoped to the cache entry.
   */
  readonly secrets: readonly string[]
  /**
   * Subscribe to live stderr lines from any mounted stdio external
   * MCP. Returns an unsubscribe closure. No-op when there are no
   * stdio external MCPs mounted (http/sse produce no stderr; gitnexus
   * MCP logs are intentionally not surfaced through this channel —
   * they're local-only developer concern).
   *
   * The dispatcher uses this to fan stderr into `run.mcp.log` events
   * scrubbed by the run-redactor; any other caller (e.g. the smoke
   * script's `--trace-mcp-logs`) gets a raw feed of already
   * ANSI-stripped, line-split text. Lines that arrive before any
   * subscriber registers are dropped — see
   * `MountedExternalMcps.subscribeLogs` for the rationale.
   */
  subscribeMcpLogs(handler: McpLogHandler): () => void
  /**
   * Tear down any out-of-process resources (currently: the gitnexus MCP
   * subprocess). Idempotent and safe to call even when nothing was
   * mounted. Does NOT close the shared `pg.Pool` — that lifetime is
   * owned by the `AgentBridgeDb` handle the caller provided.
   */
  disconnect(): Promise<void>
}

export interface BuiltAgentMeta {
  readonly agentId: string
  readonly agentName: string
  readonly slug: string
  readonly provider: {
    readonly id: string
    readonly kind: LlmProviderKind
    readonly label: string
    readonly modelId: string
  }
  readonly skillCount: number
  readonly memoryEnabled: boolean
  /**
   * Memory mount status (Phase 6a). `enabled: false` means the agent's
   * `memory_enabled` column is off — Mastra is not constructed and
   * thread/recall don't apply. When `enabled: true`, `vectorReady`
   * tells the UI whether semantic recall is actually wired up:
   *   - `vectorReady: true` → `PgVector` + embedder mounted; semantic
   *     recall calls return real results.
   *   - `vectorReady: false` → working-memory + recent-history work,
   *     but `semanticRecall` (if set in `memory_config`) will fail at
   *     runtime. Caused by the agent's provider lacking a
   *     `default_embedding_model`. UI should flag this as a config gap.
   * `embedderProvider` / `embedderModel` are NULL when no embedder was
   * configured.
   */
  readonly memory: MemoryMountMeta
  /**
   * GitNexus MCP mount status. `mounted: false` with `repoCount: 0`
   * means the agent has no indexed repos (LLM-only agent). `mounted:
   * false` with `repoCount > 0` means the caller passed
   * `disableGitnexus: true` — useful for smoke tests.
   */
  readonly gitnexus: GitnexusMountMeta
  /**
   * External MCP mount status. `mounted: false` with `connectionCount
   * === 0` means the agent has no allowlisted tools; `mounted: true`
   * exposes the per-connection selectedTools / missingTools breakdown
   * so the UI can flag stale allowlist rows.
   */
  readonly externalMcps: ExternalMcpsMountMeta
}

export interface MemoryMountMeta {
  /** Mirrors `agents.memory_enabled`. */
  readonly enabled: boolean
  /**
   * `true` iff `enabled` AND the agent's provider supplied an embedding
   * model id. When `false` with `enabled: true`, semantic recall is
   * unavailable but other memory features (thread history, working
   * memory) still work — the agent just won't pull semantically-similar
   * messages. Use this to render a "memory: thread only" hint in the UI.
   */
  readonly vectorReady: boolean
  /** Provider kind of the embedder. NULL when `vectorReady` is false. */
  readonly embedderProvider: LlmProviderKind | null
  /** Embedder model id (e.g. `text-embedding-3-small`). NULL when off. */
  readonly embedderModel: string | null
}

// ─── Config constants ────────────────────────────────────────────────────

/**
 * All Mastra-managed tables land inside this PG schema. Keep it OUT of the
 * default `public` schema so:
 *   (a) our Drizzle migrations and Mastra's auto-init never share tables;
 *   (b) `DROP SCHEMA mastra CASCADE` is a safe nuke-and-replay for Mastra
 *       state without touching anything we own;
 *   (c) `\d public.*` in psql stays clean for humans debugging our tables.
 */
const MASTRA_SCHEMA_NAME = 'mastra'

/**
 * Logical ID stamped onto the Mastra storage instance. Mastra uses this to
 * distinguish multiple stores inside a single process; we only ever run
 * one so any stable string works. Exposed as a constant to keep logs
 * greppable ("storage=agent-bridge-main").
 */
const MASTRA_STORE_ID = 'agent-bridge-main'

/**
 * Fallback base URLs for provider kinds that have a well-known vendor
 * endpoint. Only vendors get a default; local endpoints (`llama_cpp`,
 * `ollama`, `openai_compatible`) MUST have a base URL stored on the
 * provider row — if they don't, surfacing a loud error here is friendlier
 * than letting an HTTP call fail with ENOTFOUND at request time.
 *
 * Mirrors `apps/backend/src/lib/llm-providers/test-provider.ts`
 * (`VENDOR_BASE_URLS`). Drift between the two is a bug — keep them in sync.
 */
const VENDOR_DEFAULT_BASE_URL: Partial<Record<LlmProviderKind, string>> = {
  openai: 'https://api.openai.com',
}

// ─── Public function ─────────────────────────────────────────────────────

export async function buildAgent(input: BuildAgentInput): Promise<BuiltAgent> {
  const {
    db,
    agentId,
    disableGitnexus = false,
    disableExternalMcps = false,
  } = input

  const [agentRow] = await db.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)

  if (!agentRow) {
    throw new Error(`[buildAgent] Agent ${agentId} not found`)
  }

  if (!agentRow.llmProviderId) {
    throw new Error(
      `[buildAgent] Agent ${agentId} has no llm_provider configured — attach one before invoking.`,
    )
  }

  const [providerRow] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.id, agentRow.llmProviderId))
    .limit(1)

  if (!providerRow) {
    throw new Error(
      `[buildAgent] Agent ${agentId} references missing llm_provider ${agentRow.llmProviderId}`,
    )
  }

  // Skills ordered by position first (explicit author intent), then by
  // creation order as a stable tiebreaker for rows sharing the same
  // position integer (e.g. two skills created at `position: 0` back-to-back).
  const skillRows = await db.db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.agentId, agentId))
    .orderBy(asc(schema.skills.position), asc(schema.skills.createdAt))

  const instructions = composeInstructions(agentRow.systemPrompt, skillRows)

  // Agent model overrides provider default. If neither is set we fail
  // loud: picking a model on behalf of the user would mask missing config.
  const modelId = agentRow.model ?? providerRow.defaultModel
  if (!modelId) {
    throw new Error(
      `[buildAgent] Agent ${agentId}: no model configured and provider "${providerRow.label}" has no default_model`,
    )
  }

  const baseUrl = resolveBaseUrl(providerRow.kind, providerRow.baseUrl)

  // apiKeyEnvelope is nullable: local endpoints (llama.cpp / ollama) run
  // without auth. Decrypting always produces a utf-8 string; tamper/wrong-key
  // throws synchronously inside decryptSecret, which is what we want —
  // silently passing a mangled key to OpenAI would surface as a confusing
  // 401 downstream.
  const apiKey = providerRow.apiKeyEnvelope
    ? decryptSecret(providerRow.apiKeyEnvelope)
    : undefined

  const modelConfig: MastraModelConfig = {
    providerId: providerRow.kind,
    modelId,
    url: baseUrl,
    // Spread the key only when present so Mastra's normalization path
    // doesn't trip on an empty string for no-auth local endpoints.
    ...(apiKey ? { apiKey } : {}),
  }

  const memoryMount = agentRow.memoryEnabled
    ? buildMemory({
        db,
        provider: providerRow,
        baseUrl,
        apiKey,
        config: agentRow.memoryConfig,
      })
    : null
  const memory = memoryMount?.memory
  const memoryMeta: MemoryMountMeta = memoryMount
    ? memoryMount.meta
    : { enabled: false, vectorReady: false, embedderProvider: null, embedderModel: null }

  // Mount MCP sources BEFORE constructing the Agent: Mastra's Agent
  // locks its tool set at construction time, so the merged dict has to
  // exist up front. Either mount may decide to skip (no repos / empty
  // allowlist); either may throw on misconfiguration, which we surface
  // to the caller as-is. If the second mount throws we tear down the
  // first so no subprocess leaks — `buildExternalFailsafeCleanup`
  // captures that invariant.
  const mountedGitnexus = await mountGitnexusMcp({
    db,
    agentId,
    disabled: disableGitnexus,
  })

  let mountedExternal: MountedExternalMcps | null
  try {
    mountedExternal = await mountExternalMcps({
      db,
      agentId,
      disabled: disableExternalMcps,
    })
  } catch (err) {
    if (mountedGitnexus) {
      try {
        await mountedGitnexus.client.disconnect()
      } catch {
        // Swallow — the original external-mcps error is what the caller
        // cares about; a cascade disconnect failure would just obscure it.
      }
    }
    throw err
  }

  const instructionsWithRepos = mountedGitnexus
    ? appendGitnexusRepoHint(instructions, mountedGitnexus)
    : instructions

  const mergedTools = mergeToolDicts(mountedGitnexus, mountedExternal)

  const agent = new Agent({
    id: agentRow.id,
    name: agentRow.name,
    description: agentRow.description ?? undefined,
    instructions: instructionsWithRepos,
    model: modelConfig,
    ...(memory ? { memory } : {}),
    ...(mergedTools ? { tools: mergedTools } : {}),
  })

  const gitnexusMeta = mountedGitnexus
    ? mountedGitnexus.meta
    : emptyGitnexusMountMeta(
        // `emptyGitnexusMountMeta` still reports the repo count so the
        // UI can say "1 repo attached, MCP off" when the caller used
        // `disableGitnexus`. Reuse the helper's query rather than
        // re-running the join here.
        await countReadyRepos(db, agentId),
      )

  const externalMcpsMeta = mountedExternal
    ? mountedExternal.meta
    : emptyExternalMcpsMountMeta()

  const disconnect = buildDisconnect(mountedGitnexus, mountedExternal)

  // Provider apiKey + every decrypted MCP env/header value feed the
  // Phase 3f run-redactor. `mountExternalMcps` already applied the
  // ≥4-char gate, so we can concat verbatim. `redactMany` additionally
  // no-ops on short strings; the gate here just keeps the returned
  // list meaningful for log lines like "N secrets bound".
  const secrets: string[] = []
  if (apiKey && apiKey.length >= 4) secrets.push(apiKey)
  if (mountedExternal) secrets.push(...mountedExternal.secrets)

  const subscribeMcpLogs: BuiltAgent['subscribeMcpLogs'] = mountedExternal
    ? (handler) => mountedExternal.subscribeLogs(handler)
    : () => () => {}

  return {
    agent,
    meta: {
      agentId: agentRow.id,
      agentName: agentRow.name,
      slug: agentRow.slug,
      provider: {
        id: providerRow.id,
        kind: providerRow.kind,
        label: providerRow.label,
        modelId,
      },
      skillCount: skillRows.length,
      memoryEnabled: agentRow.memoryEnabled,
      memory: memoryMeta,
      gitnexus: gitnexusMeta,
      externalMcps: externalMcpsMeta,
    },
    secrets,
    subscribeMcpLogs,
    disconnect,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Assemble the final `instructions` string passed to Mastra. Agent-level
 * `system_prompt` is the anchor; each skill contributes a markdown section
 * underneath it. Empty bodies are dropped so a placeholder skill doesn't
 * emit a trailing heading with nothing under it.
 */
function composeInstructions(
  basePrompt: string,
  skills: readonly SkillRow[],
): string {
  const parts: string[] = []

  const trimmedBase = basePrompt.trim()
  if (trimmedBase.length > 0) {
    parts.push(trimmedBase)
  }

  for (const skill of skills) {
    const body = skill.markdownBody.trim()
    if (body.length === 0) continue
    parts.push(`## ${skill.name}\n\n${body}`)
  }

  // Empty total is allowed — some LLMs accept an empty system message
  // and Mastra's own defaults will still drive behavior via other knobs.
  return parts.join('\n\n')
}

/**
 * Normalize the provider's stored base URL into the `/v1`-rooted URL that
 * `@ai-sdk/openai-compatible` expects (it concatenates `${baseURL}/chat/completions`).
 *
 * Rules:
 *   - Local kinds (llama_cpp, ollama, openai_compatible) MUST have a stored
 *     URL — `llm_providers` DTO validation enforces this at the edge, but
 *     we belt-and-brace here.
 *   - Vendor kinds (just `openai` today) get a default if no override is set.
 *   - Trailing slashes are collapsed.
 *   - `/v1` is appended only if not already present, so operators can store
 *     either form (`http://localhost:11434` or `http://localhost:11434/v1`)
 *     without us doubling up.
 */
function resolveBaseUrl(
  kind: LlmProviderKind,
  storedBaseUrl: string | null,
): string {
  const raw = storedBaseUrl ?? VENDOR_DEFAULT_BASE_URL[kind] ?? null
  if (!raw) {
    throw new Error(
      `[buildAgent] Provider kind "${kind}" requires a base URL and none was stored.`,
    )
  }
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

interface BuiltMemory {
  readonly memory: Memory
  readonly meta: MemoryMountMeta
}

/**
 * Construct the Mastra `Memory` module bound to the shared pg pool. We
 * pass our typed `AgentMemoryConfig` blob straight through — its shape is
 * aligned with Mastra's `MemoryConfigInternal` by construction (see
 * `@agent-bridge/shared` → `AgentMemoryConfig` docstring), but the concrete
 * types live in different packages so we cast to the constructor-argument
 * type at the boundary. If Mastra's shape ever drifts, that cast is the
 * single failure point — TypeScript will flag everything around it.
 *
 * Phase 6a — semantic recall:
 *   - When the agent's provider has `default_embedding_model` set, we
 *     mount a process-level `PgVector` singleton + a
 *     `ModelRouterEmbeddingModel` that reuses the SAME `baseUrl` +
 *     `apiKey` already decrypted for the language model. This means
 *     enabling semantic recall does not require a second provider key
 *     on file — the local-first stance from Phase 6's design notes.
 *   - When the provider lacks an embedding model, working memory +
 *     thread history still work; only `semanticRecall` from the agent's
 *     `memory_config` is unavailable. Mastra surfaces this at the first
 *     vector-write attempt as a clear error; we don't try to fall back
 *     to a different embedder silently — that would mix vector spaces
 *     across runs and corrupt recall quality (Phase 6 design decision
 *     "openai_compatible caveat is the operator's problem").
 */
function buildMemory(args: {
  db: AgentBridgeDb
  provider: LlmProviderRow
  baseUrl: string
  apiKey: string | undefined
  config: AgentMemoryConfig | null
}): BuiltMemory {
  const { db, provider, baseUrl, apiKey, config } = args

  const storage = new PostgresStore({
    id: MASTRA_STORE_ID,
    pool: db.pool,
    schemaName: MASTRA_SCHEMA_NAME,
  })

  type MemoryArg = ConstructorParameters<typeof Memory>[0]
  type MemoryOptions = NonNullable<MemoryArg>['options']

  const embedderModelId = provider.defaultEmbeddingModel?.trim() || null
  const vectorArm = embedderModelId
    ? buildVectorArm({
        db,
        provider,
        baseUrl,
        apiKey,
        embedderModelId,
      })
    : null

  const memory = new Memory({
    storage,
    ...(vectorArm ? { vector: vectorArm.vector, embedder: vectorArm.embedder } : {}),
    ...(config ? { options: config as unknown as MemoryOptions } : {}),
  })

  return {
    memory,
    meta: {
      enabled: true,
      vectorReady: vectorArm !== null,
      embedderProvider: vectorArm ? provider.kind : null,
      embedderModel: vectorArm ? embedderModelId : null,
    },
  }
}

interface VectorArm {
  readonly vector: PgVector
  readonly embedder: ModelRouterEmbeddingModel
}

function buildVectorArm(args: {
  db: AgentBridgeDb
  provider: LlmProviderRow
  baseUrl: string
  apiKey: string | undefined
  embedderModelId: string
}): VectorArm {
  const { db, provider, baseUrl, apiKey, embedderModelId } = args

  // Process-level singleton — Mastra's PgVector is namespaced internally
  // by the Memory instance's resource/thread ids, so cross-agent leakage
  // is not possible from sharing it. Saves one connection pool + one
  // constructor per `buildAgent` call (Phase 6 design decision).
  const vector = getProcessPgVector(db.connectionString)

  // Reuse the language-model's `baseUrl` + `apiKey`. Every supported
  // provider speaks the OpenAI `/embeddings` HTTP shape (this is the
  // definition of `llmProviderKinds`), so the embedder routes through
  // the same provider configuration the LLM uses.
  const embedder = new ModelRouterEmbeddingModel({
    providerId: provider.kind,
    modelId: embedderModelId,
    url: baseUrl,
    ...(apiKey ? { apiKey } : {}),
  })

  return { vector, embedder }
}

const PG_VECTOR_ID = 'agent-bridge-vector'
let processPgVector: PgVector | null = null

function getProcessPgVector(connectionString: string): PgVector {
  if (processPgVector) return processPgVector
  processPgVector = new PgVector({
    id: PG_VECTOR_ID,
    connectionString,
    schemaName: MASTRA_SCHEMA_NAME,
  })
  return processPgVector
}

/**
 * Cheap count of the agent's `status='ready'` repos. Only used when we
 * skip the MCP mount (caller passed `disableGitnexus: true`, or there
 * were zero ready repos to begin with) and still want to populate
 * `BuiltAgentMeta.gitnexus.repoCount` for the UI.
 */
async function countReadyRepos(
  db: AgentBridgeDb,
  agentId: string,
): Promise<number> {
  const rows = await db.db
    .select({ repoId: schema.agentRepos.repoId })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(
      and(
        eq(schema.agentRepos.agentId, agentId),
        eq(schema.repos.status, 'ready'),
      ),
    )
  return rows.length
}

/**
 * Append a short "repos at your disposal" hint to the instructions so the
 * LLM knows which `repo` values to pass when calling gitnexus tools. Kept
 * deliberately compact — the model already has `list_repos` if it wants
 * authoritative discovery, this is just an opening cue.
 */
function appendGitnexusRepoHint(
  instructions: string,
  mounted: MountedGitnexus,
): string {
  if (mounted.meta.repoLabels.length === 0) return instructions

  const lines = mounted.meta.repoLabels
    .map((r) => `- ${r.label}  (${r.remoteUrl}#${r.branch})`)
    .join('\n')

  const block = [
    '## Available indexed repositories (via gitnexus_* tools)',
    '',
    'These repos are indexed and queryable. When calling any `gitnexus_*`',
    'tool, pass the repo label as the `repo` argument. Use `gitnexus_list_repos`',
    'to confirm at runtime if you are unsure.',
    '',
    lines,
  ].join('\n')

  return instructions.length > 0 ? `${instructions}\n\n${block}` : block
}

/**
 * Build a `disconnect` closure that tears down any mounted MCP client —
 * both the gitnexus mount and any external-MCP clients. Hardened so it
 * can be called repeatedly (Mastra's MCPClient already deduplicates
 * in-flight disconnects, but we don't want a caller's defensive
 * double-call to surface as an error either).
 *
 * `Promise.allSettled` so one failing subprocess teardown doesn't leave
 * the others running. The external-mcps mount already uses
 * allSettled-safe disconnects internally; chain them here the same way.
 */
function buildDisconnect(
  gitnexus: MountedGitnexus | null,
  external: MountedExternalMcps | null,
): () => Promise<void> {
  if (!gitnexus && !external) return async () => {}

  let done = false
  return async () => {
    if (done) return
    done = true
    const tasks: Array<Promise<void>> = []
    if (gitnexus) {
      tasks.push(
        gitnexus.client.disconnect().catch(() => {
          // Swallow — same rationale as the external-mcps mount.
        }),
      )
    }
    if (external) {
      tasks.push(external.disconnect())
    }
    await Promise.allSettled(tasks)
  }
}

/**
 * Merge tool dicts from the two MCP sources. Returns `undefined` when
 * neither source produced any tools so the caller can omit the `tools`
 * key entirely on the Mastra Agent (a `{}` tools dict is semantically
 * different from "no tools" on some Mastra minor versions).
 *
 * Collisions between the two namespaces should be impossible by
 * construction — gitnexus keeps its upstream names (`gitnexus_*`) and
 * external connections use the `<slug>__<rawName>` scheme — but a loud
 * throw is still the right move if one ever occurs.
 */
function mergeToolDicts(
  gitnexus: MountedGitnexus | null,
  external: MountedExternalMcps | null,
): Record<string, Tool<any, any, any, any>> | undefined {
  if (!gitnexus && !external) return undefined
  const merged: Record<string, Tool<any, any, any, any>> = {}
  if (gitnexus) {
    for (const [key, tool] of Object.entries(gitnexus.tools)) {
      merged[key] = tool
    }
  }
  if (external) {
    for (const [key, tool] of Object.entries(external.tools)) {
      if (key in merged) {
        throw new Error(
          `[buildAgent] tool key collision on "${key}" between gitnexus ` +
            `and external MCP sources — this is unreachable in normal ` +
            `operation; check that no external connection's slug overlaps ` +
            `with the gitnexus prefix.`,
        )
      }
      merged[key] = tool
    }
  }
  return merged
}
