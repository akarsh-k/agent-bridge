/**
 * Test-state machinery shared by every surface that lets the operator
 * "ping" a model against a provider — the LLM provider edit page
 * (chat default, embedding default, full model chip grid) and the
 * agent build tab (chat model picker).
 *
 * Owns two dicts keyed by model id (`state` + `message`) and exposes
 * a `test(modelId, capability?)` action that hits
 * `testLlmProvider(...)` and updates the dicts in place. Consumers
 * read the result via `stateOf(model)` / `messageOf(model)` for the
 * inline `<ModelTestStatus>` pill, or grab the raw dicts directly
 * when they iterate (e.g. the chip grid).
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
  /** Fire a test for `modelId`. Defaults to chat capability. */
  readonly test: (modelId: string, capability?: ModelTestCapability) => Promise<void>
  /** Look up the current state of one model id. */
  readonly stateOf: (modelId: string | null | undefined) => ModelTestState | undefined
  /** Look up the message (timing on success, error reason on failure). */
  readonly messageOf: (modelId: string | null | undefined) => string | undefined
  /** Raw dicts for callers that iterate (chip grids, etc). */
  readonly stateMap: Readonly<Record<string, ModelTestState>>
  readonly messageMap: Readonly<Record<string, string>>
}

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
    async (modelId: string, capability: ModelTestCapability = 'chat') => {
      if (!providerId) return
      setStateMap((s) => ({ ...s, [modelId]: 'pending' }))
      setMessageMap((s) => {
        const next = { ...s }
        delete next[modelId]
        return next
      })
      try {
        const res = await testLlmProvider(providerId, {
          defaultModel: modelId,
          capability,
        })
        if (res.ok) {
          setStateMap((s) => ({ ...s, [modelId]: 'ok' }))
          setMessageMap((s) => ({ ...s, [modelId]: `${res.durationMs}ms` }))
          return
        }
        const reason = res.message ?? res.code
        setStateMap((s) => ({ ...s, [modelId]: 'error' }))
        setMessageMap((s) => ({ ...s, [modelId]: reason }))
        // Surface the failure reason in a toast — the red pill alone
        // signals "something broke" but the actionable detail
        // (auth / model not found / rate limit) only lives in the
        // tooltip otherwise, which is easy to miss.
        toast.error(`${modelId} failed: ${reason}`)
      } catch (e) {
        const reason =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'failed'
        setStateMap((s) => ({ ...s, [modelId]: 'error' }))
        setMessageMap((s) => ({ ...s, [modelId]: reason }))
        toast.error(`${modelId} failed: ${reason}`)
      }
    },
    [providerId],
  )

  return {
    test,
    stateOf: (m) => (m ? stateMap[m] : undefined),
    messageOf: (m) => (m ? messageMap[m] : undefined),
    stateMap,
    messageMap,
  }
}
