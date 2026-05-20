/**
 * Lightweight liveness probe for the operator's configured embedding
 * endpoint. Used by:
 *
 *   - `POST /api/repos/:id/clone` — fail fast when the embedder is down
 *     so the user doesn't watch a clone succeed and then immediately
 *     watch the auto-chained index fall over with a cryptic
 *     `gitnexus analyze` error.
 *   - `POST /api/repos/:id/index` — same intent, narrower window.
 *   - Worker `index-repo` job — defence in depth in case the endpoint
 *     went down between enqueue and dequeue.
 *
 * Mechanism: POST a single-token `input: 'ping'` to `<baseUrl>/embeddings`
 * — the same shape gitnexus's embedding pipeline will use moments later.
 * Validates network reachability, endpoint existence, auth, and model
 * id in one call. Cost is one tiny embedding (negligible vs. the index
 * pass it's gating).
 *
 * Failures throw a typed error so the caller can render an appropriate
 * remediation message. Module is Node-only (uses global `fetch` /
 * `AbortSignal.timeout`, which are present in Node ≥ 18 — the project
 * already requires ≥ 24).
 */

export type EmbedderProbeErrorKind =
  | 'unreachable'
  | 'auth'
  | 'bad_model'
  | 'timeout'
  | 'unknown'

export class EmbedderProbeError extends Error {
  readonly kind: EmbedderProbeErrorKind
  /** HTTP status from the server, or `null` if the request never
   *  produced a response (DNS, TCP, TLS, timeout, …). */
  readonly status: number | null
  /** Truncated response body, useful for diagnostics on the UI
   *  when the failure is a 4xx/5xx with a structured error message. */
  readonly responseBody: string
  constructor(
    message: string,
    kind: EmbedderProbeErrorKind,
    status: number | null,
    responseBody: string,
  ) {
    super(message)
    this.name = 'EmbedderProbeError'
    this.kind = kind
    this.status = status
    this.responseBody = responseBody
  }
}

export interface ProbeEmbedderArgs {
  readonly baseUrl: string
  readonly model: string
  /** Optional bearer token; passed through verbatim. */
  readonly apiKey: string | null
  /** Bound on the request. Defaults to 8s — local embedders should
   *  respond in <1s, hosted ones in <2s. Anything past 8s is a hang. */
  readonly timeoutMs?: number
}

/**
 * Hit `<baseUrl>/embeddings` with a one-token input. Returns `void`
 * on a 2xx; throws `EmbedderProbeError` on anything else.
 *
 * `baseUrl` is expected to already include the OpenAI-style `/v1`
 * suffix (matches how the worker builds `GITNEXUS_EMBEDDING_URL` for
 * gitnexus). The probe appends `/embeddings`.
 */
export async function probeEmbedder(args: ProbeEmbedderArgs): Promise<void> {
  const { baseUrl, model, apiKey, timeoutMs = 8_000 } = args
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: 'ping' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || /timeout|timed out/i.test(err.message))
    throw new EmbedderProbeError(
      isTimeout
        ? `embedding endpoint ${endpoint} did not respond within ${timeoutMs}ms`
        : `couldn't reach embedding endpoint ${endpoint}: ${message}`,
      isTimeout ? 'timeout' : 'unreachable',
      null,
      '',
    )
  }

  if (res.ok) return

  const body = await res.text().catch(() => '')
  const kind: EmbedderProbeErrorKind =
    res.status === 401 || res.status === 403
      ? 'auth'
      : res.status === 404 || /model/i.test(body)
        ? 'bad_model'
        : 'unknown'

  const message =
    kind === 'auth'
      ? `embedding endpoint rejected the API key (${res.status})`
      : kind === 'bad_model'
        ? `embedding endpoint doesn't recognise model "${model}" (${res.status})`
        : `embedding endpoint returned ${res.status}`

  throw new EmbedderProbeError(message, kind, res.status, body.slice(0, 400))
}

/**
 * Map an `LlmProviderRow`-shaped `{ baseUrl, kind, defaultModel,
 * embeddingDims, apiKeyPlaintext }` tuple to a probe input, applying
 * the same vendor-baseUrl fallback the worker's index-repo job uses
 * (`https://api.openai.com` when `kind='openai'` and no override).
 *
 * Returns `null` when there's nothing to probe (no `defaultModel`, or
 * no `baseUrl` and no vendor default) — same short-circuit policy as
 * `buildEmbeddingEnv` in the worker. Callers treat `null` as "no
 * probe needed" rather than "probe passed."
 */
export function buildEmbedderProbeArgs(input: {
  readonly kind: string
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly apiKey: string | null
}): ProbeEmbedderArgs | null {
  if (!input.defaultModel) return null

  // Vendor-baseUrl fallback table. Kept tiny on purpose — new vendors
  // get added in lockstep across the worker (index/wiki jobs) and the
  // agent builder. See worker/src/jobs/index-repo.ts:EMBEDDING_VENDOR_BASE_URL.
  const VENDOR_BASE_URLS: Record<string, string> = {
    openai: 'https://api.openai.com',
  }

  const raw = input.baseUrl ?? VENDOR_BASE_URLS[input.kind] ?? null
  if (!raw) return null
  const trimmed = raw.replace(/\/+$/, '')
  const url = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`

  return {
    baseUrl: url,
    model: input.defaultModel,
    apiKey: input.apiKey,
  }
}
