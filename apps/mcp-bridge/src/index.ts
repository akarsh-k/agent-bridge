/**
 * IDE-facing MCP bridge (`docs/ARCHITECTURE.md §10`).
 *
 * Spawned by the IDE (Cursor / Claude Code) over stdio. Each
 * inspector agent exposes ONE MCP tool named
 * `<slug>__inspect_codebase`. Operator-authored `bridge_tools` rows
 * register alongside with their authored names.
 *
 * Tool execution per call:
 *   1. Mint `runId = randomUUID()`, `streamId = bridgeStreamId(runId)`.
 *   2. `runsRepo.createRun(...)` and dispatch the user query through
 *      the standard run pipeline. The agent's wrappers do the actual
 *      code-search work; their mini-repos accumulate on
 *      `runs.minirepo_json` (G3).
 *   3. After dispatch settles, read `minirepo_json` + `output_summary`
 *      and wrap into the D17′ envelope. Return as MCP text content.
 *
 * Source tagging via the `bridge:` streamId prefix (vs `run:` for
 * UI chat) is unchanged.
 */

import { randomUUID } from 'node:crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { and, asc, eq } from 'drizzle-orm'

import {
  createDb,
  runMigrations,
  schema,
  type AgentBridgeDb,
} from '@agent-bridge/db'
import { builtAgentCache } from '@agent-bridge/agents'
import { INSPECT_CODEBASE_METADATA } from '@agent-bridge/shared'
import { loadOrCreateMasterKey } from '@agent-bridge/shared/crypto'
import { ensureDataDirs } from '@agent-bridge/shared/paths'
import { createEventBus, type EventBus } from '@agent-bridge/shared/event-bus'

import { env } from './env.js'
import {
  executeInspectCodebase,
  executePhase7Tool,
  type AgentRecord,
  type BridgeContext,
  type IdeClientInfo,
  type ToolEntry,
} from './inspect-codebase-handler.js'

/**
 * One Mastra thread per bridge subprocess lifetime. Same rationale
 * as the v1 bridge: multi-turn IDE chats keep continuity across
 * `tools/call` invocations within one IDE session. Restarting the
 * IDE / reloading the MCP server respawns the bridge → fresh thread.
 */
const BRIDGE_THREAD_ID = randomUUID()

/**
 * Empty JSON Schema for tools whose input is fully optional. MCP
 * clients accept `{ type: 'object' }` as "no required args".
 */
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

/**
 * `inspect_codebase` JSON Schema — shipped on Inspector-enabled agents.
 * The IDE LLM passes free-form `query` plus optional repo hints; the
 * agent's wrappers each accept their own `repo_hint`, but pre-binding
 * it on the bridge call lets the agent pick the right repo on the
 * first try without a `list_repos` round-trip.
 */
const INSPECT_CODEBASE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description:
        'Free-form question or instruction about the codebase. The agent picks the right wrapper internally: find code, trace flow, assess change impact, debug an error, or explain a module.',
    },
    repo_hint: {
      type: 'string',
      description:
        'Friendly label of an attached repo (role, alias, or URL tail). Omit when the agent has only one repo, or when you want to search across every attached repo.',
    },
    remote_url: {
      type: 'string',
      description:
        'Highest-signal repo identifier. If you can read it (`git remote get-url origin`), pass it.',
    },
    local_folder: {
      type: 'string',
      description: 'IDE workspace folder name as a fallback signal.',
    },
    branch: {
      type: 'string',
      description: 'Current branch. Only used as a tiebreaker.',
    },
    with_topology: {
      type: 'boolean',
      description:
        'When true, the response carries the full repo topology (`agent_repos`, `repo_edges`). Default false: the response is scoped to the resolved repo and exposes `next_actions` instead, which carry pre-baked follow-ups for connected repos. Set true when you need the broad view in one shot.',
    },
  },
}


interface AgentRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly llmProviderId: string | null
  readonly inspectorEnabled: boolean
}

async function listExposableAgents(db: AgentBridgeDb): Promise<AgentRow[]> {
  const rows = await db.db
    .select({
      id: schema.agents.id,
      slug: schema.agents.slug,
      name: schema.agents.name,
      description: schema.agents.description,
      llmProviderId: schema.agents.llmProviderId,
      inspectorEnabled: schema.agents.inspectorEnabled,
    })
    .from(schema.agents)
    .orderBy(asc(schema.agents.slug))
  return rows.filter((r) => r.llmProviderId !== null)
}

/**
 * Build the bridge's tool registry. Per agent:
 *   - `<slug>__inspect_codebase` (system tool, mini-repo envelope) is
 *     registered automatically when `agents.inspector_enabled = true`
 *     (Repo-inspector template). Description: operator's
 *     `agents.description` + a system note about the structured envelope.
 *   - Zero or more operator-authored `bridge_tools` rows are registered
 *     verbatim for both kinds. Operator picks the name,
 *     description, schema, and prompt template.
 *
 * Build-your-own (blank) agents have NO built-in tool — when an agent
 * is created with `inspector_enabled = false` the backend auto-INSERTs
 * a `bridge_tools` row named `<slug_safe>__ask_agent` so the IDE has
 * a tool to call. The operator edits / renames / deletes that row
 * from the Bridge-tools tab like any other custom tool. This keeps
 * the bridge's runtime simple (one path per tool kind) and the
 * operator UX consistent (one editor for every tool).
 *
 * Mode reporting (per agent): `inspect` / `(none)`, optionally
 * suffixed with `+ explicit:N` when operator-authored rows exist.
 */
async function buildToolRegistry(
  db: AgentBridgeDb,
  agents: readonly AgentRow[],
): Promise<{
  registry: Map<string, ToolEntry & { mcpName: string; description: string; inputSchema: Record<string, unknown> }>
  modeByAgentSlug: Map<string, string>
}> {
  type RegistryEntry = ToolEntry & {
    mcpName: string
    description: string
    inputSchema: Record<string, unknown>
  }
  const registry = new Map<string, RegistryEntry>()
  const modeByAgentSlug = new Map<string, string>()

  for (const agentRow of agents) {
    const agent: AgentRecord = agentRow

    // 1) System built-in — only inspect_codebase, only when inspector
    //    is enabled. Blank agents have NO built-in; their ask_agent
    //    tool lives in `bridge_tools` (auto-created on agent insert).
    let baseMode: 'inspect' | 'none' = 'none'
    if (agentRow.inspectorEnabled) {
      const inspectName = `${agent.slug}__inspect_codebase`
      registry.set(inspectName, {
        kind: 'inspect',
        agent,
        mcpName: inspectName,
        description: buildInspectDescription(agent),
        inputSchema: INSPECT_CODEBASE_INPUT_SCHEMA,
      })
      baseMode = 'inspect'
    }

    // 2) Explicit operator-authored rows — both kinds.
    //    For blank agents, this is where their auto-created
    //    `<slug>__ask_agent` row lands.
    const explicit = await db.db
      .select({
        id: schema.bridgeTools.id,
        name: schema.bridgeTools.name,
        description: schema.bridgeTools.description,
        inputSchema: schema.bridgeTools.inputSchema,
        promptTemplate: schema.bridgeTools.promptTemplate,
      })
      .from(schema.bridgeTools)
      .where(
        and(
          eq(schema.bridgeTools.agentId, agent.id),
          eq(schema.bridgeTools.enabled, true),
        ),
      )
      .orderBy(asc(schema.bridgeTools.name))

    for (const r of explicit) {
      const inputSchema =
        r.inputSchema && Object.keys(r.inputSchema).length > 0
          ? (r.inputSchema as Record<string, unknown>)
          : EMPTY_OBJECT_SCHEMA
      registry.set(r.name, {
        kind: 'phase7',
        agent,
        bridgeTool: {
          id: r.id,
          name: r.name,
          description: r.description,
          inputSchema,
          promptTemplate: r.promptTemplate,
        },
        mcpName: r.name,
        description: r.description.trim() || `Bridge tool for "${agent.name}".`,
        inputSchema,
      })
    }

    const explicitCount = explicit.length
    modeByAgentSlug.set(
      agent.slug,
      explicitCount === 0
        ? baseMode
        : `${baseMode} + explicit:${explicitCount}`,
    )
  }

  return { registry, modeByAgentSlug }
}

function buildInspectDescription(agent: AgentRecord): string {
  // Single source of truth: the system contract text lives on
  // `INSPECT_CODEBASE_METADATA.description` in shared. Operator's
  // `agents.description` is prepended when present so the IDE LLM
  // sees both the operator's framing and the framework contract.
  const head = agent.description?.trim()
  const base = INSPECT_CODEBASE_METADATA.description
  return head ? `${head}\n\n${base}` : base
}


// ─── Boot ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Stdout is reserved for MCP wire format. EVERY log goes to stderr.
  console.error(`[mcp-bridge] starting (NODE_ENV=${env.NODE_ENV})`)

  ensureDataDirs()
  loadOrCreateMasterKey()

  const db = createDb({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_SIZE,
    debug: env.DATABASE_DEBUG && !env.isProd,
  })

  // Apply pending schema migrations before reading any tables. The
  // IDE spawns this process independently of the main app; if the
  // user updates Agent Bridge (`git pull` brings new migrations) and
  // reloads the MCP server in their IDE BEFORE restarting
  // `pnpm start`, we'd otherwise be reading from a stale schema.
  // Belt-and-braces alongside backend/worker's own migrate-on-boot —
  // Drizzle's `migrate()` serialises through `__drizzle_migrations`,
  // so a concurrent call (bridge + backend booting together) is a
  // documented no-op for the loser. Dev keeps migrations manual
  // (`pnpm db:migrate`) so contributors control timing.
  if (env.isProd) {
    try {
      const result = await runMigrations(db)
      console.error(
        `[mcp-bridge] migrations applied in ${result.durationMs}ms from ${result.migrationsFolder}`,
      )
    } catch (err) {
      console.error('[mcp-bridge] migration failed; refusing to start:', err)
      process.exit(1)
    }
  }

  const eventBus = createEventBus({ redisUrl: env.REDIS_URL })

  const agents = await listExposableAgents(db)
  const { registry, modeByAgentSlug } = await buildToolRegistry(db, agents)

  console.error(
    `[mcp-bridge] exposing ${registry.size} tool(s) across ${agents.length} agent(s):`,
  )
  for (const agent of agents) {
    const mode = modeByAgentSlug.get(agent.slug) ?? '<no mode>'
    console.error(`[mcp-bridge]   • ${agent.slug} → ${mode}`)
  }

  // Lower-level Server API (not McpServer) so we can ship arbitrary
  // JSON Schema verbatim on `tools/list` — operator-authored
  // input schemas pass through unchanged.
  const server = new Server(
    { name: 'agent-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // The MCP SDK exposes the negotiated `clientInfo` from the
  // `initialize` handshake via `server.getClientVersion()` once the
  // handshake completes. We read it lazily on every tool call so
  // late-binding works even if the IDE re-initializes the session.
  // Returns `null` for the brief window before initialize lands (no
  // tool call is allowed before handshake completes anyway, so this
  // path is mostly defensive).
  const ctx: BridgeContext = {
    db,
    eventBus,
    threadId: BRIDGE_THREAD_ID,
    getClientInfo: (): IdeClientInfo | null => {
      const v = server.getClientVersion()
      if (!v || typeof v.name !== 'string' || v.name.length === 0) return null
      return {
        name: v.name,
        version: typeof v.version === 'string' ? v.version : null,
      }
    },
  }

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return {
      tools: Array.from(registry.values()).map((entry) => ({
        name: entry.mcpName,
        description: entry.description,
        inputSchema: entry.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    const entry = registry.get(name)
    if (!entry) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              `Unknown tool "${name}". The bridge only exposes agents that ` +
              `have an LLM provider attached; recreate the IDE session if ` +
              `you just added one.`,
          },
        ],
      }
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>
    if (entry.kind === 'inspect') {
      return executeInspectCodebase(ctx, entry.agent, args)
    }
    return executePhase7Tool(ctx, entry.agent, entry.bridgeTool, args)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[mcp-bridge] connected, waiting for IDE requests')

  // Drain on stdin EOF (IDE quit) or signal. Connect handlers BEFORE
  // we report ready so a fast SIGINT during boot still cleans up.
  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[mcp-bridge] shutting down: ${reason}`)
    const forceExit = setTimeout(() => {
      console.error('[mcp-bridge] shutdown timeout — forcing exit')
      process.exit(1)
    }, 10_000)
    forceExit.unref()
    try {
      await server.close()
    } catch (err) {
      console.error('[mcp-bridge] server.close() error:', err)
    }
    try {
      await builtAgentCache.dispose()
    } catch (err) {
      console.error('[mcp-bridge] builtAgentCache.dispose() error:', err)
    }
    try {
      await eventBus.close()
    } catch (err) {
      console.error('[mcp-bridge] eventBus.close() error:', err)
    }
    try {
      await db.close()
    } catch (err) {
      console.error('[mcp-bridge] db.close() error:', err)
    }
    process.exit(0)
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void shutdown(sig)
    })
  }
  process.stdin.on('close', () => void shutdown('stdin closed'))
  process.on('uncaughtException', (err) => {
    console.error('[mcp-bridge] uncaughtException:', err)
    void shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[mcp-bridge] unhandledRejection:', reason)
  })
}

main().catch((err) => {
  console.error('[mcp-bridge] fatal boot error:', err)
  process.exit(1)
})
