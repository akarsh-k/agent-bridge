/**
 * `redactSecrets(text, plaintexts)` — last line of defence before any run
 * event or log line hits the SSE stream. If the LLM or a tool echoes a
 * user-supplied secret back, we substring-replace each known plaintext with
 * a fixed mask so the browser never sees it.
 *
 * Browser-safe. Pure TS. No imports.
 */

const MASK = '«redacted»'

/** Mask every occurrence of every non-empty plaintext in `text`. */
export function redactSecrets(
  text: string,
  plaintexts: readonly string[],
): string {
  if (!plaintexts.length) return text
  let out = text
  for (const secret of plaintexts) {
    if (!secret || secret.length < 4) continue
    // Longest-first replacement to avoid partial masks when one secret is a
    // substring of another.
    out = splitReplaceAll(out, secret, MASK)
  }
  return out
}

/**
 * `redactMany` — mask secrets in a structured payload (object/array/string)
 * by recursively walking and replacing inside any string leaves.
 */
export function redactMany<T>(payload: T, plaintexts: readonly string[]): T {
  if (!plaintexts.length) return payload
  const sorted = [...plaintexts]
    .filter((s) => s && s.length >= 4)
    .sort((a, b) => b.length - a.length)
  return walk(payload, sorted) as T
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const s of secrets) out = splitReplaceAll(out, s, MASK)
    return out
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = walk(v, secrets)
    }
    return result
  }
  return value
}

function splitReplaceAll(
  haystack: string,
  needle: string,
  mask: string,
): string {
  if (!needle || needle.length === 0) return haystack
  return haystack.split(needle).join(mask)
}
