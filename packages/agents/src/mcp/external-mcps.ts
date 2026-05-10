/**
 * External MCP adapter.
 *
 * For every `agent_mcp_tools` row pointing at a `mcp_connections` the agent
 * opted into, this module:
 *
 *   1. Spins up ONE `@mastra/mcp` `MCPClient` per connection (stdio or
 *      http/sse) — same one-client-per-out-of-process-resource pattern as
 *      `gitnexus-mcp.ts`.
 *   2. Pulls the raw tool dict for that connection via `listToolsets()`
 *      (which, unlike `listTools()`, does NOT apply the SDK's
 *      `serverName_rawName` auto-prefix — see
 *      `packages/agents/node_modules/@mastra/mcp/dist/index.js:1667-1693` vs
 *      `:1717` — so we keep full control over the user-visible name).
 *   3. Filters each connection's tools against the allowlist for this
 *      agent + connection, rewrites the keys to
 *      `${slugify(connection.name)}__${rawName}`, and merges every
 *      connection's dict into one `Record<string, Tool>`.
 *
 * Why auto-prefix with a double underscore (not single):
 *   - Gitnexus already ships with `gitnexus_*` names. If we ALSO used a
 *     single `_`, a tool like `notion_search` could be ambiguous ("Notion's
 *     `search`" vs "a tool from a connection literally named
 *     `notion_search`"). The visually distinct `__` separator makes this
 *     unambiguous on the wire and in logs.
 *   - Gitnexus keeps its upstream names verbatim (mounted separately by
 *     `gitnexus-mcp.ts`); external MCPs go through this prefix scheme. The
 *     two namespaces are disjoint by construction.
 *
 * Sandbox parity with gitnexus:
 *   stdio connections reuse `buildSandboxedEnv({ sandbox: 'mcp-stdio',
 *   allowHostHome })` and overlay the operator-supplied env map on top.
 *   `StdioServerDefinition.env` accepts a full env replacement, so we MUST
 *   pass the baseline — otherwise the child starts with literally no env
 *   and even `PATH` disappears.
 *
 * Decrypt invariant:
 *   This file + `apps/backend/src/lib/mcp-connections/discover.ts` are the
 *   ONLY call sites allowed to `decryptSecret(...)` an mcp-connection
 *   envelope (see `docs/ARCHITECTURE.md` §4 and §8). If a third caller
 *   ever appears, treat it as a review regression.
 *
 * Loud-failure contract:
 *   An allowlisted connection that can't start OR whose upstream tool
 *   list is missing every allowlisted tool throws synchronously. This
 *   matches the gitnexus mount: misconfiguration surfaces at
 *   `buildAgent` time, not at first tool call. Partial-failure
 *   semantics ("one connection failed, keep the others") are NOT
 *   supported — the operator opted in to N connections and a silent N-1
 *   outcome is a worse UX than a clear error.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import type { McpAuthKind, McpTransport } from '@agent-bridge/shared'
import type { Tool } from '@mastra/core/tools'
import { MCPClient, MCPOAuthClientProvider } from '@mastra/mcp'
import { FixedMCPOAuthClientProvider } from './oauth-provider-fix.js'
import { and, asc, eq } from 'drizzle-orm'

import { DrizzleOAuthStorage } from './oauth-storage.js'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type { Readable } from 'node:stream'

// ─── Public surface ──────────────────────────────────────────────────────

export interface MountExternalMcpsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Debug escape hatch. When `true`, short-circuit past the DB read and
   * return `null` regardless of allowlist contents. Used by the smoke
   * script's future `--no-external-mcps` flag and by any path that needs
   * to isolate "does the LLM work at all?" from MCP problems.
   */
  readonly disabled?: boolean
}

export interface MountedConnectionMeta {
  readonly id: string
  readonly name: string
  /** Sanitised connection name used as the tool-key prefix. */
  readonly slug: string
  readonly transport: McpTransport
  /** Tool names the operator selected in `agent_mcp_tools` for this connection. */
  readonly selectedTools: readonly string[]
  /**
   * Subset of `selectedTools` that the upstream MCP did NOT advertise.
   * Populated so the UI can flag "this tool used to exist but is gone".
   * Empty in the happy path.
   */
  readonly missingTools: readonly string[]
  /**
   * Count of tools actually mounted (= `selectedTools.length -
   * missingTools.length`). Zero means the connection produced no usable
   * tools — we throw in that case rather than silently skipping.
   */
  readonly mountedToolCount: number
}

export interface ExternalMcpsMountMeta {
  /** `true` iff at least one connection mounted at least one tool. */
  readonly mounted: boolean
  /** Number of distinct `mcp_connections` rows the agent opted into. */
  readonly connectionCount: number
  /** Total tools across all mounted connections. */
  readonly toolCount: number
  /** Per-connection breakdown, in DB insertion order. */
  readonly perConnection: readonly MountedConnectionMeta[]
}

/**
 * One scrubbed stderr / log line surfaced from a mounted stdio MCP.
 * Emitted on the `MountedExternalMcps.subscribeLogs(...)` channel once
 * per line; the dispatcher wraps this into a `run.mcp.log` event.
 *
 * `level` is classified locally from the line prefix (see
 * `classifyMcpLogLine`) — the MCP spec doesn't standardise a structured
 * log format for stdio stderr, so we do a cheap best-effort here and
 * let the operator eyeball the line itself if needed.
 */
export interface McpLogLine {
  readonly connectionId: string
  readonly connectionName: string
  readonly level: 'info' | 'warn' | 'error'
  readonly line: string
}

export type McpLogHandler = (log: McpLogLine) => void

export interface MountedExternalMcps {
  readonly clients: readonly MCPClient[]
  readonly tools: Record<string, Tool<any, any, any, any>>
  readonly meta: ExternalMcpsMountMeta
  /**
   * Every decrypted env value + header value (≥4 chars) across all
   * mounted connections. `buildAgent` folds this into
   * `BuiltAgent.secrets` so the run-redactor scrubs them from
   * every SSE frame and `run_events` row.
   */
  readonly secrets: readonly string[]
  /**
   * Subscribe to live stderr output from every mounted stdio
   * connection. Returns an `unsubscribe` closure. Multiple handlers
   * can subscribe simultaneously (the dispatcher uses exactly one);
   * additional handlers are dispatched in registration order.
   *
   * The channel is purely push-based — if no handler is subscribed
   * when a line arrives, the line is dropped on the floor. This is
   * deliberate: we do NOT want to buffer potentially-secret-bearing
   * stderr indefinitely in memory (a misconfigured token would only
   * get scrubbed when the dispatcher's handler fires, which is
   * bound to the redactor). The caller (run-dispatcher) registers
   * BEFORE any tool is invoked, so the window where lines could be
   * lost is vanishingly small in practice.
   *
   * Handlers MUST be cheap and MUST NOT throw — thrown exceptions are
   * swallowed and logged, but the line is still considered delivered
   * from the subscriber list's perspective.
   */
  subscribeLogs(handler: McpLogHandler): () => void
  /** Idempotent teardown of every `MCPClient` mounted here. */
  disconnect(): Promise<void>
}

/**
 * Build the zero-mount result. Used when the agent has no allowlisted
 * tools (common: LLM-only agents, or agents that only use gitnexus).
 * Kept as a helper so `BuiltAgentMeta.externalMcps` always has the same
 * shape whether or not the mount ran.
 */
export function emptyExternalMcpsMountMeta(): ExternalMcpsMountMeta {
  return {
    mounted: false,
    connectionCount: 0,
    toolCount: 0,
    perConnection: [],
  }
}

/**
 * Fetch the agent's allowlist, decrypt per-connection secrets, spawn one
 * `MCPClient` per connection, and return a merged tool dict keyed by
 * `${slug}__${rawName}`. Returns `null` when there's nothing to mount
 * (no allowlist rows, or caller passed `disabled: true`).
 *
 * Throws loudly on any mount failure. See module docstring.
 */
export async function mountExternalMcps(
  input: MountExternalMcpsInput,
): Promise<MountedExternalMcps | null> {
  const { db, agentId, disabled = false } = input

  if (disabled) return null

  const allowlist = await loadAllowlist(db, agentId)
  if (allowlist.length === 0) return null

  const grouped = groupByConnection(allowlist)

  const clients: MCPClient[] = []
  const mergedTools: Record<string, Tool<any, any, any, any>> = {}
  const perConnection: MountedConnectionMeta[] = []
  const secrets: string[] = []
  const logBroker = new LogBroker()

  try {
    for (const group of grouped) {
      const mounted = await mountOneConnection({ db, agentId, group, secrets })
      clients.push(mounted.client)
      perConnection.push(mounted.meta)

      // Only stdio clients produce stderr output. http/sse transports
      // go over the wire and any diagnostics come back through the
      // JSON-RPC error path — there's nothing to pipe.
      if (group.transport === 'stdio') {
        attachStderrReader({
          broker: logBroker,
          client: mounted.client,
          connectionId: group.connectionId,
          connectionName: group.connectionName,
        })
      }

      for (const [key, tool] of Object.entries(mounted.tools)) {
        if (key in mergedTools) {
          // Defence in depth. Given the `${slug}__${rawName}` keying and
          // the fact that `mcp_connections.name` is globally unique, a
          // collision here implies a slug collapse ("Notion A" vs "Notion
          // B" both slugify to `notion_a`/`notion_b`) AND a matching raw
          // tool name. Rare but surface it loudly rather than letting one
          // silently replace the other.
          throw new Error(
            `[external-mcps] tool key collision on "${key}" between two ` +
              `connections — rename one of the mcp_connections so their ` +
              `slugs differ.`,
          )
        }
        mergedTools[key] = tool
      }
    }
  } catch (err) {
    logBroker.destroy()
    await Promise.allSettled(clients.map((c) => safeDisconnect(c)))
    throw err
  }

  const toolCount = Object.keys(mergedTools).length

  return {
    clients,
    tools: mergedTools,
    secrets,
    meta: {
      mounted: true,
      connectionCount: perConnection.length,
      toolCount,
      perConnection,
    },
    subscribeLogs: (handler) => logBroker.subscribe(handler),
    disconnect: buildMergedDisconnect(clients, logBroker),
  }
}

// ─── Internal: per-connection mount ──────────────────────────────────────

interface AllowlistRow {
  readonly connectionId: string
  readonly connectionName: string
  readonly transport: McpTransport
  readonly commandOrUrl: string
  readonly argsJson: readonly string[]
  readonly envEnvelope: string | null
  readonly headersEnvelope: string | null
  readonly allowHostHome: boolean
  /** Drives whether `mountOneConnection` wires an `MCPOAuthClientProvider`
   *  (so access tokens auto-refresh against the upstream server) for
   *  HTTP/SSE transports. `'none'` and `'headers'` skip the provider. */
  readonly authKind: McpAuthKind
  readonly toolName: string
}

interface ConnectionGroup {
  readonly connectionId: string
  readonly connectionName: string
  readonly transport: McpTransport
  readonly commandOrUrl: string
  readonly argsJson: readonly string[]
  readonly envEnvelope: string | null
  readonly headersEnvelope: string | null
  readonly allowHostHome: boolean
  readonly authKind: McpAuthKind
  readonly selectedTools: readonly string[]
}

interface MountedConnection {
  readonly client: MCPClient
  readonly tools: Record<string, Tool<any, any, any, any>>
  readonly meta: MountedConnectionMeta
}

async function mountOneConnection(args: {
  readonly db: AgentBridgeDb
  readonly agentId: string
  readonly group: ConnectionGroup
  readonly secrets: string[]
}): Promise<MountedConnection> {
  const { db, agentId, group, secrets } = args
  const slug = slugifyConnectionName(group.connectionName)

  // Decrypt exactly what the transport needs. Keeping the decryption
  // transport-conditional avoids building a bag of plaintext for http
  // rows (which have no `env`) or stdio rows (which have no `headers`),
  // which in turn keeps the `secrets` list minimal.
  const isHttp = group.transport === 'http' || group.transport === 'sse'

  const decryptedEnv = !isHttp
    ? decryptMapEnvelope(group.envEnvelope, `connection ${group.connectionName} env`)
    : null
  const decryptedHeaders = isHttp
    ? decryptMapEnvelope(
        group.headersEnvelope,
        `connection ${group.connectionName} headers`,
      )
    : null

  collectSecretsFromMap(decryptedEnv, secrets)
  collectSecretsFromMap(decryptedHeaders, secrets)

  // OAuth provider for HTTP/SSE connections that the operator authorized
  // via the discover/test flow. Without this, runtime calls send NO
  // `Authorization` header (or send a stale token from `headers`) and
  // the server 401s — the operator would have to re-run the test flow
  // every time the access token expires (typically 1h on Notion / 24h
  // on Atlassian). With it: Mastra's provider reads the access token
  // from `mcp_oauth_state`, transparently refreshes via the persisted
  // refresh-token when expired, and writes the new tokens back to the
  // same scope_key. The operator only sees a re-auth prompt when the
  // refresh-token itself dies (rare; most providers issue long-lived
  // ones), and that surfaces here as a thrown error from the
  // `onRedirectToAuthorization` hook.
  const authProvider = buildOauthProviderIfNeeded({
    db,
    transport: group.transport,
    authKind: group.authKind,
    connectionId: group.connectionId,
    connectionName: group.connectionName,
  })

  const serverDef = buildServerDef({
    transport: group.transport,
    commandOrUrl: group.commandOrUrl,
    args: group.argsJson,
    env: decryptedEnv,
    headers: decryptedHeaders,
    allowHostHome: group.allowHostHome,
    authProvider,
  })

  // ID combines connection + agent: Mastra hashes config internally and
  // would otherwise share an `InternalMastraMCPClient` between two agents
  // that both hold the same connection. Sharing would mean one agent's
  // disconnect kills the other's tools.
  const client = new MCPClient({
    id: `external-${group.connectionId}-${agentId}`,
    servers: { ext: serverDef },
    // Keep parity with gitnexus's generous connect budget; http servers
    // normally respond in ms but stdio children doing Python/node boot
    // can legitimately take a few seconds the first time.
    timeout: 30_000,
  })

  let toolsets: Record<string, Record<string, Tool<any, any, any, any>>>
  try {
    // `listToolsets()` returns `{ [serverName]: { [rawToolName]: Tool } }`
    // — no SDK-applied prefix. This is the API that gives us naming
    // control; `listTools()` would hand back `ext_rawName` and force a
    // post-strip. See @mastra/mcp:1667 vs :1717.
    toolsets = await client.listToolsets()
  } catch (err) {
    await safeDisconnect(client)
    throw new Error(
      `[external-mcps] connection "${group.connectionName}" (${group.transport}) ` +
        `failed to list tools: ${errMsg(err)}`,
    )
  }

  const rawTools = toolsets.ext ?? {}
  const rawNames = new Set(Object.keys(rawTools))

  const selected: string[] = [...group.selectedTools]
  const missing = selected.filter((name) => !rawNames.has(name))

  const mountedTools: Record<string, Tool<any, any, any, any>> = {}
  for (const rawName of selected) {
    const tool = rawTools[rawName]
    if (!tool) continue
    mountedTools[`${slug}__${rawName}`] = tool
  }

  const mountedToolCount = Object.keys(mountedTools).length
  if (mountedToolCount === 0) {
    await safeDisconnect(client)
    throw new Error(
      `[external-mcps] connection "${group.connectionName}" advertised ` +
        `${rawNames.size} tool(s) but none matched the allowlist ` +
        `[${selected.join(', ')}]; refusing to mount. ` +
        `Missing: [${missing.join(', ')}].`,
    )
  }

  return {
    client,
    tools: mountedTools,
    meta: {
      id: group.connectionId,
      name: group.connectionName,
      slug,
      transport: group.transport,
      selectedTools: selected,
      missingTools: missing,
      mountedToolCount,
    },
  }
}

// ─── Internal: DB read ───────────────────────────────────────────────────

async function loadAllowlist(
  db: AgentBridgeDb,
  agentId: string,
): Promise<AllowlistRow[]> {
  const rows = await db.db
    .select({
      connectionId: schema.mcpConnections.id,
      connectionName: schema.mcpConnections.name,
      transport: schema.mcpConnections.transport,
      commandOrUrl: schema.mcpConnections.commandOrUrl,
      argsJson: schema.mcpConnections.argsJson,
      envEnvelope: schema.mcpConnections.envEnvelope,
      headersEnvelope: schema.mcpConnections.headersEnvelope,
      allowHostHome: schema.mcpConnections.allowHostHome,
      authKind: schema.mcpConnections.authKind,
      toolName: schema.agentMcpTools.toolName,
      enabled: schema.agentMcpTools.enabled,
      createdAt: schema.agentMcpTools.createdAt,
    })
    .from(schema.agentMcpTools)
    .innerJoin(
      schema.mcpConnections,
      eq(schema.agentMcpTools.mcpConnectionId, schema.mcpConnections.id),
    )
    .where(
      and(
        eq(schema.agentMcpTools.agentId, agentId),
        eq(schema.agentMcpTools.enabled, true),
      ),
    )
    .orderBy(
      asc(schema.mcpConnections.createdAt),
      asc(schema.agentMcpTools.toolName),
    )

  return rows.map((r) => ({
    connectionId: r.connectionId,
    connectionName: r.connectionName,
    transport: r.transport,
    commandOrUrl: r.commandOrUrl,
    argsJson: r.argsJson,
    envEnvelope: r.envEnvelope,
    headersEnvelope: r.headersEnvelope,
    allowHostHome: r.allowHostHome,
    authKind: r.authKind,
    toolName: r.toolName,
  }))
}

function groupByConnection(rows: AllowlistRow[]): ConnectionGroup[] {
  const byId = new Map<string, ConnectionGroup & { selectedTools: string[] }>()
  for (const row of rows) {
    const existing = byId.get(row.connectionId)
    if (existing) {
      existing.selectedTools.push(row.toolName)
      continue
    }
    byId.set(row.connectionId, {
      connectionId: row.connectionId,
      connectionName: row.connectionName,
      transport: row.transport,
      commandOrUrl: row.commandOrUrl,
      argsJson: row.argsJson,
      envEnvelope: row.envEnvelope,
      headersEnvelope: row.headersEnvelope,
      allowHostHome: row.allowHostHome,
      authKind: row.authKind,
      selectedTools: [row.toolName],
    })
  }
  return Array.from(byId.values())
}

// ─── Internal: server def + helpers ──────────────────────────────────────

/**
 * `@mastra/mcp`'s `MastraMCPServerDefinition` is a discriminated union of
 * `StdioServerDefinition | HttpServerDefinition` — there is NO separate
 * SSE definition. The HTTP transport auto-negotiates Streamable-HTTP →
 * SSE fallback (see the SDK's types.d.ts). Our `'sse'` transport value
 * is therefore a UI label hint and routes through the same HTTP def.
 */
function buildServerDef(input: {
  readonly transport: McpTransport
  readonly commandOrUrl: string
  readonly args: readonly string[]
  readonly env: Record<string, string> | null
  readonly headers: Record<string, string> | null
  readonly allowHostHome: boolean
  /** When set (HTTP/SSE + OAuth-kind connection), Mastra owns auth-header
   *  injection AND token refresh. Operator-supplied `headers` still
   *  layer on top — useful for combining a persistent API key with an
   *  OAuth access-token, though most servers won't accept both. */
  readonly authProvider?: MCPOAuthClientProvider | null
}): ServerDef {
  if (input.transport === 'http' || input.transport === 'sse') {
    let url: URL
    try {
      url = new URL(input.commandOrUrl)
    } catch {
      throw new Error(
        `[external-mcps] invalid URL for ${input.transport} transport: ` +
          JSON.stringify(input.commandOrUrl),
      )
    }
    return {
      url,
      // `requestInit.headers` is how @mastra/mcp injects auth for both
      // Streamable-HTTP and SSE fallback paths. Empty object is fine (no
      // `undefined`-valued entries survive `compactMap`).
      requestInit: {
        headers: input.headers ?? {},
      },
      ...(input.authProvider ? { authProvider: input.authProvider } : {}),
      // `stderr` / `env` etc. are `never` on HttpServerDefinition — don't
      // set them here.
    }
  }

  // stdio
  const sandboxedBase = compactEnv(
    buildSandboxedEnv({
      sandbox: 'mcp-stdio',
      allowHostHome: input.allowHostHome,
    }),
  )

  // Operator-supplied env overlays the sandbox baseline. This lets a
  // Notion MCP set `NOTION_TOKEN=...` without forcing the operator to
  // also restate `PATH` / `LANG` / etc. An explicit override of a
  // sandbox-managed var (`HOME`, `XDG_*`) wins, which is intentional —
  // trusted operator, not adversarial input.
  const env: Record<string, string> = { ...sandboxedBase, ...(input.env ?? {}) }

  return {
    command: input.commandOrUrl,
    args: [...input.args],
    env,
    // `stderr: 'pipe'` keeps 4F's future line-split reader simple. Until
    // we wire it we still want to avoid spewing child banners onto the
    // backend's stderr (which is a real problem in dev when running
    // several MCPs), so 'pipe' is the MVP-correct default too.
    stderr: 'pipe',
  }
}

type ServerDef = ConstructorParameters<typeof MCPClient>[0]['servers'][string]

/**
 * MCP OAuth callback URL — must match
 * `apps/backend/src/routes/mcp-connections.ts:buildOauthCallbackUrl`
 * byte-for-byte. Notion / Atlassian / etc. enforce strict
 * `redirect_uri` matching, and the dynamic-client-registration record
 * persisted on first authorize pinned this exact value. If you change
 * the format here, change it there too AND have every operator
 * re-authorize.
 *
 * Reads `PORT` from `process.env` (default 3001 — matches `.env.example`)
 * so the agents package doesn't need to import backend env config.
 */
function mcpOauthCallbackUrl(connectionId: string): string {
  const port = process.env['PORT'] || '3001'
  return `http://localhost:${port}/oauth/mcp/${connectionId}/callback`
}

/**
 * Build an `MCPOAuthClientProvider` for a connection that needs one,
 * else return null. Centralised so `mountOneConnection` doesn't have to
 * branch on transport + auth-kind inline.
 *
 * Skips when:
 *   - transport is stdio (no HTTP auth surface)
 *   - authKind is anything other than `'oauth'` (`'none'` and `'headers'`
 *     don't talk to the OAuth state machine)
 *
 * The OAuth callback URL must match the test/discover path byte-for-byte
 * — Notion / Atlassian / etc. enforce strict redirect-URI matching at
 * the upstream authorization server, and the dynamic-client-registration
 * payload pinned this exact value when the operator first authorized.
 * Same shape as `apps/backend/src/routes/mcp-connections.ts:buildOauthCallbackUrl`.
 */
function buildOauthProviderIfNeeded(input: {
  readonly db: AgentBridgeDb
  readonly transport: McpTransport
  readonly authKind: McpAuthKind
  readonly connectionId: string
  readonly connectionName: string
}): MCPOAuthClientProvider | null {
  const { db, transport, authKind, connectionId, connectionName } = input
  if (transport === 'stdio') return null
  if (authKind !== 'oauth') return null
  const redirectUrl = mcpOauthCallbackUrl(connectionId)
  return new FixedMCPOAuthClientProvider({
    redirectUrl,
    clientMetadata: {
      // Identical metadata to the discover/test path so the persisted
      // `client_info` row stays valid — if these drift, Mastra would
      // re-register and the operator would lose their tokens.
      client_name: 'Agent Bridge',
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    storage: new DrizzleOAuthStorage(db.db, connectionId),
    onRedirectToAuthorization: (url) => {
      // Refresh failed AND the access path can't be silently recovered
      // (refresh-token died, scope changed, server rotated client). At
      // runtime we have no UI to redirect the user to, so throw a clear
      // error that the dispatcher's `classifyMessage` will mark as
      // `auth` and the operator sees in /logs as a red Run error.
      // The fix is for the operator to revisit the MCP detail page and
      // re-run Discover to complete the OAuth popup again.
      throw new Error(
        `[external-mcps] connection "${connectionName}" needs re-authorization ` +
          `(upstream OAuth refresh failed; got REDIRECT to ${url.toString().slice(0, 120)}…). ` +
          `Open the MCP detail page in /library/mcp and click Discover to re-authorize.`,
      )
    },
  })
}

// ─── Internal: crypto + env helpers ──────────────────────────────────────

function decryptMapEnvelope(
  envelope: string | null,
  label: string,
): Record<string, string> | null {
  if (!envelope) return null
  let plaintext: string
  try {
    plaintext = decryptSecret(envelope)
  } catch (err) {
    throw new Error(
      `[external-mcps] failed to decrypt ${label}: ${errMsg(err)} — ` +
        `is AGENT_BRIDGE_SECRET_KEY the one that wrote the envelope?`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch (err) {
    throw new Error(
      `[external-mcps] ${label} envelope decrypted but was not valid ` +
        `JSON: ${errMsg(err)}`,
    )
  }
  if (!isRecordOfStrings(parsed)) {
    throw new Error(
      `[external-mcps] ${label} envelope payload must be an object of ` +
        `string-valued entries`,
    )
  }
  return parsed
}

function isRecordOfStrings(
  value: unknown,
): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}

/**
 * Fold every ≥4-char value from a decrypted map into the shared
 * `secrets[]` accumulator. Mirrors the `apiKey` length gate in
 * `build-agent.ts` so the run-redactor's minimum-length rule is applied
 * identically here.
 */
function collectSecretsFromMap(
  map: Record<string, string> | null,
  acc: string[],
): void {
  if (!map) return
  for (const v of Object.values(map)) {
    if (typeof v === 'string' && v.length >= 4) acc.push(v)
  }
}

/**
 * Narrow `NodeJS.ProcessEnv` (which includes `undefined`) into a
 * plain `Record<string, string>` for the stdio server def. Dropping an
 * undefined entry is semantically equivalent to not setting the var.
 */
function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Sanitise the user-visible connection name into a tool-key prefix:
 * lowercase, only ASCII word chars, collapse runs, strip edges. The
 * double-underscore separator between this and the raw tool name makes
 * the boundary visually unambiguous even when `slug` or `rawName`
 * themselves contain single underscores.
 */
function slugifyConnectionName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}

async function safeDisconnect(client: MCPClient): Promise<void> {
  try {
    await client.disconnect()
  } catch {
    // Swallow — if `disconnect()` itself errors we have bigger problems,
    // and we don't want the disconnect-time failure to mask the original
    // error that led us here (matches the gitnexus mount's policy).
  }
}

function buildMergedDisconnect(
  clients: readonly MCPClient[],
  broker: LogBroker,
): () => Promise<void> {
  let done = false
  return async () => {
    if (done) return
    done = true
    // Tear down stderr readers BEFORE disconnecting clients — the
    // readline interfaces close naturally when `disconnect()` kills
    // the child and the stderr stream ends, but calling it first
    // ensures we stop dispatching log events to subscribers the
    // instant teardown begins.
    broker.destroy()
    // `Promise.allSettled` so one failing client's disconnect doesn't
    // leave the others running. We swallow rejections from each — the
    // caller's `finally` expects teardown to always succeed from its
    // perspective.
    await Promise.allSettled(clients.map((c) => safeDisconnect(c)))
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── Internal: stderr log pipe + broker ──────────────────────────────────

/**
 * Multiplexes stderr lines from every mounted stdio connection into a
 * single fan-out channel. `run-dispatcher` registers ONE handler that
 * scrubs the line through the run-redactor and publishes a
 * `run.mcp.log` event; additional handlers are allowed (the smoke
 * script subscribes to print debug lines to the console).
 *
 * Destroy semantics:
 *   - `destroy()` removes every subscriber AND closes every registered
 *     readline interface. Readline doesn't have a public close method
 *     for partial input, but `.close()` on the interface fires a last
 *     `line` for any buffered tail (matching Node docs). The
 *     underlying stream's own `end` event would also drive this, so
 *     the explicit close is belt-and-braces.
 *   - Safe to call twice. Subsequent subscribes after destroy become
 *     no-op unsubscribe closures — the mount is torn down, any new
 *     lines would never arrive anyway.
 */
class LogBroker {
  private readonly handlers = new Set<McpLogHandler>()
  private readonly readers: ReadlineInterface[] = []
  private destroyed = false

  addReader(reader: ReadlineInterface): void {
    if (this.destroyed) {
      try {
        reader.close()
      } catch {
        /* swallow */
      }
      return
    }
    this.readers.push(reader)
  }

  subscribe(handler: McpLogHandler): () => void {
    if (this.destroyed) return () => {}
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(log: McpLogLine): void {
    if (this.destroyed) return
    // Snapshot the handler list so a handler that unsubscribes itself
    // mid-emit doesn't skip a sibling in the same frame.
    const snapshot = Array.from(this.handlers)
    for (const h of snapshot) {
      try {
        h(log)
      } catch (err) {
        // The contract says handlers MUST NOT throw; a misbehaving
        // handler shouldn't take down the whole broker. Log once per
        // throw so the bug is visible without flooding the console if
        // a handler throws on every line.
        console.error('[external-mcps] log handler threw:', err)
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.handlers.clear()
    for (const r of this.readers) {
      try {
        r.close()
      } catch {
        /* swallow — same rationale as safeDisconnect */
      }
    }
    this.readers.length = 0
  }
}

/**
 * Attach a line-by-line reader to a stdio connection's stderr and
 * bridge each line into the `LogBroker`. Called ONLY for `stdio`
 * connections — http/sse have no process and `getServerStderr` would
 * return null anyway.
 *
 * The mastra `MCPClient.getServerStderr(serverName)` returns the
 * underlying `ChildProcess.stderr` Readable when `stderr: 'pipe'` was
 * set on the server def (which we always do for stdio — see
 * `buildServerDef`). The stream exists only after the client has
 * connected; `listToolsets()` triggers connect synchronously before
 * returning, so by the time we call this the stream is live.
 *
 * If for any reason the stream is unavailable (future SDK change,
 * transport override) we silently skip — absent log piping is not a
 * hard failure for the run, it just means the operator can't see the
 * subprocess banner.
 */
function attachStderrReader(args: {
  readonly broker: LogBroker
  readonly client: MCPClient
  readonly connectionId: string
  readonly connectionName: string
}): void {
  const { broker, client, connectionId, connectionName } = args
  // `getServerStderr` is the mastra-exposed accessor; `'ext'` is the
  // fixed single-server key we use per `mountOneConnection`.
  const stderr = client.getServerStderr('ext') as Readable | null
  if (!stderr) return

  const reader = createInterface({
    input: stderr,
    // `crlfDelay: Infinity` normalises Windows-style CRLF line endings
    // to single LFs. Most MCP servers run on Linux/macOS and use LF
    // but the cost is negligible and the normalisation is a one-liner.
    crlfDelay: Infinity,
  })

  reader.on('line', (rawLine: string) => {
    // Strip ANSI color codes: MCPs running via `npx` or colored shell
    // wrappers love to emit escape sequences that look like junk in
    // our UI. We don't try to preserve them — the run-redactor is
    // plaintext-only and escape sequences in persisted
    // `run_events.payload_json` just bloat the audit log.
    const line = stripAnsi(rawLine).trimEnd()
    // Skip empty lines (common after stripping a pure ANSI reset) so
    // we don't spam the UI with blank log cards.
    if (line.length === 0) return
    broker.emit({
      connectionId,
      connectionName,
      level: classifyMcpLogLine(line),
      line,
    })
  })

  // Reader closes when the subprocess exits. `close` fires at most
  // once, so no manual dedupe. We don't need a handler here — the
  // broker stops emitting on `destroy()` regardless — but keeping
  // an explicit listener keeps node from surfacing an unhandled
  // close warning in some edge setups.
  reader.on('close', () => {})

  // Errors on the stderr stream are extremely rare (EBADF after a
  // kill -9, for example). Swallow them so a flaky pipe doesn't take
  // down the whole run; the subprocess dying will surface through
  // tool-call errors already.
  stderr.on('error', (err: unknown) => {
    console.error(
      `[external-mcps] stderr stream error for "${connectionName}":`,
      err,
    )
  })

  broker.addReader(reader)
}

/**
 * Best-effort level classification. MCP spec doesn't mandate a
 * structured stderr format, so we match on common prefixes. Falls
 * back to `info` for everything else — operators see every line
 * regardless, the level is just a UI hint (icon + color) so we err
 * on the side of noise over noise-to-signal filtering.
 */
function classifyMcpLogLine(line: string): McpLogLine['level'] {
  // Fast-path on the first 32 chars — prefixes tend to be at the
  // start of the line, and a bounded slice keeps us from scanning
  // long JSON payloads.
  const head = line.slice(0, 32).toUpperCase()
  if (/^(ERROR|FATAL|ERR|FAIL|PANIC)\b/.test(head)) return 'error'
  if (/\b(ERROR|EXCEPTION|UNCAUGHT)\b/.test(head)) return 'error'
  if (/^(WARN|WARNING)\b/.test(head)) return 'warn'
  if (/\bWARN(ING)?\b/.test(head)) return 'warn'
  return 'info'
}

/**
 * Strip ANSI color / cursor escape sequences from a log line. Handles
 * the common CSI (`\x1b[` ... letter) and OSC (`\x1b]` ... BEL/ST)
 * forms; anything exotic just passes through and will look like
 * garbage in the UI, which is fine — operators can fix the MCP's
 * `NO_COLOR` / `FORCE_COLOR=0` env var.
 */
function stripAnsi(input: string): string {
  return input
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, '')
}
