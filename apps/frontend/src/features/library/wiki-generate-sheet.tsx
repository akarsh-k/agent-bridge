/**
 * "Generate wiki" side-sheet — pick provider / model + force flag.
 * Calls `generateRepoWiki` with the chosen provider.
 */

import { useMemo, useState } from 'react'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { ApiError, generateRepoWiki } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { Link } from '../../lib/link'

function WikiGenerateForm({
  repoId,
  onClose,
}: {
  repoId: string
  onClose: () => void
}) {
  const { llmProviders } = useWorkspace()
  const providersWithKey = useMemo(
    () => llmProviders.filter((p) => p.apiKey.set),
    [llmProviders],
  )
  const [providerId, setProviderId] = useState<string | null>(
    providersWithKey[0]?.id ?? null,
  )
  const [model, setModel] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const provider = useMemo(
    () => providersWithKey.find((p) => p.id === providerId) ?? null,
    [providersWithKey, providerId],
  )
  const cachedModels = useMemo(() => provider?.models?.models ?? [], [provider])
  const effectiveModel = useMemo(() => {
    if (model && cachedModels.includes(model)) return model
    return provider?.defaultModel ?? cachedModels[0] ?? null
  }, [model, cachedModels, provider])

  const providerOpts: DropdownOption[] = useMemo(
    () =>
      providersWithKey.map((p) => ({
        value: p.id,
        label: p.label,
        sub: p.kind,
      })),
    [providersWithKey],
  )
  const modelOpts: DropdownOption[] = useMemo(
    () => cachedModels.map((m) => ({ value: m, label: m, monoLabel: true })),
    [cachedModels],
  )

  const submit = async () => {
    if (!providerId) return
    setBusy(true)
    setErr(null)
    try {
      await generateRepoWiki(repoId, {
        llmProviderId: providerId,
        model: effectiveModel ?? undefined,
        force,
      })
      toast.success('Wiki generation kicked off')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to start',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Generate wiki"
      subtitle="Run gitnexus wiki against the repo. Pick the LLM that pays for the tokens."
      primaryLabel="Generate wiki"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!providerId}
    >
      {providersWithKey.length === 0 ? (
        <div className="ab-field-help">
          No providers with an API key set.{' '}
          <Link to="/library/providers" className="ab-text-link">
            Add one →
          </Link>
        </div>
      ) : (
        <>
          <div className="ab-field">
            <span className="ab-field-label">Provider</span>
            <Dropdown
              value={providerId}
              onChange={setProviderId}
              options={providerOpts}
            />
          </div>
          <div className="ab-field">
            <span className="ab-field-label">Model (optional)</span>
            <Dropdown
              value={effectiveModel}
              onChange={setModel}
              options={modelOpts}
              placeholder={
                modelOpts.length === 0
                  ? "Refresh models on the provider's detail page"
                  : 'Use provider default'
              }
              disabled={modelOpts.length === 0}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label ab-field-label--checkbox">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Force regenerate
            </label>
            <span className="ab-field-help">
              Skip the up-to-date short-circuit. Regenerates every page even if
              nothing changed since the last run.
            </span>
          </div>
          {err && (
            <div className="ab-field-help ab-field-help--danger" role="alert">
              {err}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

export function WikiGenerateSheet({
  open,
  repoId,
  onClose,
}: {
  open: boolean
  repoId: string
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Generate wiki">
        <></>
      </Sheet>
    )
  }
  return <WikiGenerateForm key={openCount} repoId={repoId} onClose={onClose} />
}
