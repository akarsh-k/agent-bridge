/**
 * "New agent" side-sheet. Two-step flow:
 *   1. Template picker. Radio-card selection between Repo inspector
 *      and Build your own agent. Selection sets `inspector_enabled`
 *      on insert (true / false).
 *   2. Identity form. Name, slug, provider, description, plus a live
 *      preview of the IDE tool name the operator will see in
 *      Cursor / Claude Code / Codex.
 *
 * The inner form is mounted/unmounted with a `key` derived from the
 * sheet's open count so each open starts on Step 1 with fresh state.
 */

import { useMemo, useState } from 'react'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import { Button } from '../../ui/button'
import {
  AgentsIcon,
  ToolIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  ProvidersIcon,
} from '../../ui/icons'
import { useWorkspace } from '../../lib/workspace-context'
import { navigate } from '../../lib/router'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'
import { useDefaultProviderId } from '../../lib/use-default-provider'
import { DEFAULT_INSPECTOR_SYSTEM_PROMPT } from '@agent-bridge/shared'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Slug → bridge_tool safe form. Mirrors `slugToBridgeToolPrefix` in
 *  `apps/backend/src/routes/agents.ts`. Dashes become underscores so
 *  the auto-created `<safeSlug>__ask_agent` passes the CHECK constraint. */
function toSafeBridgeSlug(slug: string): string {
  return slug.replace(/-/g, '_')
}

type AgentTemplate = 'coding' | 'blank'

interface TemplateMeta {
  readonly id: AgentTemplate
  readonly title: string
  readonly tagline: string
  readonly bullets: readonly string[]
  /** Maps to `inspector_enabled` on insert. */
  readonly inspectorEnabled: boolean
  /** Suffix the bridge appends to `<slug>__` for this template. */
  readonly toolSuffix: 'inspect_codebase' | 'ask_agent'
  /** Glyph tone. `violet` matches the brand accent; `neutral` is the
   *  default surface-hi tile from `ab-glyph` with no tone modifier. */
  readonly glyph: 'violet' | 'neutral'
  /** Recommended path for the headline sidecar use case. */
  readonly recommended?: boolean
}

const TEMPLATES: readonly TemplateMeta[] = [
  {
    id: 'coding',
    title: 'Repo inspector',
    tagline: 'Q&A across the repos you attach. The agent reads code for you.',
    bullets: [
      'Built-in code search, call-graph walks, change-impact analysis, debug hints',
      'Replies are structured: file paths, code snippets, related files across repos',
      'Needs one embedding provider in the workspace (any model, local or cloud)',
    ],
    inspectorEnabled: true,
    toolSuffix: 'inspect_codebase',
    glyph: 'violet',
    recommended: true,
  },
  {
    id: 'blank',
    title: 'Build your own agent',
    tagline: 'Empty starting point. For helpers that are not about code.',
    bullets: [
      'No built-in tools. Bring your own skills, system prompt, and external MCPs',
      'Replies are plain text. No file paths or structured code evidence',
      'You can switch on the inspector toolkit later from the Tools tab',
    ],
    inspectorEnabled: false,
    toolSuffix: 'ask_agent',
    glyph: 'neutral',
  },
] as const

// ─── Step 1 — Template card ──────────────────────────────────────────────

function TemplateCard({
  meta,
  selected,
  onSelect,
}: {
  meta: TemplateMeta
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={'ab-card ab-card-pad' + (selected ? ' ab-card-featured' : '')}
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        display: 'block',
        position: 'relative',
        // Subtle lift on hover for unselected cards. Selected cards already
        // carry the accent glow via `ab-card-featured`.
        transition:
          'border-color var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out)',
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLElement).style.borderColor =
            'var(--border-strong)'
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
      }}
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div
          className={
            'ab-glyph' +
            (meta.glyph === 'violet' ? ' ab-glyph-violet' : '')
          }
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          {meta.id === 'coding' ? (
            <ToolIcon width={18} height={18} />
          ) : (
            <AgentsIcon width={18} height={18} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
              flexWrap: 'wrap',
            }}
          >
            <span className="ab-section-title" style={{ marginBottom: 0 }}>
              {meta.title}
            </span>
            {meta.recommended && <Pill kind="accent">Recommended</Pill>}
          </div>
          <div className="ab-section-sub" style={{ marginBottom: 10 }}>
            {meta.tagline}
          </div>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: 'var(--text-dim)',
            }}
          >
            {meta.bullets.map((b) => (
              <li
                key={b}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    marginTop: 7,
                    width: 3,
                    height: 3,
                    borderRadius: '50%',
                    background: 'var(--text-muted)',
                    flexShrink: 0,
                  }}
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </button>
  )
}

// ─── Step 2 — Tool preview card ──────────────────────────────────────────

/** Live preview of the MCP tool name the operator will see in their IDE
 *  once this agent is created. The biggest "what am I actually getting?"
 *  question this form has to answer, so it gets its own card. */
function ToolPreviewCard({
  slug,
  slugValid,
  toolSuffix,
}: {
  slug: string
  slugValid: boolean
  toolSuffix: TemplateMeta['toolSuffix']
}) {
  const safeSlug = toSafeBridgeSlug(slug || 'your-slug')
  const fullName = slugValid
    ? `${safeSlug}__${toolSuffix}`
    : `<slug>__${toolSuffix}`
  return (
    <div
      className="ab-card ab-card-pad"
      style={{ background: 'var(--surface-hi)', marginTop: 4 }}
    >
      <div className="ab-eyebrow">In your IDE</div>
      <div
        className="ab-mono"
        style={{
          fontSize: 13,
          color: slugValid ? 'var(--text)' : 'var(--text-muted)',
          wordBreak: 'break-all',
          lineHeight: 1.4,
        }}
      >
        {fullName}
      </div>
      <div className="ab-field-help" style={{ marginTop: 8 }}>
        {toolSuffix === 'inspect_codebase'
          ? 'Structured envelope: file paths, code snippets, related repos.'
          : 'Free-form Q&A. Replies in plain text.'}
      </div>
    </div>
  )
}

// ─── Inner form ──────────────────────────────────────────────────────────

function CreateAgentForm({ onClose }: { onClose: () => void }) {
  const { llmProviders, createAgent } = useWorkspace()
  const { defaultProviderId } = useDefaultProviderId()

  // Two-step nav. `step` advances on Continue; the recap row in step 2
  // returns to step 1 without nuking name/slug/description so the
  // operator can revise the template choice without re-typing.
  const [step, setStep] = useState<'pick' | 'fill'>('pick')
  const [template, setTemplate] = useState<AgentTemplate | null>(null)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  // Pre-filled with the inspector default the first time the operator
  // lands on Step 2 with the Repo Inspector template selected. Tracked
  // by `systemPromptSeededFor` so switching templates back and forth
  // doesn't overwrite operator edits, and so flipping to Build-Your-Own
  // clears the textarea (the constant is only meaningful for inspector
  // agents — see `DEFAULT_INSPECTOR_SYSTEM_PROMPT` for why).
  const [systemPrompt, setSystemPrompt] = useState('')
  const [systemPromptSeededFor, setSystemPromptSeededFor] = useState<
    AgentTemplate | null
  >(null)
  const [providerId, setProviderId] = useState<string | null>(
    defaultProviderId &&
      llmProviders.some((p) => p.id === defaultProviderId)
      ? defaultProviderId
      : null,
  )
  const [busy, setBusy] = useState(false)

  const effectiveSlug = slugTouched ? slug : slugify(name)
  const slugValid = effectiveSlug.length > 0 && SLUG_RE.test(effectiveSlug)
  const slugInvalid = effectiveSlug.length > 0 && !slugValid

  const chosen = TEMPLATES.find((t) => t.id === template) ?? null

  // Seed the system-prompt textarea when the operator changes template.
  // Inspector → fill with the default; Build-Your-Own → clear. Only
  // re-seed on actual template changes so the operator's edits survive
  // re-renders. Done as a derived-state-from-props update during render
  // (the recognised React 19 pattern) instead of useEffect.
  if (template !== systemPromptSeededFor) {
    setSystemPromptSeededFor(template)
    setSystemPrompt(
      template !== null && chosen?.inspectorEnabled
        ? DEFAULT_INSPECTOR_SYSTEM_PROMPT
        : '',
    )
  }

  const providerOpts: DropdownOption[] = useMemo(
    () =>
      llmProviders
        .filter((p) => p.role === 'chat' && !!p.defaultModel)
        .map((p) => ({ value: p.id, label: p.label, sub: p.kind })),
    [llmProviders],
  )

  const canSubmit =
    template !== null && name.trim().length > 0 && slugValid

  const dirty =
    template !== null ||
    name.length > 0 ||
    description.length > 0 ||
    providerId !== null ||
    // Edited away from the seeded default for the current template.
    systemPrompt !==
      (chosen?.inspectorEnabled ? DEFAULT_INSPECTOR_SYSTEM_PROMPT : '')
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    if (!canSubmit || chosen === null) return
    setBusy(true)
    try {
      const created = await createAgent({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        systemPrompt,
        llmProviderId: providerId ?? null,
        memoryEnabled: false,
        inspectorEnabled: chosen.inspectorEnabled,
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

  // ─── Step 1 — template picker ──────────────────────────────────────────
  if (step === 'pick') {
    return (
      <Sheet
        open
        onClose={guardedClose}
        title="New agent"
        subtitle="Pick a template. You can change anything after creation, including switching templates."
        primaryLabel="Continue"
        onPrimary={() => template !== null && setStep('fill')}
        primaryDisabled={template === null}
      >
        <div
          role="radiogroup"
          aria-label="Agent template"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {TEMPLATES.map((t) => (
            <TemplateCard
              key={t.id}
              meta={t}
              selected={template === t.id}
              onSelect={() => setTemplate(t.id)}
            />
          ))}
        </div>
      </Sheet>
    )
  }

  // ─── Step 2 — identity form ────────────────────────────────────────────
  if (chosen === null) {
    // Should be unreachable; guard against navigating to step 2 without
    // a selected template (a future routing change could break this).
    setStep('pick')
    return null
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
      {/* Template recap. Click to revise the choice without losing
          identity fields. */}
      <button
        type="button"
        onClick={() => setStep('pick')}
        disabled={busy}
        className="ab-card ab-card-pad"
        style={{
          width: '100%',
          textAlign: 'left',
          cursor: busy ? 'default' : 'pointer',
          background: 'var(--surface-hi)',
          font: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          padding: '12px 14px',
        }}
        aria-label={`Template: ${chosen.title}. Click to change.`}
      >
        <div
          className={
            'ab-glyph' +
            (chosen.glyph === 'violet' ? ' ab-glyph-violet' : '')
          }
          style={{ flexShrink: 0, width: 32, height: 32, fontSize: 14 }}
          aria-hidden="true"
        >
          {chosen.id === 'coding' ? (
            <ToolIcon width={16} height={16} />
          ) : (
            <AgentsIcon width={16} height={16} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ab-eyebrow" style={{ marginBottom: 2 }}>
            Template
          </div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{chosen.title}</div>
        </div>
        <span
          aria-hidden="true"
          style={{
            color: 'var(--text-muted)',
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          Change
          <ChevronRightIcon width={14} height={14} />
        </span>
      </button>

      {/* Name + Slug share a row on wider sheets; stack at narrow widths. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 14,
          marginBottom: 14,
        }}
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
            placeholder="Atlas, Pilot, Forge…"
            autoFocus
          />
        </div>
        <div className="ab-field">
          <div className="ab-field-label-row">
            <label className="ab-field-label" htmlFor="ca-slug">
              Slug
            </label>
            {slugTouched && (
              <button
                type="button"
                className="ab-inline-action"
                onClick={() => {
                  setSlugTouched(false)
                  setSlug('')
                }}
              >
                Reset to auto
              </button>
            )}
          </div>
          <input
            id="ca-slug"
            className="ab-input ab-mono"
            value={effectiveSlug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugTouched(true)
            }}
            placeholder="auto from name"
            aria-invalid={slugInvalid || undefined}
            style={
              slugInvalid
                ? {
                    borderColor: 'var(--danger-border)',
                    background: 'var(--danger-bg)',
                  }
                : undefined
            }
          />
          {slugInvalid && (
            <span className="ab-field-help" style={{ color: 'var(--danger)' }}>
              Lowercase letters, digits, and dashes only.
            </span>
          )}
        </div>
      </div>

      <ToolPreviewCard
        slug={effectiveSlug}
        slugValid={slugValid}
        toolSuffix={chosen.toolSuffix}
      />

      <div className="ab-field" style={{ marginTop: 18 }}>
        <label className="ab-field-label" htmlFor="ca-desc">
          Description
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
            {' '}
            (optional)
          </span>
        </label>
        <textarea
          id="ca-desc"
          className="ab-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence. Helps you tell agents apart later."
          rows={2}
        />
        <span className="ab-field-help">
          Shown in the agents list. Not sent to the model.
        </span>
      </div>

      <div className="ab-field" style={{ marginTop: 14 }}>
        <label className="ab-field-label" htmlFor="ca-prompt">
          System prompt
        </label>
        <textarea
          id="ca-prompt"
          className="ab-textarea"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={
            chosen.inspectorEnabled
              ? 'How the agent should answer questions about the attached repos.'
              : 'Optional. How the agent should respond.'
          }
          rows={4}
        />
        <span className="ab-field-help">
          Prepended to every conversation. Edit or clear as you like. You can
          change this later in the agent's Build tab.
        </span>
      </div>

      <div className="ab-field" style={{ marginTop: 14 }}>
        <span className="ab-field-label">Provider</span>
        {providerOpts.length === 0 ? (
          <div
            className="ab-card ab-card-pad"
            style={{ background: 'var(--surface-hi)' }}
          >
            <EmptyState
              glyph={<ProvidersIcon width={20} height={20} />}
              title="No chat-capable providers yet"
              body="Add a provider with a default chat model in Library. You can attach it to this agent later."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  trailing={<ArrowRightIcon width={14} height={14} />}
                  onClick={() => {
                    onClose()
                    navigate('/library/providers')
                  }}
                >
                  Go to providers
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <Dropdown
              value={providerId}
              onChange={setProviderId}
              options={providerOpts}
              placeholder="Pick a provider"
            />
            <span className="ab-field-help">
              The provider's default model is what the agent uses. Skip for
              now if you want to wire one up later.
            </span>
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Wrapper. Bumps an internal counter when `open` transitions from false
 * to true so the form remounts on every fresh open. The bump happens
 * during render via a ref guard, which is a recognised "derived state
 * from props" pattern (no useEffect needed).
 */
export function CreateAgentSheet({
  open,
  onClose,
}: {
  open: boolean
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
      <Sheet open={false} onClose={onClose} title="New agent">
        <></>
      </Sheet>
    )
  }
  return <CreateAgentForm key={openCount} onClose={onClose} />
}
