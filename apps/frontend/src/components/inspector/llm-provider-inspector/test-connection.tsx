/**
 * Live "Test connection" panel for the LLM provider inspector.
 *
 * Posts to `POST /api/llm-providers/:id/test`, renders the normalized
 * result as a status strip:
 *
 *   stage='inference'  → success strip, shows model + short sample
 *   stage='reachable'  → info strip, shows "endpoint reachable" + model list count
 *   ok=false           → error strip, shows code + message
 *
 * The result is ephemeral; a reload clears it. No persistence in v1 —
 * if we later want a green/red health dot in the canvas we'll persist
 * `last_tested_at` + `last_test_ok` alongside the row.
 *
 * The button drives the saved row. A future "edit draft" form can
 * reuse the `testLlmProvider(id, overrides)` RPC with overrides.
 */

import { useState } from 'react'
import type { LlmProviderTestResponse } from '@agent-bridge/shared'
import { ApiError, testLlmProvider } from '../../../lib/rpc'

export interface TestConnectionProps {
  readonly providerId: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; result: LlmProviderTestResponse; at: number }
  | { kind: 'failed'; message: string; at: number }

export function TestConnection({ providerId }: TestConnectionProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const run = async () => {
    setPhase({ kind: 'testing' })
    try {
      const result = await testLlmProvider(providerId)
      setPhase({ kind: 'done', result, at: Date.now() })
    } catch (err) {
      setPhase({
        kind: 'failed',
        message:
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Test failed',
        at: Date.now(),
      })
    }
  }

  const busy = phase.kind === 'testing'

  return (
    <div className="llm-test-connection">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={run}
        disabled={busy}
      >
        {busy ? 'Testing…' : 'Test connection'}
      </button>

      {phase.kind === 'done' ? (
        <ResultStrip result={phase.result} />
      ) : phase.kind === 'failed' ? (
        <div className="status-strip error" role="alert">
          {phase.message}
        </div>
      ) : null}
    </div>
  )
}

function ResultStrip({ result }: { result: LlmProviderTestResponse }) {
  if (result.ok) {
    const cls = result.stage === 'inference' ? 'saved' : 'saving'
    return (
      <div className={`status-strip ${cls}`} role="status">
        <div className="llm-test-result">
          <div className="llm-test-headline">
            <span className="llm-test-stage">
              {result.stage === 'inference' ? 'Inference OK' : 'Reachable'}
            </span>
            <span className="muted">· {formatMs(result.durationMs)}</span>
          </div>
          <div className="llm-test-message">{result.message}</div>
          {result.sample ? (
            <div className="llm-test-sample mono">“{result.sample}”</div>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className="status-strip error" role="alert">
      <div className="llm-test-result">
        <div className="llm-test-headline">
          <span className="llm-test-stage">{humanizeCode(result.code)}</span>
          <span className="muted">· {formatMs(result.durationMs)}</span>
        </div>
        <div className="llm-test-message">{result.message}</div>
      </div>
    </div>
  )
}

function humanizeCode(
  code: Extract<LlmProviderTestResponse, { ok: false }>['code'],
): string {
  switch (code) {
    case 'unreachable':
      return 'Unreachable'
    case 'auth':
      return 'Auth failed'
    case 'rate_limited':
      return 'Rate limited'
    case 'invalid_model':
      return 'Invalid model'
    case 'upstream':
      return 'Upstream error'
    case 'timeout':
      return 'Timed out'
    case 'unknown':
    default:
      return 'Failed'
  }
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}
