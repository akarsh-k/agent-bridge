/**
 * Drizzle-backed `OAuthStorage` adapter — Phase 4H.
 *
 * Plugs into Mastra's `MCPOAuthClientProvider`. Mastra writes a small set
 * of string key/value pairs during the OAuth dance (`tokens`,
 * `client_info`, `code_verifier`, `state`, …); this adapter persists them
 * in the `mcp_oauth_state` table, one row per `(connection, scope_key)`,
 * with AES-256-GCM envelope encryption at rest.
 *
 * Why per-connection scoping (not one big global key→value map):
 *   - Makes `DELETE FROM mcp_connections WHERE id = …` cascade wipe every
 *     token, verifier, and registration fragment in lockstep. No dangling
 *     auth state when a user removes the Notion row.
 *   - Two distinct MCP connections to the same upstream (e.g. two Notion
 *     workspaces) can coexist without their state stomping on each
 *     other.
 *
 * Why encryption at rest:
 *   - The table stores refresh tokens that can live for weeks and access
 *     tokens that can impersonate the user against a remote SaaS. They
 *     inherit the same secret-handling posture as `env_envelope` /
 *     `headers_envelope` on the parent row. See
 *     `@agent-bridge/shared/crypto` for the envelope format.
 *
 * Boundary rationale:
 *   - Lives in `packages/agents` because only this workspace is allowed
 *     to import `@mastra/*` (root ESLint guard). The backend's
 *     `lib/mcp-connections/*` owns the higher-level flow and hands a
 *     constructed adapter to the probe.
 */

import { and, eq } from 'drizzle-orm'
import { schema, type AgentBridgeDb } from '@agent-bridge/db'
import { decryptSecret, encryptSecret } from '@agent-bridge/shared/crypto'
import type { OAuthStorage } from '@mastra/mcp'

/**
 * Drizzle-backed persistent implementation of Mastra's `OAuthStorage`.
 *
 * Each instance is bound to a single `mcp_connections.id` — construct
 * one per `MCPOAuthClientProvider`. Concurrency-safe: relies on the
 * primary key `(mcp_connection_id, scope_key)` for upsert atomicity.
 */
export class DrizzleOAuthStorage implements OAuthStorage {
  private readonly db: AgentBridgeDb['db']
  private readonly connectionId: string

  constructor(db: AgentBridgeDb['db'], connectionId: string) {
    // Parameter-property shorthand would be cleaner but the frontend
    // project references pull this file in via `@agent-bridge/agents`
    // and its tsconfig has `erasableSyntaxOnly: true`. Explicit
    // fields + assignment stay compatible with both.
    this.db = db
    this.connectionId = connectionId
  }

  async get(key: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ envelope: schema.mcpOauthState.valueEnvelope })
      .from(schema.mcpOauthState)
      .where(
        and(
          eq(schema.mcpOauthState.mcpConnectionId, this.connectionId),
          eq(schema.mcpOauthState.scopeKey, key),
        ),
      )
      .limit(1)

    if (!row) return undefined
    return safeDecrypt(row.envelope, key)
  }

  async set(key: string, value: string): Promise<void> {
    const envelope = encryptSecret(value)
    await this.db
      .insert(schema.mcpOauthState)
      .values({
        mcpConnectionId: this.connectionId,
        scopeKey: key,
        valueEnvelope: envelope,
      })
      .onConflictDoUpdate({
        target: [
          schema.mcpOauthState.mcpConnectionId,
          schema.mcpOauthState.scopeKey,
        ],
        set: { valueEnvelope: envelope },
      })
  }

  async delete(key: string): Promise<void> {
    await this.db
      .delete(schema.mcpOauthState)
      .where(
        and(
          eq(schema.mcpOauthState.mcpConnectionId, this.connectionId),
          eq(schema.mcpOauthState.scopeKey, key),
        ),
      )
  }

  /**
   * Wipe every OAuth artifact for this connection. Not part of the
   * `OAuthStorage` interface — used by admin flows ("re-authorize") and
   * by the backend when a connection row is updated in a way that
   * invalidates prior auth (URL change, scope change).
   */
  async clear(): Promise<void> {
    await this.db
      .delete(schema.mcpOauthState)
      .where(eq(schema.mcpOauthState.mcpConnectionId, this.connectionId))
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

function safeDecrypt(envelope: string, key: string): string | undefined {
  try {
    return decryptSecret(envelope)
  } catch (err) {
    // A decrypt failure means either:
    //   (a) the master key changed (user regenerated or restored from an
    //       incompatible backup) — the row is unrecoverable;
    //   (b) corruption.
    // Either way, surface the row as "not present" so the provider
    // treats it as "no cached auth" and re-initiates the flow. That is
    // strictly safer than throwing, which would crash the probe.
    console.warn(
      `[oauth-storage] decrypt failed for key=${key}: ${errMsg(err)}. ` +
        `Treating as absent; the user may need to re-authorize.`,
    )
    return undefined
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
