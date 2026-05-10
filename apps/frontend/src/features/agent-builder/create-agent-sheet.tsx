/**
 * "New agent" side-sheet — slides in from the right. Two-step flow:
 *   1. Template picker — Coding helper / Build your own agent. The
 *      choice sets `inspector_enabled` on insert (true / false).
 *   2. Identity form — name, slug, provider, description.
 *
 * The inner form is mounted/unmounted with a `key` derived from the
 * sheet's open count so each open starts on Step 1 with fresh state.
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

type AgentTemplate = 'coding' | 'blank'

interface TemplateMeta {
  readonly id: AgentTemplate
  readonly title: string
  readonly tagline: string
  readonly bullets: readonly string[]
  /** Maps to `inspector_enabled` on insert. */
  readonly inspectorEnabled: boolean
}

const TEMPLATES: readonly TemplateMeta[] = [
  {
    id: 'coding',
    title: 'Coding helper',
    tagline: 'Q&A across the repos you attach. The agent reads code for you.',
    bullets: [
      'Built-in code search, call-graph walks, change-impact analysis, debugging hints',
      'In your IDE this agent appears as one MCP tool: <slug>__inspect_codebase',
      'Replies are structured: file paths, code snippets, related files across repos',
      'Needs one embedding provider configured in the workspace (any model — local or cloud)',
    ],
    inspectorEnabled: true,
  },
  {
    id: 'blank',
    title: 'Build your own agent',
    tagline: 'Empty starting point. For helpers that aren\'t about code.',
    bullets: [
      'No built-in tools — you bring the skills, system prompt, and any external MCP servers',
      'In your IDE this agent appears as one MCP tool: <slug>__ask_agent (free-form Q&A)',
      'Replies are plain prose — no file paths or structured code evidence',
      'No embedding provider needed',
      'You can turn on the code-search toolkit later from the Tools tab if you change your mind',
    ],
    inspectorEnabled: false,
  },
] as const

function CreateAgentForm({ onClose }: { onClose: () => void }) {
  const { llmProviders, createAgent } = useWorkspace()
  const { defaultProviderId } = useDefaultProviderId()
  const [template, setTemplate] = useState<AgentTemplate | null>(null)
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
  const canSubmit =
    template !== null && name.trim().length > 0 && slugValid

  const dirty =
    template !== null ||
    name.length > 0 ||
    description.length > 0 ||
    providerId !== null
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    if (!canSubmit || template === null) return
    const tmpl = TEMPLATES.find((t) => t.id === template)
    if (!tmpl) return
    setBusy(true)
    try {
      const created = await createAgent({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        systemPrompt: '',
        llmProviderId: providerId ?? null,
        memoryEnabled: false,
        inspectorEnabled: tmpl.inspectorEnabled,
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

  // ─── Step 1 — template picker ────────────────────────────────────
  if (template === null) {
    return (
      <Sheet
        open
        onClose={guardedClose}
        title="New agent"
        subtitle="Pick a template. You can change anything about the agent after creation — including switching templates."
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              className="ab-card ab-card-pad"
              style={{
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'var(--surface)',
                borderColor: 'var(--border)',
                font: 'inherit',
              }}
            >
              <div className="ab-section-title" style={{ marginBottom: 4 }}>
                {t.title}
              </div>
              <div
                className="ab-section-sub"
                style={{ marginBottom: 10 }}
              >
                {t.tagline}
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--text-dim)',
                }}
              >
                {t.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </Sheet>
    )
  }

  // ─── Step 2 — identity form ──────────────────────────────────────
  const chosen = TEMPLATES.find((t) => t.id === template)
  return (
    <Sheet
      open
      onClose={guardedClose}
      title="New agent"
      subtitle={`Two minutes. You can edit everything later.`}
      primaryLabel="Create agent"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!canSubmit}
    >
      <div
        className="ab-card ab-card-pad"
        style={{
          marginBottom: 14,
          background: 'var(--surface-hi)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              marginBottom: 2,
            }}
          >
            Template
          </div>
          <div style={{ fontWeight: 600 }}>{chosen?.title}</div>
        </div>
        <button
          type="button"
          onClick={() => setTemplate(null)}
          className="ab-btn ab-btn-secondary ab-btn-sm"
          disabled={busy}
        >
          Change
        </button>
      </div>
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
