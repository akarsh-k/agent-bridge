/**
 * The only connector. Agent Bridge supports OpenAI-compatible
 * providers only — that covers:
 *
 *   - `openai`            → `https://api.openai.com` (cloud default)
 *   - `llama_cpp`         → user-supplied local/LAN URL
 *                           (`llama-server` exposes `/v1/*`)
 *   - `ollama`            → user-supplied local/LAN URL
 *                           (Ollama ≥0.1.14 exposes `/v1/*`)
 *   - `openai_compatible` → any compat proxy (LiteLLM, vLLM, Azure
 *                           OpenAI-compat, OpenRouter, etc.)
 *
 * Inference path: `POST /v1/chat/completions` with `max_tokens: 8`.
 * Reachability fallback: `GET /v1/models` (no body). Local servers
 * typically return a stub list even without a model loaded, so the
 * fallback is a useful "is the endpoint alive" signal.
 *
 * `apiKey` is sent as `Authorization: Bearer …` when set. Local servers
 * (llama.cpp / Ollama defaults) usually accept anything/nothing, so an
 * unset key is perfectly legal — we just don't add the header.
 *
 * For users who want Anthropic or Gemini: run them behind a compat
 * shim (e.g. LiteLLM) and configure the shim URL under
 * `openai_compatible`. Keeps this connector the only HTTP client in
 * the codebase and keeps the error taxonomy uniform.
 */

import {
  classifyFetchError,
  classifyHttpError,
  joinUrl,
  REQUEST_TIMEOUT_MS,
  SMOKE_MAX_TOKENS,
  SMOKE_PROMPT,
  truncateSample,
  type ConnectorInput,
  type ConnectorResult,
} from './types.js'

export async function testOpenAICompatible(
  input: ConnectorInput,
): Promise<ConnectorResult> {
  if (input.model) {
    return input.capability === 'embedding'
      ? embeddingProbe(input)
      : inferenceProbe(input)
  }
  return reachabilityProbe(input)
}

async function inferenceProbe(input: ConnectorInput): Promise<ConnectorResult> {
  const url = joinUrl(input.baseUrl, '/v1/chat/completions')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (input.apiKey) headers['authorization'] = `Bearer ${input.apiKey}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: SMOKE_PROMPT }],
        max_tokens: SMOKE_MAX_TOKENS,
      }),
    })
  } catch (err) {
    return classifyFetchError(err)
  }

  if (!res.ok) {
    const body = await readBodySafe(res)
    return classifyHttpError(res.status, body)
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return {
      ok: false,
      code: 'upstream',
      message: 'non-JSON response from provider',
    }
  }

  const sample = extractOpenAIChatText(payload)
  return {
    ok: true,
    stage: 'inference',
    model: input.model,
    message: sample
      ? 'completion returned content'
      : 'completion returned an empty response',
    sample: sample ? truncateSample(sample) : null,
  }
}

async function embeddingProbe(
  input: ConnectorInput,
): Promise<ConnectorResult> {
  // Same plumbing as inferenceProbe but talks to /v1/embeddings with a
  // tiny single-string input. Cheap enough that even paid embedding
  // models cost essentially nothing per click. Success is "data[0]
  // contains a non-empty embedding vector".
  const url = joinUrl(input.baseUrl, '/v1/embeddings')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (input.apiKey) headers['authorization'] = `Bearer ${input.apiKey}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: input.model,
        input: SMOKE_PROMPT,
      }),
    })
  } catch (err) {
    return classifyFetchError(err)
  }

  if (!res.ok) {
    const body = await readBodySafe(res)
    return classifyHttpError(res.status, body)
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return {
      ok: false,
      code: 'upstream',
      message: 'non-JSON response from provider',
    }
  }

  const dim = extractEmbeddingDim(payload)
  return {
    ok: true,
    stage: 'inference',
    model: input.model,
    message: dim
      ? `embedding returned (${dim}-dim vector)`
      : 'embedding endpoint accepted the request but the response shape was unexpected',
    sample: null,
    embeddingDim: dim,
  }
}

async function reachabilityProbe(
  input: ConnectorInput,
): Promise<ConnectorResult> {
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
    return classifyFetchError(err)
  }

  if (!res.ok) {
    const body = await readBodySafe(res)
    return classifyHttpError(res.status, body)
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    // Some self-hosted servers reply with text; treat a 2xx body as "up".
    return {
      ok: true,
      stage: 'reachable',
      model: null,
      message: 'endpoint reachable (non-JSON body)',
      sample: null,
    }
  }

  const count = countOpenAIModels(payload)
  return {
    ok: true,
    stage: 'reachable',
    model: null,
    message:
      count === null
        ? 'endpoint reachable (unexpected model list shape)'
        : `endpoint reachable, ${count} model${count === 1 ? '' : 's'} listed`,
    sample: null,
  }
}

// ─── Response shape probes ───────────────────────────────────────────────
//
// Keep these tolerant. A self-hosted server can serve the canonical
// OpenAI shape, a slightly-different Ollama-style shape, or just
// `{ ok: true }`. We only look for the happy path and gracefully report
// "reachable" when the shape doesn't match.

function extractOpenAIChatText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { choices } = payload as { choices?: unknown }
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0] as { message?: unknown } | null
  if (!first || typeof first !== 'object') return null
  const message = first.message as { content?: unknown } | undefined
  if (!message || typeof message !== 'object') return null
  const content = message.content
  if (typeof content === 'string') return content
  return null
}

/**
 * Pull the embedding vector dimension out of whatever shape the
 * upstream returned. Recognised inputs (in order of preference):
 *
 *   1. OpenAI standard: `{ data: [{ embedding: [number, …] }] }`
 *   2. OpenAI-bare-array: `{ data: [[number, …]] }` (some llama.cpp builds)
 *   3. `{ embedding: [number, …] }` (some local servers when single input)
 *   4. `{ embeddings: [[number, …]] }` (Cohere / some self-hosted)
 *   5. Bare `[[number, …]]` array
 *
 * Returns the length of the first numeric vector found. `null` only
 * when nothing recognisable matches AND the payload doesn't look like
 * an embedding response at all.
 */
function extractEmbeddingDim(payload: unknown): number | null {
  // Bare top-level array of vectors.
  if (Array.isArray(payload)) {
    const first = payload[0]
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === 'number') {
      return first.length
    }
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const obj = payload as Record<string, unknown>

  // OpenAI standard + bare-array variants.
  const data = obj['data']
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0]
    // Standard: { embedding: [...] }
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const emb = (first as { embedding?: unknown }).embedding
      if (Array.isArray(emb) && emb.length > 0 && typeof emb[0] === 'number') {
        return emb.length
      }
    }
    // Bare-array: data: [[...]]
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === 'number') {
      return first.length
    }
  }

  // Single-input convenience: { embedding: [...] }
  const emb = obj['embedding']
  if (Array.isArray(emb) && emb.length > 0 && typeof emb[0] === 'number') {
    return emb.length
  }

  // Cohere-ish: { embeddings: [[...]] }
  const embs = obj['embeddings']
  if (Array.isArray(embs) && embs.length > 0) {
    const first = embs[0]
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === 'number') {
      return first.length
    }
  }

  return null
}

function countOpenAIModels(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { data } = payload as { data?: unknown }
  if (Array.isArray(data)) return data.length
  return null
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.slice(0, 512)
  } catch {
    return ''
  }
}
