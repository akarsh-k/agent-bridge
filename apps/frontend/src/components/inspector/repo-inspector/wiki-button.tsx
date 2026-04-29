/**
 * WikiButton — picks an LLM provider, lets the operator override the
 * model per-run, optionally toggles `force`, and posts
 * `POST /api/repos/:id/wiki`. Same optimistic-revert contract as
 * `CloneButton` and `IndexButton`, except the "in flight" state lives
 * on `repo.wikiStatus` (not `repo.status`) so wiki gen doesn't make
 * the repo look unusable for chat.
 *
 * Model resolution (UI policy — backend does the same fallback chain):
 *   1. Operator's typed override in the input field
 *   2. First attached agent's `agents.model`
 *   3. Selected provider's `default_model`
 *
 * The input is pre-seeded from #2 → #3 on first mount and freezes
 * across re-renders so the operator doesn't lose their typing when the
 * parent updates. Switching the provider re-seeds the input only when
 * the field is currently blank.
 *
 * Disabled when:
 *   - `repo.status !== 'ready'`     (no meta.json for gitnexus to read)
 *   - `repo.wikiStatus === 'generating'`
 *   - the workspace has zero LLM providers (nothing to charge)
 *   - the model field is blank (nothing for gitnexus to call)
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LlmProviderResponse,
  RepoResponse,
} from '@agent-bridge/shared'
import { ApiError, generateRepoWiki } from '../../../lib/rpc'
import { ModelPicker } from '../../common/model-picker'

export interface WikiButtonProps {
  repo: RepoResponse
  providers: readonly LlmProviderResponse[]
  /**
   * Optional preferred provider id, derived from the first attached
   * agent that already has one chosen. Lets the dropdown default to a
   * sensible pick instead of the alphabetically-first row.
   */
  preferredProviderId?: string | null
  /**
   * Optional model id derived from the first attached agent's `model`
   * column. Lets the input pre-fill with what the operator already
   * configured for chat — typical case where they think "this is the
   * model I want" once and forget it.
   */
  preferredModel?: string | null
  onOptimistic: () => void
  onRevert: () => void
  onStarted?: (info: { jobId: string; streamId: string }) => void
}

export function WikiButton({
  repo,
  providers,
  preferredProviderId,
  preferredModel,
  onOptimistic,
  onRevert,
  onStarted,
}: WikiButtonProps) {
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [force, setForce] = useState(false)

  // First mount: pick the preferred provider if it's still in the list,
  // else the first row. Lazy initialiser so a parent re-render doesn't
  // clobber the user's manual selection.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (preferredProviderId && providers.some((p) => p.id === preferredProviderId)) {
      return preferredProviderId
    }
    return providers[0]?.id ?? null
  })

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? null,
    [providers, selectedId],
  )

  // Pre-seed the model input from the agent → provider fallback chain.
  // We only re-seed when the field is currently blank — typing wins over
  // upstream changes.
  const initialModel =
    preferredModel?.trim() || selected?.defaultModel?.trim() || ''
  const [model, setModel] = useState<string>(initialModel)

  // When the selected provider changes (operator picks a different one
  // mid-edit) and the model field hasn't been touched, re-seed from the
  // new provider's default. We track "touched" via a ref so the effect
  // doesn't fight the operator's typing.
  const touchedRef = useRef<boolean>(initialModel.length > 0)
  useEffect(() => {
    if (touchedRef.current) return
    const next = selected?.defaultModel?.trim() ?? ''
    setModel(next)
  }, [selected])

  const isGenerating = repo.wikiStatus === 'generating'
  const noProviders = providers.length === 0
  const repoNotReady = repo.status !== 'ready'
  const trimmedModel = model.trim()
  const noModel = trimmedModel.length === 0

  const disabled =
    posting || isGenerating || noProviders || repoNotReady || noModel || !selected

  const handleClick = async () => {
    if (disabled || !selected) return
    setError(null)
    setPosting(true)
    onOptimistic()
    try {
      const res = await generateRepoWiki(repo.id, {
        llmProviderId: selected.id,
        model: trimmedModel,
        force,
      })
      onStarted?.(res)
    } catch (err) {
      onRevert()
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(
          err instanceof Error ? err.message : 'Wiki generation failed to start',
        )
      }
    } finally {
      setPosting(false)
    }
  }

  const label =
    repo.wikiStatus === 'ready'
      ? 'Re-generate wiki'
      : repo.wikiStatus === 'error'
        ? 'Retry wiki'
        : 'Generate wiki'

  return (
    <div className="inspector-repo-action wiki-action">
      <div className="wiki-action-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm repo-action-button"
          onClick={handleClick}
          disabled={disabled}
          title={titleFor({ noProviders, repoNotReady, noModel, isGenerating })}
        >
          {isGenerating ? 'Generating…' : label}
        </button>
        {providers.length > 0 ? (
          <select
            className="wiki-provider-select"
            aria-label="LLM provider for wiki generation"
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
            disabled={posting || isGenerating || providers.length <= 1}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.kind === 'openai' ? ' · openai' : ` · ${p.kind}`}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <label className="wiki-model-label">
        <span className="wiki-model-caption">Model</span>
        <ModelPicker
          value={model}
          onChange={(next) => {
            touchedRef.current = true
            setModel(next)
          }}
          models={selected?.models?.models ?? []}
          placeholder="gpt-4o-mini"
          className="wiki-model-input"
          ariaLabel="Model id forwarded to gitnexus wiki"
          disabled={posting || isGenerating}
        />
      </label>
      <label className="wiki-force-label">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
          disabled={posting || isGenerating}
        />
        <span>Force full rebuild</span>
      </label>
      {error ? (
        <div className="status-strip error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function titleFor(s: {
  noProviders: boolean
  repoNotReady: boolean
  noModel: boolean
  isGenerating: boolean
}): string | undefined {
  if (s.isGenerating) return 'A wiki run is already in flight.'
  if (s.noProviders) return 'Add an LLM provider before generating a wiki.'
  if (s.repoNotReady) return 'Index this repository before generating a wiki.'
  if (s.noModel) return 'Enter a model id to enable wiki generation.'
  return undefined
}
