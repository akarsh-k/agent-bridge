/**
 * IDE-facing MCP bridge — Phase 5.
 *
 * Spawned by the IDE (Cursor / Claude Code) over stdio. Each agent is
 * exposed as one MCP tool named `query_<agent.slug>` with a single
 * `query` string argument; the response is the agent's accumulated
 * text output (read from `runs.output_summary` after dispatch).
 *
 * Boot sequence:
 *   1. Load `.env` (DATABASE_URL, REDIS_URL, master key path).
 *   2. Open Postgres + Redis connections.
 *   3. Query `public.agents` once at startup, register one tool per row.
 *      New agents created mid-session require an IDE restart.
 *   4. Connect a `StdioServerTransport` so the IDE wire stays clean.
 *      Logs go to stderr only — stdout is reserved for the MCP frame
 *      stream and any `console.log` would corrupt it.
 *
 * Tool execution per call:
 *   1. Mint `runId = randomUUID()`, `streamId = bridgeStreamId(runId)`.
 *   2. `runsRepo.createRun({ id, agentId, inputPrompt, streamId })`.
 *   3. `await dispatchRun({ ..., streamId })` — the dispatcher writes
 *      to `run_events`, publishes SSE frames, redacts secrets, and
 *      stamps the final accumulated text on `runs.output_summary`.
 *      Bridge runs and UI runs share the same audit + redaction path;
 *      the only difference is the streamId prefix.
 *   4. `runsRepo.getRun(runId)` → return `output_summary` as MCP text
 *      content. Errors surface as `{ isError: true, content: [...] }`.
 *
 * Source tagging is encoded in the streamId prefix (`bridge:` vs the
 * route's `run:`). The UI's runs tab can filter without a schema
 * column.
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
  runsRepo,
  schema,
  type AgentBridgeDb,
} from '@agent-bridge/db'
import {
  builtAgentCache,
  CODING_AGENT_VIRTUAL_BRIDGE_TOOLS,
  dispatchRun,
  type VirtualBridgeToolDefinition,
} from '@agent-bridge/agents'
import {
  loadOrCreateMasterKey,
} from '@agent-bridge/shared/crypto'
import {
  ensureDataDirs,
} from '@agent-bridge/shared/paths'
import {
  createEventBus,
  type EventBus,
} from '@agent-bridge/shared/event-bus'
import {
  bridgeStreamId,
  type CodingAgentToolName,
} from '@agent-bridge/shared'

import { env } from './env.js'
import { executeCodingAgentTool } from './coding-agent-handler.js'

/**
 * One Mastra thread per bridge subprocess lifetime.
 *
 * Pre-Layer-1, every IDE tool call minted a fresh runId AND used it
 * as the threadId — so the agent treated each call as an independent
 * one-shot with no memory of prior turns in the same IDE session.
 * That works for stateless automations but breaks chat-style usage:
 * a follow-up like "what about the migration?" had no idea what the
 * previous turn was about.
 *
 * Now we mint ONE threadId at process start and reuse it on every
 * tool call. All calls in the same IDE session share a thread, so
 * recent-message replay + per-thread working memory + per-thread
 * semantic recall actually do useful work. Restarting the IDE (or
 * reloading the MCP server) spawns a new bridge process → new
 * threadId → fresh slate.
 *
 * Limitation we accept for v1: multiple IDE chat tabs in the same
 * session bleed into one thread because MCP doesn't surface per-tab
 * context. Workaround: the user restarts the IDE / reloads the MCP
 * server when they want a fresh slate.
 */
const BRIDGE_THREAD_ID = randomUUID()

interface AgentRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly llmProviderId: string | null
}

interface BridgeToolRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly promptTemplate: string
}

/**
 * One entry in the bridge's tool registry. Three kinds:
 *   - `default`: Phase-5 auto-derived `query_<slug>` (no longer
 *     auto-emitted; kept as an edge case if a future flag opts
 *     agents out of the toolkit virtuals. see
 *     `docs/ARCHITECTURE.md` §10.1).
 *   - `phase7`: explicit operator-authored `bridge_tools` row.
 *   - `virtual`: coding-agent toolkit tool, code-defined in
 *     `@agent-bridge/agents/coding-agent/bridge-tool-defs.ts`.
 * The IDE sees them identically. all three are MCP tools with a
 * name, description, and JSON-Schema input. The handler routes by
 * `source.kind`.
 */
interface ToolEntry {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly agent: AgentRecord
  readonly source: ToolEntrySource
}

type ToolEntrySource =
  | { kind: 'default' }
  | { kind: 'phase7'; tool: BridgeToolRecord }
  | { kind: 'virtual'; def: VirtualBridgeToolDefinition }

/**
 * Read every agent that has a configured LLM provider. Agents without
 * a provider are silently skipped — surfacing them in the IDE would
 * just produce 409s on every call.
 */
async function listExposableAgents(db: AgentBridgeDb): Promise<AgentRecord[]> {
  const rows = await db.db
    .select({
      id: schema.agents.id,
      slug: schema.agents.slug,
      name: schema.agents.name,
      description: schema.agents.description,
      llmProviderId: schema.agents.llmProviderId,
    })
    .from(schema.agents)
    .orderBy(asc(schema.agents.slug))

  return rows.filter((r) => r.llmProviderId !== null)
}

/**
 * Build the bridge's tool registry per `tools/list` semantics. Three
 * sources contribute, in this precedence (later sources shadow earlier
 * ones at the same name key):
 *
 *   1. Virtual coding-agent toolkit (always-on for every exposable
 *      agent). Names: `<agent.slug>__<def.name>` so multi-agent
 *      installs don't collide on bare names like `plan_feature`.
 *   2. Operator-authored explicit `bridge_tools` rows. Names are
 *      operator-chosen (DB-globally unique). An explicit row whose
 *      name equals a virtual key shadows the virtual.
 *
 * The Phase-5 `query_<slug>` default is no longer auto-emitted -
 * `<slug>__ask_general` from the virtuals subsumes it (multi-repo
 * aware, grounded outputs, JSON envelope). The DB CHECK constraint
 * banning the `query_` prefix on explicit rows is preserved; the
 * prefix stays reserved in case we re-introduce the default behind
 * a feature flag later.
 *
 * Mode reporting (per agent): `virtual:6`, or
 * `virtual:6 + explicit:N`, or `virtual:6 + explicit:N (shadows: M)`
 * when explicit rows replace virtuals by name.
 */
async function buildToolRegistry(
  db: AgentBridgeDb,
  agents: readonly AgentRecord[],
): Promise<{
  registry: Map<string, ToolEntry>
  modeByAgentSlug: Map<string, string>
}> {
  const registry = new Map<string, ToolEntry>()
  const modeByAgentSlug = new Map<string, string>()

  for (const agent of agents) {
    // 1) Seed virtual tools first. Slug prefix keeps multi-agent
    //    installs collision-free. The bare canonical name lives on
    //    `def.name` (used by the JSON envelope `tool` field in P4).
    const virtualNames = new Set<string>()
    for (const def of CODING_AGENT_VIRTUAL_BRIDGE_TOOLS) {
      const name = virtualToolName(agent.slug, def.name)
      virtualNames.add(name)
      registry.set(name, {
        name,
        description: def.description,
        inputSchema: def.inputSchema,
        agent,
        source: { kind: 'virtual', def },
      })
    }

    // 2) Layer explicit rows. Same-name rows shadow virtuals; new
    //    names add to the surface.
    const rows = await db.db
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

    let shadowCount = 0
    for (const r of rows) {
      const tool: BridgeToolRecord = {
        id: r.id,
        name: r.name,
        description: r.description,
        inputSchema: r.inputSchema as Record<string, unknown>,
        promptTemplate: r.promptTemplate,
      }
      const inputSchema =
        tool.inputSchema && Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : EMPTY_OBJECT_SCHEMA
      if (virtualNames.has(tool.name)) shadowCount += 1
      registry.set(tool.name, {
        name: tool.name,
        description:
          tool.description.trim() || `Bridge tool for "${agent.name}".`,
        inputSchema,
        agent,
        source: { kind: 'phase7', tool },
      })
    }

    const explicit = rows.length
    const virtual = CODING_AGENT_VIRTUAL_BRIDGE_TOOLS.length
    let label = `virtual:${virtual}`
    if (explicit > 0) {
      label += ` + explicit:${explicit}`
      if (shadowCount > 0) label += ` (shadows: ${shadowCount})`
    }
    modeByAgentSlug.set(agent.slug, label)
  }

  return { registry, modeByAgentSlug }
}

/**
 * Slug-prefixed name for a virtual tool. Mirrors the
 * `<connection-slug>__<rawTool>` convention `mountExternalMcps` uses
 * for upstream MCP tools (`packages/agents/src/mcp/external-mcps.ts`)
 *. the IDE's MCP client is already comfortable with double-underscore
 * separators, and the bare `def.name` stays available on the JSON
 * envelope's `tool` field for the IDE to reason about canonically.
 */
function virtualToolName(
  agentSlug: string,
  defName: CodingAgentToolName,
): string {
  return `${agentSlug}__${defName}`
}

/**
 * Empty JSON Schema for tools that haven't authored an input shape yet.
 * MCP clients accept `{ type: 'object' }` to mean "no required args".
 */
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

interface BridgeContext {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
}

/**
 * Single tool-call dispatch. Mirrors the HTTP route's structure but
 * awaits the dispatcher to completion (HTTP fires-and-forgets so the
 * 202 lands while the run is still streaming; the bridge can't
 * stream — it returns one text payload — so awaiting is correct).
 *
 * Phase 7 path: when the entry source is a `bridge_tools` row, the
 * operator's `prompt_template` is rendered against the IDE-supplied
 * args to produce `runs.input_prompt`. Phase 5 (default) path: the
 * raw `query` arg becomes the prompt verbatim.
 */
async function executeToolCall(
  ctx: BridgeContext,
  entry: ToolEntry,
  args: Record<string, unknown>,
) {
  // P4: virtual coding-agent tools have their own handler with its
  // own agent/provider checks, resolver pre-flight, and dispatcher
  // call. Route early so the explicit-row code path below stays
  // focused on the Phase 5/7 contract.
  if (entry.source.kind === 'virtual') {
    return executeCodingAgentTool(
      {
        db: ctx.db,
        eventBus: ctx.eventBus,
        threadId: BRIDGE_THREAD_ID,
      },
      {
        name: entry.name,
        agent: { id: entry.agent.id, slug: entry.agent.slug },
        def: entry.source.def,
      },
      args,
    )
  }

  const { agent } = entry
  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)

  // Re-read the agent: a delete between `tools/list` and `tools/call`
  // would leak through `createRun`'s FK as a 23503; safer to fail
  // here with a focused message.
  const [fresh] = await ctx.db.db
    .select({
      id: schema.agents.id,
      llmProviderId: schema.agents.llmProviderId,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, agent.id))
    .limit(1)

  if (!fresh) {
    return toolErrorResult(
      `Agent "${agent.slug}" was deleted between tool listing and this call.`,
    )
  }
  if (!fresh.llmProviderId) {
    return toolErrorResult(
      `Agent "${agent.slug}" no longer has an LLM provider configured.`,
    )
  }

  // Build the actual `inputPrompt` from the tool kind:
  //   - Phase 5 default: take the `query` arg verbatim.
  //   - Phase 7 explicit: render the operator's `prompt_template`
  //     with the IDE-supplied args.
  let prompt: string
  let bridgeToolName: string | null = null
  if (entry.source.kind === 'phase7') {
    bridgeToolName = entry.name
    prompt = renderPromptTemplate(
      entry.source.tool.promptTemplate,
      args,
    )
  } else {
    const q = args['query']
    if (typeof q !== 'string' || q.trim().length === 0) {
      return toolErrorResult(
        'Missing required arg "query" — pass a question or instruction.',
      )
    }
    prompt = q
  }

  if (prompt.trim().length === 0) {
    return toolErrorResult(
      'Rendered prompt was empty — check that your bridge tool template references args correctly.',
    )
  }

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: prompt,
    streamId,
    bridgeToolName,
  })

  try {
    await dispatchRun({
      db: ctx.db,
      eventBus: ctx.eventBus,
      agentId: agent.id,
      runId,
      streamId,
      prompt,
      // Pin every IDE tool call in this bridge process to one Mastra
      // thread so the agent has continuity across multi-turn IDE
      // chats. See BRIDGE_THREAD_ID's docstring for the design.
      threadId: BRIDGE_THREAD_ID,
    })
  } catch (err) {
    // dispatchRun resolves rather than rejects on a normal run-error
    // (it writes the error into runs.error_message + run_events).
    // A throw here means the audit pipeline itself failed; surface
    // the original message verbatim so the IDE doesn't see a silent
    // empty response.
    return toolErrorResult(
      err instanceof Error ? err.message : 'Bridge dispatch failed',
    )
  }

  const finalRow = await runsRepo.getRun(ctx.db, runId)
  if (!finalRow) {
    return toolErrorResult(
      `Run ${runId} disappeared after dispatch — likely a row was deleted mid-flight.`,
    )
  }

  if (finalRow.status === 'error') {
    // dispatchRun already redacted error_message before persisting,
    // so handing it straight to the IDE is safe.
    return toolErrorResult(finalRow.errorMessage ?? 'Run failed')
  }

  // `runs.output_summary` is capped at 16k chars by the dispatcher
  // — plenty for an MCP tool response. The full text remains
  // recoverable from `run_events` token batches if anyone needs the
  // whole transcript.
  const text = finalRow.outputSummary?.trim() ?? ''
  return {
    content: [
      {
        type: 'text' as const,
        text:
          text.length > 0
            ? text
            : '(agent returned no text — check the run history in the UI)',
      },
    ],
  }
}

/**
 * Minimal `{{ name }}` template renderer for Phase 7 prompt templates.
 * Placeholders match `[a-zA-Z_][a-zA-Z0-9_]*` (same identifier rule as
 * MCP tool names). Unknown placeholders interpolate as the empty
 * string — better than throwing on a partial match, since the operator
 * can still see the rendered prompt in `runs.input_prompt` and fix
 * the template. We deliberately do NOT support escaping or filters;
 * if templates get hairy, switch to a real templating library (this
 * function is the only call site).
 */
function renderPromptTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_match, name: string) => {
      const v = args[name]
      if (v === undefined || v === null) return ''
      if (typeof v === 'string') return v
      try {
        return JSON.stringify(v)
      } catch {
        return String(v)
      }
    },
  )
}

function toolErrorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Stdout is reserved for MCP wire format. EVERY log goes to stderr.
  console.error(`[mcp-bridge] starting (NODE_ENV=${env.NODE_ENV})`)

  // Same boot prep as the worker: ensure data dirs + master key are
  // ready before we open any DB pool, so an env mis-config fails
  // before we hold connections.
  ensureDataDirs()
  loadOrCreateMasterKey()

  const db = createDb({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_SIZE,
    debug: env.DATABASE_DEBUG && !env.isProd,
  })
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

  // Phase 7 uses the lower-level `Server` API instead of `McpServer`
  // because we need to ship arbitrary JSON Schema (operator-authored)
  // verbatim on `tools/list`. `McpServer.registerTool` only accepts Zod
  // shapes; converting JSON Schema → Zod at runtime would require a
  // converter dep AND would round-trip the schema, potentially
  // dropping fields. The lower-level handlers let the schema flow
  // unchanged from DB → MCP wire.
  const server = new Server(
    { name: 'agent-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const ctx: BridgeContext = { db, eventBus }

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return {
      tools: Array.from(registry.values()).map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    const entry = registry.get(name)
    if (!entry) {
      return toolErrorResult(
        `Unknown tool "${name}". The bridge only exposes agents that have an LLM provider attached; recreate the IDE session if you just added one.`,
      )
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>
    return executeToolCall(ctx, entry, args)
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
    // Disconnect any cached BuiltAgents (with their live MCP
    // subprocesses) before tearing down the DB / event bus they
    // depend on. dispose() is idempotent so the backend doing the
    // same thing in its own shutdown is safe — both processes own
    // their own cache instance regardless.
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
