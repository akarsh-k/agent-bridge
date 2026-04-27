/**
 * Test-connection dispatcher.
 *
 * Every supported provider speaks the OpenAI HTTP API, so the
 * "dispatcher" is thin: resolve the effective config from saved row +
 * optional override body, hand the result to `testOpenAICompatible`,
 * stamp `durationMs` + `kind` onto its result. The per-kind variation
 * lives only in `VENDOR_BASE_URLS` (what URL to default to when the
 * saved row leaves `baseUrl` blank).
 *
 * This is the ONLY place outside the `applySecretInput` helper that
 * decrypts a stored LLM provider API key at request time. Plaintext
 * lives in a single local variable, is passed into exactly one
 * connector call, and is not returned or logged. Error messages pass
 * through `sanitizeMessage` which scrubs any accidental leakage of the
 * decrypted key (belt-and-braces — the connector currently never
 * echoes its input, but the guard stays cheap and future-proofs edits).
 */

import { decryptSecret } from '@agent-bridge/shared/crypto'
import type {
  LlmProviderKind,
  LlmProviderTestInput,
  LlmProviderTestResponse,
} from '@agent-bridge/shared'
import { testOpenAICompatible } from './openai-compatible.js'
import type { ConnectorResult } from './types.js'

/**
 * Minimal shape this module needs from a saved `llm_providers` row.
 * Accepting a structural type (rather than `LlmProviderRow`) avoids
 * pulling the Drizzle schema into `lib/`.
 */
export interface StoredProvider {
  readonly kind: LlmProviderKind
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly apiKeyEnvelope: string | null
}

/**
 * Per-kind base URL when the saved row doesn't specify one. Only
 * `openai` has a cloud default; the other three are local-by-design
 * and the DTO refinement requires `baseUrl` upfront, so their values
 * here are null (i.e. "must be supplied").
 */
const VENDOR_BASE_URLS: Record<LlmProviderKind, string | null> = {
  openai: 'https://api.openai.com',
  llama_cpp: null,
  ollama: null,
  openai_compatible: null,
}

export async function testProvider(
  stored: StoredProvider,
  override: LlmProviderTestInput,
): Promise<LlmProviderTestResponse> {
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

  const { baseUrl, apiKey, model } = resolved.value

  let result: ConnectorResult
  try {
    // All supported kinds speak the OpenAI HTTP API. If a kind is ever
    // added that doesn't, replace this direct call with a `switch` —
    // keeping `kind` in scope keeps that migration cheap.
    void kind
    result = await testOpenAICompatible({ baseUrl, apiKey, model })
  } catch (err) {
    // Connectors never throw by contract; if one does, don't let the
    // plaintext key leak through the stack trace.
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

  const durationMs = Date.now() - started

  if (result.ok) {
    return {
      ok: true,
      kind,
      durationMs,
      stage: result.stage,
      model: result.model,
      message: result.message,
      sample: result.sample,
    }
  }

  return {
    ok: false,
    kind,
    durationMs,
    code: result.code,
    message: sanitizeMessage(result.message, apiKey),
  }
}

// ─── Configuration resolution ────────────────────────────────────────────

type ResolvedConfig =
  | { ok: true; value: { baseUrl: string; apiKey: string | null; model: string | null } }
  | { ok: false; message: string }

function resolveConfig(
  stored: StoredProvider,
  override: LlmProviderTestInput,
): ResolvedConfig {
  // baseUrl: override → saved → vendor default.
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

  // model: override → saved. `null` = no smoke model, use reachability.
  const model =
    override.defaultModel !== undefined
      ? override.defaultModel
      : stored.defaultModel

  // apiKey: tri-state `SecretInput` → plaintext | null.
  const apiKeyInput = override.apiKey
  let apiKey: string | null
  if (!apiKeyInput || apiKeyInput.action === 'unchanged') {
    apiKey = stored.apiKeyEnvelope ? decryptSecret(stored.apiKeyEnvelope) : null
  } else if (apiKeyInput.action === 'clear') {
    apiKey = null
  } else {
    apiKey = apiKeyInput.plaintext
  }

  return { ok: true, value: { baseUrl, apiKey, model } }
}

/**
 * Redact a plaintext key from any string that's about to leave the
 * server. Connectors don't currently echo their input, but this guard
 * makes the invariant testable and survives refactors.
 */
function sanitizeMessage(message: string, plaintext: string | null): string {
  if (!plaintext || plaintext.length < 8) return message
  return message.split(plaintext).join('«redacted»')
}
