/**
 * "New agent" side-sheet — slides in from the right. The inner form
 * is mounted/unmounted with a `key` derived from the sheet's open
 * count, so each open starts with fresh state.
 */

import { useMemo, useState } from 'react'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { navigate } from '../../lib/router'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'
import { useDefaultProviderId } from '../../lib/use-default-provider'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function CreateAgentForm({ onClose }: { onClose: () => void }) {
  const { llmProviders, createAgent } = useWorkspace()
  const { defaultProviderId } = useDefaultProviderId()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [providerId, setProviderId] = useState<string | null>(
    // Pre-select the workspace-default provider if one's been chosen
    // and still exists. Falls through to null otherwise.
    defaultProviderId &&
      llmProviders.some((p) => p.id === defaultProviderId)
      ? defaultProviderId
      : null,
  )
  const [busy, setBusy] = useState(false)

  const effectiveSlug = slugTouched ? slug : slugify(name)

  // Only chat-role providers with a model set are eligible.
  const providerOpts: DropdownOption[] = useMemo(
    () =>
      llmProviders
        .filter((p) => p.role === 'chat' && !!p.defaultModel)
        .map((p) => ({ value: p.id, label: p.label, sub: p.kind })),
    [llmProviders],
  )

  const slugValid = SLUG_RE.test(effectiveSlug)
  const canSubmit = name.trim().length > 0 && slugValid

  const dirty =
    name.length > 0 ||
    description.length > 0 ||
    providerId !== null
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const created = await createAgent({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        systemPrompt: '',
        llmProviderId: providerId ?? null,
        memoryEnabled: false,
      })
      toast.success(`Created ${created.name}`)
      onClose()
      navigate(`/agents/${created.id}`)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create agent',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="New agent"
      subtitle="Two minutes. You can edit everything later."
      primaryLabel="Create agent"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!canSubmit}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ca-name">
          Name
        </label>
        <input
          id="ca-name"
          className="ab-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Atlas, Pilot, Forge…"
          autoFocus
        />
        <span className="ab-field-help">
          Shows up as the tool name in your IDE.
        </span>
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ca-slug">
          Slug
        </label>
        <input
          id="ca-slug"
          className="ab-input ab-mono"
          value={effectiveSlug}
          onChange={(e) => {
            setSlug(e.target.value)
            setSlugTouched(true)
          }}
          placeholder="auto-generated from name"
        />
        {effectiveSlug && !slugValid && (
          <span className="ab-field-help" style={{ color: 'var(--danger)' }}>
            Slug must be lowercase alphanumeric with dashes only.
          </span>
        )}
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ca-desc">
          What does this agent do?
        </label>
        <textarea
          id="ca-desc"
          className="ab-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence. Helps you tell agents apart later."
        />
      </div>
      <div className="ab-field">
        <span className="ab-field-label">Provider</span>
        {providerOpts.length === 0 ? (
          <div
            className="ab-input"
            style={{
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            No chat-capable providers yet — add one in Library
          </div>
        ) : (
          <Dropdown
            value={providerId}
            onChange={setProviderId}
            options={providerOpts}
            placeholder="Pick a provider"
          />
        )}
        <span className="ab-field-help">
          The provider's default model is what the agent uses.
        </span>
      </div>
    </Sheet>
  )
}

/**
 * Wrapper — bumps an internal counter when `open` transitions from
 * false to true so the form remounts on every fresh open. The bump
 * happens during render via a ref guard, which is a recognised
 * "derived state from props" pattern (no useEffect needed).
 */
export function CreateAgentSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  // "Adjust state based on props" — see React docs. We track the
  // previous `open` value in state and bump a remount key whenever
  // it transitions false → true, so the inner form starts fresh.
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }

  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="New agent">
        <></>
      </Sheet>
    )
  }
  return <CreateAgentForm key={openCount} onClose={onClose} />
}
