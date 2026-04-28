/**
 * Dispatcher for `POST /api/mcp-connections/:id/test`.
 *
 * Single decrypt site for mcp-connection `env_envelope` /
 * `headers_envelope`. `packages/agents/src/mcp/external-mcps.ts` is the
 * ONLY other file allowed to call `decryptSecret` on these envelopes —
 * see `docs/ARCHITECTURE.md` §8. Grep invariant:
 *
 *   rg 'decryptSecret' apps/backend packages/agents
 *
 * should return exactly these two + the LLM provider helper + the worker
 * job + crypto.ts itself.
 *
 * Decryption happens inside this function and the resulting plaintext
 * lives in one local variable per call. The probe never returns the
 * plaintext, and `sanitizeMessage` scrubs any that accidentally ends up
 * in an upstream error string before we cross the response boundary.
 */

import {
  discoverMcpTools,
  discoverMcpToolsOAuth,
  DrizzleOAuthStorage,
} from '@agent-bridge/agents'
import type {
  DiscoverOAuthProbeResult,
  DiscoverProbeResult,
} from '@agent-bridge/agents'
import type { AgentBridgeDb } from '@agent-bridge/db'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  mcpConnectionDiscoverResponseSchema,
  type DiscoveredMcpTool,
  type McpAuthKind,
  type McpConnectionDiscoverErrorCode,
  type McpConnectionDiscoverInput,
  type McpConnectionDiscoverResponse,
  type McpTransport,
  type SecretMapInput,
} from '@agent-bridge/shared'
import { getTestSessionRegistry } from './test-sessions.js'

/**
 * Minimal shape this module needs from a saved `mcp_connections` row.
 * Structural so it doesn't drag the Drizzle schema into `lib/`.
 */
export interface StoredMcpConnection {
  readonly id: string
  readonly transport: McpTransport
  readonly commandOrUrl: string
  readonly argsJson: readonly string[]
  readonly envEnvelope: string | null
  readonly headersEnvelope: string | null
  readonly authKind: McpAuthKind
  readonly allowHostHome: boolean
}

/**
 * Extra context the OAuth path needs that the non-OAuth path doesn't:
 *   - `db`          → hands a scoped `DrizzleOAuthStorage` to the provider
 *   - `redirectUrl` → the absolute URL Notion (etc.) calls back into when
 *                     the user approves. Must match our registered
 *                     `redirect_uris` byte-for-byte (Notion pins this at
 *                     dynamic-client-registration time).
 */
export interface McpTestContext {
  readonly db: AgentBridgeDb['db']
  readonly redirectUrl: string
}

export async function testMcpConnection(
  stored: StoredMcpConnection,
  override: McpConnectionDiscoverInput,
  ctx: McpTestContext,
): Promise<McpConnectionDiscoverResponse> {
  const started = Date.now()

  // Effective auth kind: the body override wins so operators can test a
  // draft before persisting. Matches the same pattern we use for every
  // other field on this endpoint.
  const effectiveAuthKind: McpAuthKind =
    override.auth?.kind ?? stored.authKind

  if (effectiveAuthKind === 'oauth') {
    return runOauthProbe(stored, ctx, started)
  }

  const resolved = resolveConfig(stored, override)
  if (!resolved.ok) {
    return finalise({
      transport: stored.transport,
      started,
      probeResult: { ok: false, code: 'unknown', message: resolved.message },
      plaintextValues: [],
    })
  }

  const { plaintextValues, probeInput } = resolved

  let probeResult: DiscoverProbeResult
  try {
    probeResult = await discoverMcpTools(probeInput)
  } catch (err) {
    // `discoverMcpTools` is contracted not to throw, but wrap defensively
    // so a bug there can never leak plaintext via an uncaught stack trace.
    probeResult = {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : 'unknown error',
    }
  }

  return finalise({
    transport: stored.transport,
    started,
    probeResult,
    plaintextValues,
  })
}

// ─── OAuth probe (Phase 4H) ──────────────────────────────────────────────

/**
 * OAuth probe entry. Creates a fresh test session, runs the provider
 * without an authorization code, and translates the result to the
 * shared wire shape.
 *
 *   AUTHORIZED  → finalize session as `ok`, return `{ ok: true, tools }`.
 *   REDIRECT    → mark session `authorize_required`, return
 *                 `{ ok: false, code: 'authorize_required',
 *                    sessionId, authorizeUrl }`.
 *   error       → finalize session as `failed`, return the usual error
 *                 envelope. Note the session still exists briefly so
 *                 any concurrent poller observes the failure.
 *
 * Stdio + http+headers never flow through here — those stay on the
 * synchronous `discoverMcpTools` path above.
 */
async function runOauthProbe(
  stored: StoredMcpConnection,
  ctx: McpTestContext,
  started: number,
): Promise<McpConnectionDiscoverResponse> {
  if (stored.transport !== 'http' && stored.transport !== 'sse') {
    // Should be caught by the DTO policy long before we get here.
    return finalise({
      transport: stored.transport,
      started,
      probeResult: {
        ok: false,
        code: 'unknown',
        message: `auth.kind="oauth" is not applicable to transport="${stored.transport}"`,
      },
      plaintextValues: [],
    })
  }

  const registry = getTestSessionRegistry()
  const session = registry.create({
    connectionId: stored.id,
    transport: stored.transport,
    // Nothing to tear down — the OAuth probe builds and disposes of
    // its own MCPClient within `discoverMcpToolsOAuth`. The disposer
    // is here as a hook for future resource handles (e.g. an abort
    // controller on the fetch call).
    disposer: () => {},
  })

  const storage = new DrizzleOAuthStorage(ctx.db, stored.id)

  let result: DiscoverOAuthProbeResult
  try {
    result = await discoverMcpToolsOAuth({
      transport: stored.transport,
      serverUrl: stored.commandOrUrl,
      redirectUrl: ctx.redirectUrl,
      clientMetadata: {
        // Identify ourselves to the upstream authorization server.
        // `client_name` shows up on the consent screen in Notion /
        // Atlassian / etc. Keep it user-recognisable.
        client_name: 'Agent Bridge',
        redirect_uris: [ctx.redirectUrl],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      storage,
    })
  } catch (err) {
    // `discoverMcpToolsOAuth` is contracted not to throw, but wrap
    // defensively so an internal bug can't leak a half-built session.
    result = {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : 'unknown oauth error',
    }
  }

  if (result.ok && result.kind === 'redirect') {
    registry.attachOauthState(session.sessionId, result.oauthState)
    registry.markAuthorizeRequired(session.sessionId, result.authorizeUrl)
    return mcpConnectionDiscoverResponseSchema.parse({
      ok: false,
      durationMs: Date.now() - started,
      transport: stored.transport,
      code: 'authorize_required',
      message: 'upstream requires OAuth approval — open the authorize URL',
      sessionId: session.sessionId,
      authorizeUrl: result.authorizeUrl,
    })
  }

  if (result.ok && result.kind === 'authorized') {
    const tools: DiscoveredMcpTool[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.inputSchema },
    }))
    registry.finalize(session.sessionId, {
      status: 'ok',
      tools,
      rawToolCount: result.rawToolCount,
      serverVersion: result.serverVersion,
    })
    return mcpConnectionDiscoverResponseSchema.parse({
      ok: true,
      durationMs: Date.now() - started,
      transport: stored.transport,
      tools,
      toolCount: result.rawToolCount,
      serverVersion: result.serverVersion,
      message:
        result.rawToolCount === 0
          ? 'authorized but server advertised no tools'
          : `authorized · ${result.rawToolCount} tool(s)`,
    })
  }

  // ok: false
  const errorResult = result as Extract<DiscoverOAuthProbeResult, { ok: false }>
  registry.finalize(session.sessionId, {
    status: 'failed',
    code: errorResult.code,
    message: errorResult.message,
  })
  return finalise({
    transport: stored.transport,
    started,
    probeResult: {
      ok: false,
      code: errorResult.code,
      message: errorResult.message,
    },
    plaintextValues: [],
  })
}

// ─── OAuth callback completion ───────────────────────────────────────────

/**
 * Called by `GET /oauth/mcp/:connectionId/callback` after the user
 * approves upstream. Exchanges the authorization `code` for tokens via
 * the same provider + storage the initial probe used, then runs
 * `listToolsets()` so the test session can transition to terminal
 * `ok` (or `failed`).
 *
 * Caller is expected to have already looked up and CSRF-checked the
 * session via `getTestSessionRegistry()`. This function does the MCP
 * work and finalises the session; it returns nothing so the caller
 * can decide its HTTP response shape (e.g. "close this tab" HTML).
 */
export async function completeOauthCallback(args: {
  readonly stored: StoredMcpConnection
  readonly ctx: McpTestContext
  readonly sessionId: string
  readonly authorizationCode: string
}): Promise<void> {
  const { stored, ctx, sessionId, authorizationCode } = args
  const registry = getTestSessionRegistry()

  if (stored.transport !== 'http' && stored.transport !== 'sse') {
    registry.finalize(sessionId, {
      status: 'failed',
      code: 'unknown',
      message: `auth.kind="oauth" is not applicable to transport="${stored.transport}"`,
    })
    return
  }

  const storage = new DrizzleOAuthStorage(ctx.db, stored.id)

  let result: DiscoverOAuthProbeResult
  try {
    result = await discoverMcpToolsOAuth({
      transport: stored.transport,
      serverUrl: stored.commandOrUrl,
      redirectUrl: ctx.redirectUrl,
      clientMetadata: {
        client_name: 'Agent Bridge',
        redirect_uris: [ctx.redirectUrl],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      storage,
      authorizationCode,
    })
  } catch (err) {
    registry.finalize(sessionId, {
      status: 'failed',
      code: 'unknown',
      message: err instanceof Error ? err.message : 'oauth callback failed',
    })
    return
  }

  if (result.ok && result.kind === 'authorized') {
    const tools: DiscoveredMcpTool[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.inputSchema },
    }))
    registry.finalize(sessionId, {
      status: 'ok',
      tools,
      rawToolCount: result.rawToolCount,
      serverVersion: result.serverVersion,
    })
    return
  }

  if (result.ok && result.kind === 'redirect') {
    // Strange case: user approved but provider still wants another
    // redirect. Treat as failure — we won't bounce the user through
    // again automatically.
    registry.finalize(sessionId, {
      status: 'failed',
      code: 'auth',
      message:
        'upstream rejected the authorization code and asked to re-authorize',
    })
    return
  }

  const errorResult = result as Extract<DiscoverOAuthProbeResult, { ok: false }>
  registry.finalize(sessionId, {
    status: 'failed',
    code: errorResult.code,
    message: errorResult.message,
  })
}

// ─── Configuration resolution ────────────────────────────────────────────

interface ResolvedOk {
  readonly ok: true
  readonly probeInput: Parameters<typeof discoverMcpTools>[0]
  /** Every decrypted value, fed to `sanitizeMessage` on the way out. */
  readonly plaintextValues: readonly string[]
}

type Resolved =
  | ResolvedOk
  | { readonly ok: false; readonly message: string }

function resolveConfig(
  stored: StoredMcpConnection,
  override: McpConnectionDiscoverInput,
): Resolved {
  const commandOrUrl =
    override.commandOrUrl !== undefined
      ? override.commandOrUrl
      : stored.commandOrUrl
  const args =
    override.argsJson !== undefined ? override.argsJson : stored.argsJson
  const allowHostHome =
    override.allowHostHome !== undefined
      ? override.allowHostHome
      : stored.allowHostHome

  // Decrypt env / headers per the three-state override protocol. Treat a
  // missing override identically to `{ action: 'unchanged' }` — fall
  // back to the stored envelope. Note: override-`set` carries plaintext
  // directly from the client; we never re-encrypt it (test-only) and we
  // do track it in `plaintextValues` so `sanitizeMessage` can scrub.
  let env: Record<string, string> | null
  let headers: Record<string, string> | null
  const plaintextValues: string[] = []

  try {
    const envResolved = resolveMapInput(override.env, stored.envEnvelope)
    env = envResolved
    if (env) for (const v of Object.values(env)) plaintextValues.push(v)

    const headersResolved = resolveMapInput(
      override.headers,
      stored.headersEnvelope,
    )
    headers = headersResolved
    if (headers)
      for (const v of Object.values(headers)) plaintextValues.push(v)
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'failed to decrypt secret',
    }
  }

  return {
    ok: true,
    plaintextValues,
    probeInput: {
      transport: stored.transport,
      commandOrUrl,
      args,
      env,
      headers,
      allowHostHome,
    },
  }
}

/**
 * Three-state resolver for `SecretMapInput` in a TEST context.
 *   - `undefined` or `{ action: 'unchanged' }` → decrypt saved envelope
 *   - `{ action: 'clear' }`                    → treat as no value
 *   - `{ action: 'set', plaintext }`           → use the draft directly
 *
 * Returns `null` when there's no value for this slot (cleared or
 * originally absent).
 */
function resolveMapInput(
  input: SecretMapInput | undefined,
  storedEnvelope: string | null,
): Record<string, string> | null {
  if (!input || input.action === 'unchanged') {
    return decryptMapEnvelope(storedEnvelope)
  }
  if (input.action === 'clear') return null
  return { ...input.plaintext }
}

function decryptMapEnvelope(
  envelope: string | null,
): Record<string, string> | null {
  if (!envelope) return null
  let plaintext: string
  try {
    plaintext = decryptSecret(envelope)
  } catch (err) {
    throw new Error(
      `failed to decrypt stored secret — is AGENT_BRIDGE_SECRET_KEY ` +
        `the one that wrote it? (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  const parsed: unknown = JSON.parse(plaintext)
  if (!isRecordOfStrings(parsed)) {
    throw new Error(
      `stored secret envelope decrypted but payload is not an object of strings`,
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

// ─── Response shaping ────────────────────────────────────────────────────

function finalise(args: {
  readonly transport: McpTransport
  readonly started: number
  readonly probeResult: DiscoverProbeResult
  readonly plaintextValues: readonly string[]
}): McpConnectionDiscoverResponse {
  const durationMs = Date.now() - args.started

  if (args.probeResult.ok) {
    const tools: DiscoveredMcpTool[] = args.probeResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.inputSchema },
    }))
    return mcpConnectionDiscoverResponseSchema.parse({
      ok: true,
      durationMs,
      transport: args.transport,
      tools,
      toolCount: args.probeResult.rawToolCount,
      serverVersion: args.probeResult.serverVersion,
      message:
        args.probeResult.rawToolCount === 0
          ? 'connected but server advertised no tools'
          : `connected · ${args.probeResult.rawToolCount} tool(s)`,
    })
  }

  return mcpConnectionDiscoverResponseSchema.parse({
    ok: false,
    durationMs,
    transport: args.transport,
    code: args.probeResult.code satisfies McpConnectionDiscoverErrorCode,
    message: sanitizeMessage(args.probeResult.message, args.plaintextValues),
  })
}

/**
 * Redact any decrypted plaintext from the message we're about to return.
 * Matches the LLM provider's `sanitizeMessage` posture — belt-and-braces
 * against a future MCP SDK version that echoes `env`/`headers` in an
 * error. ≥8 chars avoids collapsing short placeholder values like
 * "Bearer" that might legitimately show up in a diagnostic.
 */
function sanitizeMessage(
  message: string,
  plaintexts: readonly string[],
): string {
  let out = message
  for (const p of plaintexts) {
    if (!p || p.length < 8) continue
    out = out.split(p).join('«redacted»')
  }
  return out
}
