/**
 * Refresh-models dispatcher.
 *
 * Mirrors the shape of `test-provider.ts` but with a narrower job:
 * fetch `/v1/models` from the configured provider and return the list of
 * model ids verbatim. Like the test path, this is a single-decrypt site —
 * the saved apiKey envelope only crosses the encryption boundary inside
 * `resolveConfig` here, never leaks into a returned message, and is
 * passed through `sanitizeMessage` if a fetch exception bubbles up.
 *
 * The taxonomy is a strict subset of the test endpoint's: no
 * `invalid_model` (we're not naming a model), and we don't run a
 * completion. Otherwise: `unreachable | auth | rate_limited | upstream
 * | timeout | unknown`. Successful response carries a fresh
 * `LlmProviderModelsCache` payload (model ids + ISO timestamp) for the
 * route handler to persist on `llm_providers.models_json`.
 *
 * Tolerant parsing: the upstream response is the OpenAI shape `{ data:
 * [{ id: string, … }, …] }`, but we also accept Ollama's `{ models:
 * [{ name: string }] }` since some compat shims fall back to it. We
 * de-duplicate while preserving order so the dropdown stays
 * deterministic across refreshes.
 */

import { decryptSecret } from '@agent-bridge/shared/crypto'
import type {
  LlmProviderKind,
  LlmProviderRefreshModelsInput,
  LlmProviderRefreshModelsResponse,
} from '@agent-bridge/shared'
import {
  classifyFetchError,
  classifyHttpError,
  joinUrl,
  REQUEST_TIMEOUT_MS,
  type ConnectorResult,
} from './types.js'
import type { StoredProvider } from './test-provider.js'

const VENDOR_BASE_URLS: Record<LlmProviderKind, string | null> = {
  openai: 'https://api.openai.com',
  llama_cpp: null,
  ollama: null,
  openai_compatible: null,
}

export async function refreshProviderModels(
  stored: StoredProvider,
  override: LlmProviderRefreshModelsInput,
): Promise<LlmProviderRefreshModelsResponse> {
  const { kind } = stored
  const started = Date.now()

  const resolved = resolveConfig(stored, override)
  if (!resolved.ok) {
    return {
      ok: false,
      kind,
      durationMs: Date.now() - started,
      code: 'unknown',
      message: resolved.message,
    }
  }

  const { baseUrl, apiKey } = resolved.value

  let models: string[]
  try {
    const result = await fetchModels({ baseUrl, apiKey })
    if (!result.ok) {
      // Map the test-taxonomy `invalid_model` (which `classifyHttpError`
      // can produce for 404s with "model" in the body) to `upstream`
      // — the refresh path doesn't have a per-model concept.
      const code: LlmProviderRefreshModelsResponse extends infer R
        ? R extends { ok: false; code: infer C }
          ? C
          : never
        : never =
        result.code === 'invalid_model' ? 'upstream' : result.code
      return {
        ok: false,
        kind,
        durationMs: Date.now() - started,
        code,
        message: sanitizeMessage(result.message, apiKey),
      }
    }
    models = result.models
  } catch (err) {
    return {
      ok: false,
      kind,
      durationMs: Date.now() - started,
      code: 'unknown',
      message: sanitizeMessage(
        err instanceof Error ? err.message : 'unknown error',
        apiKey,
      ),
    }
  }

  return {
    ok: true,
    kind,
    durationMs: Date.now() - started,
    models: {
      models,
      fetchedAt: new Date().toISOString(),
    },
  }
}

// ─── Wire fetch ──────────────────────────────────────────────────────────

interface FetchOk {
  readonly ok: true
  readonly models: string[]
}

type FetchModelsResult =
  | FetchOk
  | (Extract<ConnectorResult, { ok: false }> & { models?: never })

async function fetchModels(input: {
  baseUrl: string
  apiKey: string | null
}): Promise<FetchModelsResult> {
  const url = joinUrl(input.baseUrl, '/v1/models')
  const headers: Record<string, string> = {}
  if (input.apiKey) headers['authorization'] = `Bearer ${input.apiKey}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return narrowToFailure(classifyFetchError(err))
  }

  if (!res.ok) {
    let body: string
    try {
      body = (await res.text()).slice(0, 512)
    } catch {
      body = ''
    }
    return narrowToFailure(classifyHttpError(res.status, body))
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return {
      ok: false,
      code: 'upstream',
      message: 'non-JSON response from /v1/models',
    }
  }

  const models = parseModels(payload)
  if (models === null) {
    return {
      ok: false,
      code: 'upstream',
      message: 'unexpected /v1/models response shape',
    }
  }

  return { ok: true, models }
}

/**
 * Both `classifyFetchError` and `classifyHttpError` are typed to return
 * the full `ConnectorResult` union (test-suite reasons), but in their
 * call sites here we only ever invoke them on a failed fetch / non-2xx
 * response — i.e. `ok: false`. This narrows the return so the
 * `FetchModelsResult` callers don't have to reason about a stray
 * `ok: true` branch.
 */
function narrowToFailure(result: ConnectorResult): FetchModelsResult {
  if (result.ok) {
    // Should be unreachable — both classifiers above are documented to
    // return only failure cases. Treat as unknown rather than letting
    // a misclassification escape silently.
    return {
      ok: false,
      code: 'unknown',
      message: 'classifier returned a success result on the failure path',
    }
  }
  return result
}

/**
 * Parse the OpenAI-shaped `{ data: [{ id }] }` first, fall back to
 * Ollama's `{ models: [{ name }] }`. De-duplicate while preserving the
 * upstream order so re-running refresh yields a stable dropdown order
 * even if the provider re-orders rows.
 */
function parseModels(payload: unknown): string[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const obj = payload as Record<string, unknown>

  const out: string[] = []
  const seen = new Set<string>()

  const data = obj['data']
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry && typeof entry === 'object') {
        const id = (entry as Record<string, unknown>)['id']
        if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
          seen.add(id)
          out.push(id)
        }
      }
    }
  }

  // Ollama-compat fallback. Only consulted if `data` was missing/empty.
  if (out.length === 0) {
    const models = obj['models']
    if (Array.isArray(models)) {
      for (const entry of models) {
        if (entry && typeof entry === 'object') {
          const name = (entry as Record<string, unknown>)['name']
          if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
            seen.add(name)
            out.push(name)
          }
        }
      }
    }
  }

  return out
}

// ─── Configuration resolution ────────────────────────────────────────────

type ResolvedConfig =
  | { ok: true; value: { baseUrl: string; apiKey: string | null } }
  | { ok: false; message: string }

function resolveConfig(
  stored: StoredProvider,
  override: LlmProviderRefreshModelsInput,
): ResolvedConfig {
  const rawBaseUrl =
    override.baseUrl !== undefined ? override.baseUrl : stored.baseUrl
  const vendorDefault = VENDOR_BASE_URLS[stored.kind]
  const baseUrl = rawBaseUrl ?? vendorDefault
  if (!baseUrl) {
    return {
      ok: false,
      message:
        `baseUrl is required for kind="${stored.kind}" but neither the ` +
        `saved row nor the override body specifies one`,
    }
  }

  const apiKeyInput = override.apiKey
  let apiKey: string | null
  if (!apiKeyInput || apiKeyInput.action === 'unchanged') {
    apiKey = stored.apiKeyEnvelope
      ? decryptSecret(stored.apiKeyEnvelope)
      : null
  } else if (apiKeyInput.action === 'clear') {
    apiKey = null
  } else {
    apiKey = apiKeyInput.plaintext
  }

  return { ok: true, value: { baseUrl, apiKey } }
}

function sanitizeMessage(message: string, plaintext: string | null): string {
  if (!plaintext || plaintext.length < 8) return message
  return message.split(plaintext).join('«redacted»')
}
