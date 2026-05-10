/**
 * One-shot MCP tool-discovery probe — Phase 4b.
 *
 * Mastra-facing helper that backs `POST /api/mcp-connections/:id/test`.
 * Spawns a throwaway `@mastra/mcp` `MCPClient`, calls `listTools()` on
 * the shape the MCP spec promises, tears the client down, and returns a
 * plain-object result.
 *
 * Boundary rationale:
 *   - This file lives in `packages/agents` because the root ESLint guard
 *     rail forbids `@mastra/*` imports outside this package (see
 *     `eslint.config.mjs`). The backend's `lib/mcp-connections/discover.ts`
 *     is the dispatcher — it owns the decrypt + DB + wire-shape, and
 *     calls into this helper with already-plaintext credentials.
 *   - Unlike `mountExternalMcps`, discovery is NOT tied to an agent or a
 *     run — it's a per-request probe. Accepting plaintext directly keeps
 *     the decrypt site in one place (the backend dispatcher) and keeps
 *     this module stateless and testable without DB or encryption deps.
 *
 * Failure taxonomy matches `McpConnectionDiscoverErrorCode` in
 * `@agent-bridge/shared`:
 *   - `spawn_failed`  — stdio child couldn't start or exited immediately.
 *   - `unreachable`   — http URL DNS/connect failed, SSE stream never
 *                       opened.
 *   - `auth`          — upstream returned 401/403 OR the handshake error
 *                       mentions an authentication failure.
 *   - `timeout`       — listTools() ran past the connect+request budget.
 *   - `unknown`       — anything we can't classify above.
 */

import { auth, MCPClient, MCPOAuthClientProvider } from '@mastra/mcp'
import { FixedMCPOAuthClientProvider } from './oauth-provider-fix.js'
import type { OAuthStorage } from '@mastra/mcp'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import type { McpTransport } from '@agent-bridge/shared'

// ─── Public surface ──────────────────────────────────────────────────────

export type DiscoverErrorCode =
  | 'unreachable'
  | 'auth'
  | 'spawn_failed'
  | 'timeout'
  | 'unknown'

export interface DiscoverProbeInput {
  readonly transport: McpTransport
  /** stdio: absolute command path; http/sse: absolute URL. */
  readonly commandOrUrl: string
  readonly args: readonly string[]
  /** Plaintext env map for stdio. Ignored by http/sse. */
  readonly env: Readonly<Record<string, string>> | null
  /** Plaintext header map for http/sse. Ignored by stdio. */
  readonly headers: Readonly<Record<string, string>> | null
  /** stdio only — reuse the operator's real HOME. */
  readonly allowHostHome: boolean
  /**
   * Budget for the handshake + `listTools()`. Defaults to 15s — big
   * enough for a cold Python MCP, small enough that a misconfigured URL
   * doesn't hang the UI.
   */
  readonly timeoutMs?: number
}

export interface DiscoveredProbeTool {
  readonly name: string
  readonly description: string | null
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export type DiscoverProbeResult =
  | {
      readonly ok: true
      readonly tools: readonly DiscoveredProbeTool[]
      readonly serverVersion: string | null
      /** Raw listTools response count, for the dispatcher's `toolCount`. */
      readonly rawToolCount: number
    }
  | {
      readonly ok: false
      readonly code: DiscoverErrorCode
      readonly message: string
    }

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Probe an MCP connection. Never throws — every failure path returns a
 * classified `ok: false` result so the dispatcher can stamp a clean
 * envelope. Always tears down the client in `finally`.
 */
export async function discoverMcpTools(
  input: DiscoverProbeInput,
): Promise<DiscoverProbeResult> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let serverDef: ServerDef
  try {
    serverDef = buildServerDef(input)
  } catch (err) {
    return {
      ok: false,
      code: 'unknown',
      message: errMsg(err),
    }
  }

  // Per-call ID keeps MCPClient's internal cache from colliding when
  // the UI fires discover calls back-to-back with the same config.
  const client = new MCPClient({
    id: `discover-${cryptoRandom()}`,
    servers: { ext: serverDef },
    timeout,
  })

  try {
    // `listToolsets()` returns `{ [serverName]: { [rawName]: Tool } }`
    // without the SDK's default prefix — matches what we do in
    // `mountExternalMcps`, so the dispatcher's raw-name list and the
    // runtime's raw-name expectations stay in sync.
    const toolsets = await client.listToolsets()
    const raw = toolsets.ext ?? {}

    // The Tool object carries `description` and `inputSchema`, but the
    // shape is Mastra's (wraps MCP's). We peel just the pieces the UI
    // renders and the picker sends back to PUT allowlist.
    const tools: DiscoveredProbeTool[] = Object.entries(raw).map(
      ([name, tool]) => ({
        name,
        description: extractDescription(tool),
        inputSchema: extractInputSchema(tool),
      }),
    )

    return {
      ok: true,
      tools,
      rawToolCount: tools.length,
      // Mastra doesn't surface serverVersion on listToolsets; leave null
      // for now. Add later if we plumb `client.getServerVersion()` out.
      serverVersion: null,
    }
  } catch (err) {
    return classifyProbeError(err, input.transport)
  } finally {
    await safeDisconnect(client)
  }
}

// ─── OAuth-aware probe ───────────────────────────────────────────────────

/**
 * Input for the OAuth-aware probe path. HTTP-only — stdio MCPs don't
 * speak the MCP auth spec.
 *
 * Two modes:
 *   - `authorizationCode` absent → start the flow. Returns `authorized`
 *     if tokens already cached on `storage`, or `redirect` with the
 *     authorize URL if the provider needs the user.
 *   - `authorizationCode` present → finish the flow. Exchanges the
 *     code for tokens via the provider, persists them to storage, and
 *     (on success) runs `listToolsets()` so the caller can return the
 *     tool list in the same turn.
 */
export interface DiscoverOAuthProbeInput {
  readonly transport: 'http' | 'sse'
  /** Absolute MCP server URL (e.g. `https://mcp.notion.com/mcp`). */
  readonly serverUrl: string
  /**
   * Where the upstream authorization server will send the user back
   * after they approve. Must be a URL our backend owns; Notion pins
   * this at dynamic-client-registration time, so it's crucial that
   * the value here matches the `redirect_uris` in `clientMetadata`.
   */
  readonly redirectUrl: string
  /** OAuth 2.0 client metadata used for dynamic registration (RFC 7591). */
  readonly clientMetadata: ConstructorParameters<
    typeof MCPOAuthClientProvider
  >[0]['clientMetadata']
  /**
   * Persistent key/value store for provider state (tokens, client
   * info, code verifier). Hand in a `DrizzleOAuthStorage` scoped to
   * the connection.
   */
  readonly storage: OAuthStorage
  /** Per-call budget for the handshake + listToolsets. */
  readonly timeoutMs?: number
  /**
   * Present on the callback turn. When set, the probe exchanges this
   * code for tokens before attempting `listToolsets()`.
   */
  readonly authorizationCode?: string
}

export type DiscoverOAuthProbeResult =
  | {
      readonly ok: true
      readonly kind: 'authorized'
      readonly tools: readonly DiscoveredProbeTool[]
      readonly serverVersion: string | null
      readonly rawToolCount: number
    }
  | {
      readonly ok: true
      readonly kind: 'redirect'
      /** URL the UI should open in a new tab. */
      readonly authorizeUrl: string
      /** The OAuth `state` parameter the provider generated. Used by
       *  the callback route as a CSRF guard — see the session
       *  registry's `matchOauthState`. */
      readonly oauthState: string
    }
  | {
      readonly ok: false
      readonly code: DiscoverErrorCode
      readonly message: string
    }

/**
 * OAuth-aware probe. Stateless from the MCPClient's perspective — all
 * cross-request state lives in `input.storage`. Build a provider,
 * call `auth()`, and either return the authorize URL or proceed to
 * `listToolsets()`.
 *
 * Never throws.
 */
export async function discoverMcpToolsOAuth(
  input: DiscoverOAuthProbeInput,
): Promise<DiscoverOAuthProbeResult> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let redirectedTo: URL | null = null
  const provider = new FixedMCPOAuthClientProvider({
    redirectUrl: input.redirectUrl,
    clientMetadata: input.clientMetadata,
    storage: input.storage,
    onRedirectToAuthorization: (url) => {
      // Stash the URL for the caller; don't open a browser here — the
      // UI opens it in a new tab via the HTTP response.
      redirectedTo = url
    },
  })

  try {
    const result = await auth(provider, {
      serverUrl: input.serverUrl,
      authorizationCode: input.authorizationCode,
    })

    if (result === 'REDIRECT') {
      if (!redirectedTo) {
        // Shouldn't happen if Mastra's contract holds, but fail loud
        // if it does — treating REDIRECT as success without a URL
        // would strand the user.
        return {
          ok: false,
          code: 'unknown',
          message:
            'OAuth provider reported REDIRECT but did not surface an authorize URL',
        }
      }
      // `state` is stored in the provider's `saveCodeVerifier` /
      // storage side-effects; we pull it back out of the authorize
      // URL so the callback route can CSRF-check it without duplicate
      // state management.
      const state = (redirectedTo as URL).searchParams.get('state') ?? ''
      return {
        ok: true,
        kind: 'redirect',
        authorizeUrl: (redirectedTo as URL).toString(),
        oauthState: state,
      }
    }

    // AUTHORIZED — tokens are in storage. Build a client and list.
    const client = new MCPClient({
      id: `discover-oauth-${cryptoRandom()}`,
      servers: {
        ext: {
          url: new URL(input.serverUrl),
          authProvider: provider,
        },
      },
      timeout,
    })

    try {
      const toolsets = await client.listToolsets()
      const raw = toolsets.ext ?? {}
      const tools: DiscoveredProbeTool[] = Object.entries(raw).map(
        ([name, tool]) => ({
          name,
          description: extractDescription(tool),
          inputSchema: extractInputSchema(tool),
        }),
      )
      return {
        ok: true,
        kind: 'authorized',
        tools,
        rawToolCount: tools.length,
        serverVersion: null,
      }
    } finally {
      await safeDisconnect(client)
    }
  } catch (err) {
    return classifyProbeError(err, input.transport)
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

type ServerDef = ConstructorParameters<typeof MCPClient>[0]['servers'][string]

function buildServerDef(input: DiscoverProbeInput): ServerDef {
  if (input.transport === 'http' || input.transport === 'sse') {
    const url = new URL(input.commandOrUrl)
    return {
      url,
      requestInit: {
        headers: input.headers ?? {},
      },
    }
  }

  // stdio — identical sandbox baseline as `mountExternalMcps` so the
  // probe's child env matches runtime exactly.
  const sandboxedBase = compactEnv(
    buildSandboxedEnv({
      sandbox: 'mcp-stdio',
      allowHostHome: input.allowHostHome,
    }),
  )
  const env: Record<string, string> = {
    ...sandboxedBase,
    ...(input.env ?? {}),
  }

  return {
    command: input.commandOrUrl,
    args: [...input.args],
    env,
    stderr: 'pipe',
  }
}

/**
 * Narrowed return type so the same helper can populate the error arm
 * of both the non-OAuth `DiscoverProbeResult` and the OAuth-aware
 * `DiscoverOAuthProbeResult`. Both unions share this shape exactly.
 */
type ProbeErrorArm = {
  readonly ok: false
  readonly code: DiscoverErrorCode
  readonly message: string
}

function classifyProbeError(
  err: unknown,
  transport: McpTransport,
): ProbeErrorArm {
  const message = errMsg(err)
  const lower = message.toLowerCase()

  // Stdio-specific failure signals from @modelcontextprotocol/sdk's
  // `StdioClientTransport`. A missing / unexecutable command usually
  // surfaces as "spawn … ENOENT" or "spawn … EACCES".
  if (transport === 'stdio') {
    if (/spawn .*(enoent|eacces|enotdir)/i.test(message)) {
      return { ok: false, code: 'spawn_failed', message }
    }
    if (/exited with code/i.test(message)) {
      return { ok: false, code: 'spawn_failed', message }
    }
  }

  if (lower.includes('401') || /unauthor/i.test(lower)) {
    return { ok: false, code: 'auth', message }
  }
  if (lower.includes('403') || /forbidden/i.test(lower)) {
    return { ok: false, code: 'auth', message }
  }
  if (
    /timeout|timed out|aborted/i.test(lower) ||
    /requesttimeout/i.test(lower)
  ) {
    return { ok: false, code: 'timeout', message }
  }
  if (
    /enotfound|econnrefused|econnreset|unreachable|ehostunreach/i.test(lower)
  ) {
    return { ok: false, code: 'unreachable', message }
  }

  return { ok: false, code: 'unknown', message }
}

function extractDescription(tool: unknown): string | null {
  if (!isRecord(tool)) return null
  const desc = tool['description']
  return typeof desc === 'string' && desc.length > 0 ? desc : null
}

function extractInputSchema(tool: unknown): Record<string, unknown> {
  if (!isRecord(tool)) return {}
  // Mastra's `createTool` converts the upstream JSON schema into a Zod
  // schema internally, but the original JSON schema is kept on the
  // wrapping object under `inputSchema` (sometimes as Zod, sometimes
  // raw). We don't need a strict type here — the UI will render it
  // best-effort and fall back to "no arguments" when nothing is shaped.
  const schema = tool['inputSchema']
  return isRecord(schema) ? schema : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

async function safeDisconnect(client: MCPClient): Promise<void> {
  try {
    await client.disconnect()
  } catch {
    // Swallow — teardown failures must not mask the original
    // classification. Same discipline as mountExternalMcps.
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Short random suffix for the MCPClient id. `crypto.randomUUID()` would
 * work but pulling `node:crypto` for one id is overkill — 8 hex chars
 * off `Math.random` are enough to avoid collisions for the tiny
 * handful of in-flight probes any single backend will see at once.
 */
function cryptoRandom(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
}
