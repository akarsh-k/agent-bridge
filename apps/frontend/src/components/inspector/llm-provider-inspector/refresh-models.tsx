/**
 * RefreshModelsButton — kicks off `POST /api/llm-providers/:id/models/refresh`,
 * shows the result in the same status-strip idiom as `TestConnection`,
 * and on success patches the workspace's cached `models_json` so every
 * other model-picker UI (agent inspector, wiki button) sees the new
 * choices without a page refresh.
 *
 * The backend wraps reachability/auth failures as `{ ok: false, code,
 * message }` inside a 200 envelope, so the only `ApiError` paths are
 * 404 (provider deleted out from under us) and transport-level. Both
 * surface in the strip with a generic prefix.
 */

import { useState } from 'react'
import type { LlmProviderRefreshModelsResponse } from '@agent-bridge/shared'
import { ApiError, refreshLlmProviderModels } from '../../../lib/rpc'
import { useWorkspace } from '../../../lib/workspace-context'

const HUMAN_CODE: Record<
  Extract<LlmProviderRefreshModelsResponse, { ok: false }>['code'],
  string
> = {
  unreachable: 'Endpoint unreachable',
  auth: 'Authentication failed',
  rate_limited: 'Rate limited',
  upstream: 'Upstream error',
  timeout: 'Request timed out',
  unknown: 'Unknown error',
}

export interface RefreshModelsButtonProps {
  readonly providerId: string
}

export function RefreshModelsButton({ providerId }: RefreshModelsButtonProps) {
  const { patchLlmProviderModels } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LlmProviderRefreshModelsResponse | null>(
    null,
  )
  const [transportError, setTransportError] = useState<string | null>(null)

  const handleClick = async () => {
    if (busy) return
    setTransportError(null)
    setResult(null)
    setBusy(true)
    try {
      const next = await refreshLlmProviderModels(providerId)
      setResult(next)
      if (next.ok) {
        // Backend already persisted; sync the in-memory store so other
        // dropdowns refresh in the same render cycle.
        patchLlmProviderModels(providerId, next.models)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setTransportError(err.message)
      } else {
        setTransportError(
          err instanceof Error ? err.message : 'Refresh failed to start',
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="refresh-models">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleClick}
        disabled={busy}
      >
        {busy ? 'Refreshing…' : 'Refresh models'}
      </button>
      {result?.ok ? (
        <div className="status-strip success" role="status">
          {result.models.models.length === 0
            ? 'Provider responded but listed 0 models.'
            : `Loaded ${result.models.models.length} model${result.models.models.length === 1 ? '' : 's'}.`}
        </div>
      ) : null}
      {result && !result.ok ? (
        <div className="status-strip error" role="alert">
          {HUMAN_CODE[result.code]}
          {result.message ? ` · ${result.message}` : ''}
        </div>
      ) : null}
      {transportError ? (
        <div className="status-strip error" role="alert">
          {transportError}
        </div>
      ) : null}
    </div>
  )
}
