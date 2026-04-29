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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import {
  createDb,
  runsRepo,
  schema,
  type AgentBridgeDb,
} from '@agent-bridge/db'
import { builtAgentCache, dispatchRun } from '@agent-bridge/agents'
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
  BRIDGE_TOOL_RESERVED_PREFIX,
  bridgeStreamId,
} from '@agent-bridge/shared'

import { env } from './env.js'

interface AgentRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly llmProviderId: string | null
}

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
 * Register one MCP tool per agent. The tool name is
 * `${BRIDGE_TOOL_RESERVED_PREFIX}<slug>` so it's stable across
 * sessions and namespaced away from any user-authored bridge tools
 * Phase 7 will add. Description falls back to a generic phrasing
 * when `agents.description` is null.
 */
function registerAgentTools(
  server: McpServer,
  agents: readonly AgentRecord[],
  ctx: BridgeContext,
): void {
  for (const agent of agents) {
    const toolName = `${BRIDGE_TOOL_RESERVED_PREFIX}${agent.slug}`
    const description =
      agent.description?.trim() ||
      `Query the "${agent.name}" agent. The agent has access to its configured tools and repos; ask in natural language.`

    server.registerTool(
      toolName,
      {
        description,
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(8_000)
            .describe('The question or instruction to send to the agent.'),
        },
      },
      async ({ query }) => {
        return executeAgentQuery(ctx, agent, query)
      },
    )
  }
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
 */
async function executeAgentQuery(
  ctx: BridgeContext,
  agent: AgentRecord,
  query: string,
) {
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

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: query,
    streamId,
  })

  try {
    await dispatchRun({
      db: ctx.db,
      eventBus: ctx.eventBus,
      agentId: agent.id,
      runId,
      streamId,
      prompt: query,
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
  console.error(
    `[mcp-bridge] exposing ${agents.length} agent(s): ${
      agents.map((a) => a.slug).join(', ') || '<none>'
    }`,
  )

  const server = new McpServer(
    { name: 'agent-bridge', version: '1.0.0' },
    {
      // Capabilities are derived from registered tools by the SDK; we
      // declare an empty capabilities object so the handshake doesn't
      // advertise prompts/resources we never set.
      capabilities: { tools: {} },
    },
  )

  registerAgentTools(server, agents, { db, eventBus })

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
