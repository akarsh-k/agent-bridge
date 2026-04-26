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
import type { ErrorCode } from '@agent-bridge/shared'

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
