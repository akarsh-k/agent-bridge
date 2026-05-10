/**
 * Per-run secret scrubber.
 *
 * Binds a list of plaintext secrets (LLM provider apiKey + MCP
 * credentials) to `redactSecrets` / `redactMany` from
 * `@agent-bridge/shared`. Returned helpers are pure — callers invoke
 * them right before `eventBus.publish(event)` and
 * `runsRepo.appendEvent(...)` so no plaintext ever crosses the publish
 * boundary, even if the upstream LLM or a tool echoes it back.
 *
 * Why this lives in the backend (not in `@agent-bridge/shared`):
 *   - The binding is a trivial partial-application over the generic
 *     helpers. Keeping the generic ones pure + browser-safe is more
 *     valuable than deduplicating three lines here.
 *   - Future per-run wiring (e.g. redacting BullMQ job payloads for
 *     external MCP calls) will live alongside the dispatcher
 *     anyway — this is its natural home.
 *
 * Mask string and threshold (min 4 chars) match the upstream helpers
 * verbatim; we don't re-export `MASK` because callers never need to
 * reference it directly.
 */

import { redactMany, redactSecrets } from '@agent-bridge/shared'
import type { RunEvent } from '@agent-bridge/shared'

export interface RunRedactor {
  /**
   * Sanitised list actually in use (short or empty strings stripped).
   * Exposed so the dispatcher can include the count in log lines
   * without leaking any plaintext.
   */
  readonly plaintexts: readonly string[]
  /** Mask all known plaintexts in a single string. */
  readonly redactString: (s: string) => string
  /**
   * Mask all known plaintexts inside a `RunEvent`'s payload. Walks
   * string leaves recursively (tool call args, tool outputs, error
   * messages, token text, etc.) and returns a new event — the input
   * is never mutated. Preserves the full `RunEvent` TS type.
   */
  readonly redactEvent: <E extends RunEvent>(event: E) => E
}

const MIN_PLAINTEXT_LEN = 4

/**
 * Build a redactor scoped to one run. Pass the `BuiltAgent.secrets`
 * array directly — this function filters out short / empty entries so
 * callers don't need to.
 *
 * When no usable plaintexts remain the returned helpers are identity
 * functions. The dispatcher path is hot enough (~200 ms × N batches +
 * live token frames) that avoiding the recursive walk on every event
 * matters.
 */
export function createRunRedactor(
  plaintexts: readonly string[],
): RunRedactor {
  const filtered = plaintexts.filter(
    (s) => typeof s === 'string' && s.length >= MIN_PLAINTEXT_LEN,
  )

  if (filtered.length === 0) {
    return {
      plaintexts: [],
      redactString: (s) => s,
      redactEvent: (event) => event,
    }
  }

  return {
    plaintexts: filtered,
    redactString: (s) => redactSecrets(s, filtered),
    redactEvent: <E extends RunEvent>(event: E) => redactMany(event, filtered),
  }
}
