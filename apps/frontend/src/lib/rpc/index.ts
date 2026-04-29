/**
 * Typed HTTP client for the backend.
 *
 * `rpc`  — Hono's `hc<AppType>` client. End-to-end typed; the AppType is
 *          imported from the backend workspace so refactors propagate.
 *
 * `callApi` — Small wrapper around a Hono RPC call that:
 *             1. awaits the Response
 *             2. parses JSON
 *             3. returns the success payload typed OR throws `ApiError`
 *               with the backend's `{ code, message, details? }` envelope
 *
 * Never use `fetch()` or the `rpc` client directly from components — always
 * go through `callApi` so we have a single choke point for error shape,
 * logging, and future concerns (timeouts, retries, auth headers).
 */

import { hc } from 'hono/client'
import type { AppType } from 'backend'
import type {
  AgentExportBundle,
  AgentImportInput,
  AgentImportResponse,
  BridgeToolCreateInput,
  BridgeToolResponse,
  BridgeToolUpdateInput,
  ErrorCode,
  LlmProviderRefreshModelsInput,
  LlmProviderRefreshModelsResponse,
  LlmProviderTestInput,
  LlmProviderTestResponse,
  McpConnectionDiscoverInput,
  McpConnectionDiscoverResponse,
  McpConnectionTestPollResponse,
} from '@agent-bridge/shared'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

function resolveBaseUrl(): string {
  const raw = import.meta.env.VITE_API_URL?.trim()
  if (!raw) return DEFAULT_BASE_URL
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${url.protocol}`)
    }
    if (import.meta.env.PROD && url.protocol !== 'https:') {
      console.warn(
        `[rpc] VITE_API_URL is not HTTPS in a production build: ${raw}`,
      )
    }
    return url.origin + (url.pathname === '/' ? '' : url.pathname)
  } catch (err) {
    throw new Error(
      `[rpc] Invalid VITE_API_URL ${JSON.stringify(raw)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    )
  }
}

/**
 * Origin + base path for the backend HTTP API. Exposed so the handful of
 * call sites that can't use `hc<AppType>` (sub-routers mounted twice, SSE,
 * etc.) share the same resolution as `rpc`.
 */
export const apiBaseUrl: string = resolveBaseUrl()

export const rpc = hc<AppType>(apiBaseUrl)

/**
 * Thrown by `callApi` on non-2xx responses. Carries the backend's structured
 * error envelope so callers can branch on `code` (e.g. render uniqueness
 * errors next to a field).
 *
 * `details` is the raw validation payload from the backend; callers should
 * treat it as opaque and render it defensively.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'network' | 'malformed_response'
  readonly status: number
  readonly details: unknown

  constructor(params: {
    code: ErrorCode | 'network' | 'malformed_response'
    status: number
    message: string
    details?: unknown
  }) {
    super(params.message)
    this.name = 'ApiError'
    this.code = params.code
    this.status = params.status
    this.details = params.details
  }
}

/**
 * Awaits a Hono RPC response, narrows on the success envelope, and throws
 * `ApiError` otherwise. Generic so callers get the concrete payload type
 * back (e.g. `{ agent: AgentResponse }`), not `unknown`.
 *
 * Example:
 *   const { agent } = await callApi(rpc.api.agents.$post({ json: body }))
 */
export async function callApi<T extends { ok: true }>(
  request: Promise<Response>,
): Promise<T> {
  let res: Response
  try {
    res = await request
  } catch (err) {
    throw new ApiError({
      code: 'network',
      status: 0,
      message:
        err instanceof Error
          ? `Network error: ${err.message}`
          : 'Network error',
    })
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new ApiError({
      code: 'malformed_response',
      status: res.status,
      message: `Expected JSON from ${res.url} (HTTP ${res.status})`,
    })
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('ok' in parsed) ||
    typeof (parsed as { ok: unknown }).ok !== 'boolean'
  ) {
    throw new ApiError({
      code: 'malformed_response',
      status: res.status,
      message: 'Response did not match the API envelope shape',
      details: parsed,
    })
  }

  const envelope = parsed as
    | { ok: true; [k: string]: unknown }
    | { ok: false; error?: { code?: string; message?: string; details?: unknown } }

  if (envelope.ok === false) {
    const err = envelope.error ?? {}
    throw new ApiError({
      code: (err.code as ErrorCode | undefined) ?? 'internal',
      status: res.status,
      message: err.message ?? `HTTP ${res.status}`,
      details: err.details,
    })
  }

  return envelope as T
}

// ─── Repo job helpers ────────────────────────────────────────────────────
//
// `POST /api/repos/:id/clone` and `POST /api/repos/:id/index` are mounted
// on a secondary sub-router (`repoJobsRouter`). Hono's `hc<AppType>` infers
// only the last `.route(...)` call for a given mount-point, so these paths
// aren't reachable through the typed client. These helpers go through
// `callApi` for error handling while still using raw `fetch` for the URL.

export interface RepoJobStartResponse {
  readonly jobId: string
  readonly streamId: string
}

export async function cloneRepo(
  repoId: string,
): Promise<RepoJobStartResponse> {
  const res = await callApi<{ ok: true } & RepoJobStartResponse>(
    fetch(`${apiBaseUrl}/api/repos/${encodeURIComponent(repoId)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  return { jobId: res.jobId, streamId: res.streamId }
}

export async function indexRepo(
  repoId: string,
): Promise<RepoJobStartResponse> {
  const res = await callApi<{ ok: true } & RepoJobStartResponse>(
    fetch(`${apiBaseUrl}/api/repos/${encodeURIComponent(repoId)}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  return { jobId: res.jobId, streamId: res.streamId }
}

/**
 * Kick off a `gitnexus wiki` run for the repo. The caller picks which LLM
 * provider charges for this run and may override the model per-call;
 * the backend falls back to `provider.default_model` when `model` is
 * omitted. `force` skips the up-to-date short-circuit (regenerates every
 * page even if nothing changed).
 */
export async function generateRepoWiki(
  repoId: string,
  body: { llmProviderId: string; model?: string; force?: boolean },
): Promise<RepoJobStartResponse> {
  const res = await callApi<{ ok: true } & RepoJobStartResponse>(
    fetch(`${apiBaseUrl}/api/repos/${encodeURIComponent(repoId)}/wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { jobId: res.jobId, streamId: res.streamId }
}

/** Absolute URL for the bundled wiki HTML viewer for a given repo. */
export function repoWikiViewerUrl(repoId: string): string {
  return `${apiBaseUrl}/api/repos/${encodeURIComponent(repoId)}/wiki/index.html`
}

// ─── Agent export / import helpers ───────────────────────────────────────

export async function exportAgentBundle(
  agentId: string,
): Promise<AgentExportBundle> {
  const res = await callApi<{ ok: true; bundle: AgentExportBundle }>(
    fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/export`,
      { method: 'GET' },
    ),
  )
  return res.bundle
}

export async function importAgentBundle(
  input: AgentImportInput,
): Promise<AgentImportResponse> {
  return callApi<AgentImportResponse>(
    fetch(`${apiBaseUrl}/api/agents/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

// ─── Bridge tools (Phase 7) ──────────────────────────────────────────────

export async function listBridgeTools(
  agentId: string,
): Promise<readonly BridgeToolResponse[]> {
  const res = await callApi<{
    ok: true
    bridgeTools: readonly BridgeToolResponse[]
  }>(
    fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/bridge-tools`,
      { method: 'GET' },
    ),
  )
  return res.bridgeTools
}

export async function createBridgeTool(
  agentId: string,
  input: BridgeToolCreateInput,
): Promise<BridgeToolResponse> {
  const res = await callApi<{ ok: true; bridgeTool: BridgeToolResponse }>(
    fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/bridge-tools`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),
  )
  return res.bridgeTool
}

export async function patchBridgeTool(
  agentId: string,
  id: string,
  patch: BridgeToolUpdateInput,
): Promise<BridgeToolResponse> {
  const res = await callApi<{ ok: true; bridgeTool: BridgeToolResponse }>(
    fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/bridge-tools/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),
  )
  return res.bridgeTool
}

export async function deleteBridgeTool(
  agentId: string,
  id: string,
): Promise<void> {
  await callApi<{ ok: true; id: string }>(
    fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/bridge-tools/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  )
}

// ─── Bridge view helpers ─────────────────────────────────────────────────

export interface BridgeConfigResponse {
  readonly command: string
  readonly args: readonly string[]
  /**
   * Env vars the IDE must set when spawning the bridge. Empty in prod;
   * dev injects `NODE_OPTIONS=--conditions=development` so workspace
   * imports resolve to each package's `src/`.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * `true` when the resolved command + args are runnable on this
   * machine right now. `false` if the bridge isn't built (prod) or
   * tsx isn't installed (dev). UI warns before the operator pastes.
   */
  readonly ready: boolean
  /** Human-readable hint when `ready=false`; `null` otherwise. */
  readonly readyHint: string | null
  /** Pre-formatted JSON for paste-into-mcp.json. */
  readonly configBlock: string
}

/**
 * Fetch the paste-ready MCP server config for the IDE bridge. The
 * backend resolves absolute paths from its filesystem so the operator
 * doesn't have to hand-craft the path to `apps/mcp-bridge/src/index.ts`.
 *
 * The resolved command is **always** an absolute node binary path so
 * the IDE doesn't need anything on its `PATH` to spawn the bridge —
 * desktop IDEs (Cursor, Claude Code) typically run with a stripped
 * `PATH` and would otherwise hit `spawn tsx ENOENT`.
 */
export async function getBridgeConfig(): Promise<BridgeConfigResponse> {
  const res = await callApi<{ ok: true } & BridgeConfigResponse>(
    fetch(`${apiBaseUrl}/api/bridge/config`),
  )
  return {
    command: res.command,
    args: res.args,
    env: res.env,
    ready: res.ready,
    readyHint: res.readyHint,
    configBlock: res.configBlock,
  }
}

/**
 * Fetch the global runs feed. Powers the bridge view (filters
 * `source=bridge`) and a future UI-runs view (`source=ui`).
 */
export async function listRuns(
  query: {
    readonly source?: 'ui' | 'bridge'
    readonly limit?: number
    readonly agentId?: string
  } = {},
): Promise<import('@agent-bridge/shared').RunListResponse> {
  const params = new URLSearchParams()
  if (query.source) params.set('source', query.source)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.agentId) params.set('agentId', query.agentId)
  const qs = params.toString()
  const url =
    `${apiBaseUrl}/api/runs` + (qs.length > 0 ? `?${qs}` : '')

  // The runs router is a sub-router off the secondary `.route('/runs',
  // runsRouter)` mount, so `hc<AppType>` doesn't surface its types
  // (same Hono-mount limitation as the repo-jobs helpers above).
  // We type the response via a cast on `callApi`'s generic.
  const res = await callApi<
    { ok: true } & import('@agent-bridge/shared').RunListResponse
  >(fetch(url))
  return { ok: true, runs: res.runs }
}

// ─── LLM provider helpers ────────────────────────────────────────────────

/**
 * Kick off a live smoke test of an LLM provider. `overrides` is optional
 * — the saved row is used by default. When present, any subset of
 * `baseUrl` / `defaultModel` / `apiKey` overrides that field for this one
 * call (not persisted). Used by both the read-only inspector (no
 * overrides) and the future edit-draft flow.
 */
export async function testLlmProvider(
  id: string,
  overrides: LlmProviderTestInput = {},
): Promise<LlmProviderTestResponse> {
  const res = await callApi<{ ok: true; result: LlmProviderTestResponse }>(
    rpc.api['llm-providers'][':id'].test.$post({
      param: { id },
      json: overrides,
    }),
  )
  return res.result
}

/**
 * Re-fetch `/v1/models` for the provider and persist the result. Same
 * override pattern as `testLlmProvider` — caller can pass `baseUrl` /
 * `apiKey` to probe an unsaved draft. The response envelope is a
 * discriminated union; the inner `LlmProviderRefreshModelsResponse`
 * carries `{ ok: true, models }` on success or `{ ok: false, code,
 * message }` for reachability/auth failures (those are NOT thrown
 * because the backend wraps them as 200s — only transport errors throw
 * `ApiError`).
 */
export async function refreshLlmProviderModels(
  id: string,
  overrides: LlmProviderRefreshModelsInput = {},
): Promise<LlmProviderRefreshModelsResponse> {
  const res = await callApi<{
    ok: true
    result: LlmProviderRefreshModelsResponse
  }>(
    rpc.api['llm-providers'][':id'].models.refresh.$post({
      param: { id },
      json: overrides,
    }),
  )
  return res.result
}

// ─── MCP connection helpers ──────────────────────────────────────────────

/**
 * Kick off a live discovery probe against an MCP connection. `overrides`
 * is optional — by default the saved row is used. When present, any
 * subset of `commandOrUrl` / `argsJson` / `env` / `headers` /
 * `allowHostHome` overrides that field for this one call (not
 * persisted). Used by both the create/edit drawer (draft overrides) and
 * the per-agent tool picker (no overrides — it just re-discovers).
 */
export async function discoverMcpTools(
  id: string,
  overrides: McpConnectionDiscoverInput = {},
): Promise<McpConnectionDiscoverResponse> {
  const res = await callApi<{
    ok: true
    result: McpConnectionDiscoverResponse
  }>(
    rpc.api['mcp-connections'][':id'].test.$post({
      param: { id },
      json: overrides,
    }),
  )
  return res.result
}

/**
 * Long-poll a Phase-4H OAuth test session. The initial POST /test may
 * return a `code: 'authorize_required'` shell with a `sessionId` and
 * `authorizeUrl`; the UI opens the URL in a new tab and calls this
 * RPC in a loop until the session flips to a terminal status.
 *
 * `lastSeen` is the status the UI last rendered — the server
 * suspends for up to ~25 s while that status still holds, so passing
 * it correctly is what makes the poll loop efficient (no busy-wait).
 */
export async function pollMcpTest(
  id: string,
  sessionId: string,
  lastSeen: 'pending' | 'authorize_required',
): Promise<McpConnectionTestPollResponse> {
  const res = await callApi<{
    ok: true
    result: McpConnectionTestPollResponse
  }>(
    rpc.api['mcp-connections'][':id'].test.poll.$get({
      param: { id },
      query: { sessionId, lastSeen },
    }),
  )
  return res.result
}
