/**
 * Probe an OpenAI-compatible embeddings endpoint to discover its output
 * dimensionality. Single source of truth for the smoke harness — users
 * only need to point at a URL + model.
 *
 * Used by `fixture-setup.ts` and `smoke-fixture.ts` preflight. POSTs a
 * one-token input and reads `data[0].embedding.length` from the response.
 */

interface ProbeArgs {
  readonly url: string
  readonly model: string
  readonly apiKey?: string | null
  readonly timeoutMs?: number
}

export async function probeEmbeddingDims(args: ProbeArgs): Promise<number> {
  const { url, model, apiKey, timeoutMs = 15_000 } = args
  const endpoint = `${url.replace(/\/+$/, '')}/embeddings`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
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
    throw new Error(
      `embedding probe to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}.`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `embedding probe to ${endpoint} returned ${res.status}: ${body.slice(0, 200)}. ` +
        `Check SMOKE_EMBEDDING_URL / SMOKE_EMBEDDING_MODEL / SMOKE_EMBEDDING_API_KEY.`,
    )
  }

  const json = (await res.json().catch(() => null)) as unknown
  const dims = readEmbeddingDims(json)
  if (dims == null) {
    throw new Error(
      `embedding probe returned an unexpected shape from ${endpoint}. ` +
        `Expected { data: [{ embedding: number[] }] }.`,
    )
  }
  return dims
}

function readEmbeddingDims(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return null
  const first = data[0]
  if (!first || typeof first !== 'object') return null
  const embedding = (first as { embedding?: unknown }).embedding
  if (!Array.isArray(embedding) || embedding.length === 0) return null
  return embedding.length
}
