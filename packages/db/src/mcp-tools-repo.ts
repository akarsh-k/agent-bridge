/**
 * `mcp_connection_tools` catalog repo.
 *
 * The catalog is the set of tools a connection advertised the last time it
 * was discovered/tested (name + description + raw JSON input-schema). It lets
 * `buildAgent` construct an agent's external-MCP tools from STORED schemas
 * with no live connection (lazy mount); the MCP server is only contacted when
 * the LLM actually invokes a tool.
 *
 * Functions take the Drizzle handle directly (`AgentBridgeDb['db']`) rather
 * than the `AgentBridgeDb` wrapper, because the discover path that writes the
 * catalog already holds the bare handle (`McpTestContext.db`).
 */

import { eq } from 'drizzle-orm'

import type { AgentBridgeDb } from './client.js'
import { mcpConnections, mcpConnectionTools } from './schema.js'

type Db = AgentBridgeDb['db']

/** One catalog entry — the persisted shape of a `DiscoveredMcpTool`. */
export interface ConnectionToolSchema {
  readonly name: string
  readonly description: string | null
  readonly inputSchema: Record<string, unknown>
}

/**
 * Replace a connection's tool catalog and bump the connection's `updated_at`,
 * atomically. The bump matters: `built-agent-cache` hashes
 * `MAX(mcp_connections.updated_at)` over an agent's connected MCPs, so
 * touching it invalidates every dependent agent's cached build — which is
 * exactly what we want after a (re)discovery that may carry new schemas or
 * fresh OAuth tokens. Called from the discover/test success path.
 */
export async function replaceConnectionToolCatalog(
  db: Db,
  connectionId: string,
  tools: readonly ConnectionToolSchema[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(mcpConnectionTools)
      .where(eq(mcpConnectionTools.mcpConnectionId, connectionId))

    if (tools.length > 0) {
      await tx.insert(mcpConnectionTools).values(
        tools.map((t) => ({
          mcpConnectionId: connectionId,
          toolName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      )
    }

    await tx
      .update(mcpConnections)
      .set({ updatedAt: new Date() })
      .where(eq(mcpConnections.id, connectionId))
  })
}

/**
 * Load a connection's stored tool catalog. Used by the lazy external-MCP
 * mount to build proxy tools without opening the connection.
 */
export async function loadConnectionToolCatalog(
  db: Db,
  connectionId: string,
): Promise<ConnectionToolSchema[]> {
  const rows = await db
    .select({
      name: mcpConnectionTools.toolName,
      description: mcpConnectionTools.description,
      inputSchema: mcpConnectionTools.inputSchema,
    })
    .from(mcpConnectionTools)
    .where(eq(mcpConnectionTools.mcpConnectionId, connectionId))

  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    inputSchema: r.inputSchema,
  }))
}
