/**
 * Test-state machinery shared by every surface that lets the operator
 * "ping" a model against a provider — the LLM provider edit page
 * (chat default, embedding default, full model chip grid) and the
 * agent build tab (chat model picker).
 *
 * State is keyed by `(capability, modelId)`, NOT modelId alone, because
 * a single model id can legitimately appear under both capabilities on
 * local providers (e.g. one llama.cpp GGUF advertised by /v1/models
 * with no per-model capability hint, so the same id passes both
 * `isChatCapable` and `isEmbeddingCapable` filters). Without the
 * compound key, a chat-test pass would silently overwrite a previous
 * embedding-test fail for the same id, and the embedding pill would
 * flip green even though the embedding endpoint never succeeded.
 *
 * Provider-change reset: when `providerId` flips to a new value the
 * cached state is cleared. Test results are provider-scoped — a
 * "passed" against OpenAI doesn't carry meaning after the user
 * switches to Ollama.
 */

import { useCallback, useState } from 'react'
import { ApiError, testLlmProvider } from './rpc'
import { toast } from '../ui/toast-store'

export type ModelTestState = 'pending' | 'ok' | 'error'
export type ModelTestCapability = 'chat' | 'embedding'

export interface UseModelTesterReturn {
  /**
   * Fire a test for `modelId`. Defaults to chat capability.
   *
   * `providerIdOverride` is needed by call sites that just changed the
   * agent's provider in the same tick — the hook's closure-captured
   * `providerId` is still the previous value until the next render,
   * so a naive `tester.test(...)` would hit the wrong endpoint. Pass
   * the new id explicitly to avoid the off-by-one render.
   */
  readonly test: (
    modelId: string,
    capability?: ModelTestCapability,
    providerIdOverride?: string,
  ) => Promise<void>
  /**
   * Look up the current state for one (modelId, capability) pair.
   * Capability defaults to 'chat' so existing call sites that aren't
   * capability-aware (build-tab's chat-only model dropdown) keep
   * working without extra wiring.
   */
  readonly stateOf: (
    modelId: string | null | undefined,
    capability?: ModelTestCapability,
  ) => ModelTestState | undefined
  /** Look up the message (timing on success, error reason on failure). */
  readonly messageOf: (
    modelId: string | null | undefined,
    capability?: ModelTestCapability,
  ) => string | undefined
}

const stateKey = (
  modelId: string,
  capability: ModelTestCapability,
): string => `${capability}:${modelId}`

export function useModelTester(
  providerId: string | null | undefined,
): UseModelTesterReturn {
  const [stateMap, setStateMap] = useState<Record<string, ModelTestState>>({})
  const [messageMap, setMessageMap] = useState<Record<string, string>>({})

  // Provider-scoped reset. Switching the agent's provider invalidates
  // every cached "passed/failed" since the next test will hit a
  // different endpoint with a different auth — old results would
  // mislead. Derived-state pattern keeps it in render rather than
  // an effect.
  const [seededFor, setSeededFor] = useState<string | null | undefined>(
    providerId,
  )
  if (seededFor !== providerId) {
    setSeededFor(providerId)
    setStateMap({})
    setMessageMap({})
  }

  const test = useCallback(
    async (
      modelId: string,
      capability: ModelTestCapability = 'chat',
      providerIdOverride?: string,
    ) => {
      const pid = providerIdOverride ?? providerId
      if (!pid) return
      const key = stateKey(modelId, capability)
      setStateMap((s) => ({ ...s, [key]: 'pending' }))
      setMessageMap((s) => {
        const next = { ...s }
        delete next[key]
        return next
      })
      try {
        const res = await testLlmProvider(pid, {
          defaultModel: modelId,
          capability,
        })
        if (res.ok) {
          setStateMap((s) => ({ ...s, [key]: 'ok' }))
          setMessageMap((s) => ({ ...s, [key]: `${res.durationMs}ms` }))
          return
        }
        const reason = res.message ?? res.code
        setStateMap((s) => ({ ...s, [key]: 'error' }))
        setMessageMap((s) => ({ ...s, [key]: reason }))
        // Surface the failure reason in a toast — the red pill alone
        // signals "something broke" but the actionable detail
        // (auth / model not found / rate limit) only lives in the
        // tooltip otherwise, which is easy to miss.
        toast.error(`${modelId} (${capability}) failed: ${reason}`)
      } catch (e) {
        const reason =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'failed'
        setStateMap((s) => ({ ...s, [key]: 'error' }))
        setMessageMap((s) => ({ ...s, [key]: reason }))
        toast.error(`${modelId} (${capability}) failed: ${reason}`)
      }
    },
    [providerId],
  )

  return {
    test,
    stateOf: (m, capability = 'chat') =>
      m ? stateMap[stateKey(m, capability)] : undefined,
    messageOf: (m, capability = 'chat') =>
      m ? messageMap[stateKey(m, capability)] : undefined,
  }
}
