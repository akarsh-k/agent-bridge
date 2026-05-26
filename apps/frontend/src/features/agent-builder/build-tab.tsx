/**
 * Profile section — Identity + Provider. There is no inline Save
 * affordance: edits stay in local state and only persist when the
 * user tries to navigate away (in-app tab switch, sidebar nav, or
 * browser close), at which point the global NavGuardModal asks
 * Save / Discard / Stay. A small "Unsaved" pill in the section
 * header is the only ambient indicator that work isn't persisted.
 *
 * Why no inline button: per request — we want a quieter editing
 * surface and use the modal as the single decision point. The
 * trade-off is that the user has no one-click "save now" in the
 * page; in practice they save by navigating somewhere and choosing
 * "Save & continue" on the modal.
 *
 * The agent does not own a model field — the chosen provider's
 * `defaultModel` is what runs.
 */

import { useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Pill } from '../../ui/pill'
import { useNavGuard } from '../../lib/use-nav-guard'
import { ContextBudgetCard } from './context-budget-card'

const LOCAL_KINDS = new Set(['llama_cpp', 'ollama', 'openai_compatible'])

export function BuildTab({ agentId }: { agentId: string }) {
  const { agents, llmProviders, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)

  // Re-seed via the "adjust state based on props" pattern whenever the
  // active agent changes — keeps form state in sync without a useEffect.
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  // Blank string = "use default"; positive integer = override. We keep
  // the input as a string so the user can clear the field cleanly
  // (controlled inputs of type=number with `value={null}` warn). Parsed
  // to `number | null` at save time.
  const [maxStepsInput, setMaxStepsInput] = useState('')
  // Per-wrapper codebase-inspection-report token cap. Same blank-as-default
  // convention as `maxStepsInput`. Range is 2_000–64_000 (mirrors the DTO bounds).
  const [reportCapInput, setReportCapInput] = useState('')

  const parsedMaxSteps = useMemo<number | null | 'invalid'>(() => {
    const trimmed = maxStepsInput.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      return 'invalid'
    }
    return n
  }, [maxStepsInput])

  const parsedReportCap = useMemo<number | null | 'invalid'>(() => {
    const trimmed = reportCapInput.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    if (
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < 2_000 ||
      n > 64_000
    ) {
      return 'invalid'
    }
    return n
  }, [reportCapInput])

  const draft = useMemo(
    () => ({
      name: name.trim(),
      slug,
      systemPrompt,
      llmProviderId: providerId,
      maxSteps: parsedMaxSteps === 'invalid' ? null : parsedMaxSteps,
      codebaseInspectionReportTokenCap:
        parsedReportCap === 'invalid' ? null : parsedReportCap,
    }),
    [name, slug, systemPrompt, providerId, parsedMaxSteps, parsedReportCap],
  )

  const isDirty = useMemo(() => {
    if (!agent) return false
    if (seededFor !== agent.id) return false
    // `draft.name` is already trimmed (so save() sends a clean
    // value); trim agent.name on this side too so a stored name
    // with stray whitespace doesn't read as dirty the moment the
    // form mounts.
    return (
      draft.name !== agent.name.trim() ||
      draft.slug !== agent.slug ||
      draft.systemPrompt !== agent.systemPrompt ||
      draft.llmProviderId !== agent.llmProviderId ||
      draft.maxSteps !== agent.maxSteps ||
      draft.codebaseInspectionReportTokenCap !== agent.codebaseInspectionReportTokenCap
    )
  }, [agent, seededFor, draft])

  // Browser-tab close / refresh guard. Native prompt only — modern
  // browsers ignore custom messages.
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  // Register an in-app nav guard while dirty. The modal aggregates
  // every dirty section under the agent (Identity, Memory, …) and
  // calls save/discard on each when the user resolves it.
  useNavGuard('agent-build', {
    label: 'Identity',
    dirty: isDirty,
    save: async () => {
      if (!agent) return
      if (!draft.name) {
        toast.error('Name is required before saving.')
        throw new Error('name required')
      }
      if (parsedMaxSteps === 'invalid') {
        toast.error('Step limit must be an integer between 1 and 100.')
        throw new Error('maxSteps invalid')
      }
      if (parsedReportCap === 'invalid') {
        toast.error(
          'Tool response budget must be an integer between 2,000 and 64,000.',
        )
        throw new Error('codebaseInspectionReportTokenCap invalid')
      }
      try {
        await patchAgent(agent.id, {
          name: draft.name,
          slug: draft.slug,
          systemPrompt: draft.systemPrompt,
          llmProviderId: draft.llmProviderId,
          maxSteps: draft.maxSteps,
          codebaseInspectionReportTokenCap: draft.codebaseInspectionReportTokenCap,
        })
        toast.success('Identity saved')
      } catch (e) {
        toast.error(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Save failed',
        )
        throw e
      }
    },
    discard: () => {
      if (!agent) return
      setName(agent.name)
      setSlug(agent.slug)
      setSystemPrompt(agent.systemPrompt)
      setProviderId(agent.llmProviderId)
      setMaxStepsInput(agent.maxSteps === null ? '' : String(agent.maxSteps))
      setReportCapInput(
        agent.codebaseInspectionReportTokenCap === null ? '' : String(agent.codebaseInspectionReportTokenCap),
      )
    },
  })

  if (agent && seededFor !== agent.id) {
    setSeededFor(agent.id)
    setName(agent.name)
    setSlug(agent.slug)
    setSystemPrompt(agent.systemPrompt)
    setProviderId(agent.llmProviderId)
    setMaxStepsInput(agent.maxSteps === null ? '' : String(agent.maxSteps))
    setReportCapInput(
      agent.codebaseInspectionReportTokenCap === null ? '' : String(agent.codebaseInspectionReportTokenCap),
    )
  }

  const provider = useMemo(
    () => llmProviders.find((p) => p.id === providerId) ?? null,
    [llmProviders, providerId],
  )

  // Only chat-role providers are listed. Embedding providers serve
  // `/v1/embeddings` only, so they can't answer chat completions.
  const providerOpts: DropdownOption[] = useMemo(
    () =>
      llmProviders
        .filter((p) => p.role === 'chat')
        .map((p) => {
          const hasModel = !!p.defaultModel
          const needsKey = !p.apiKey.set && !LOCAL_KINDS.has(p.kind)
          const disabled = !hasModel || needsKey
          return {
            value: p.id,
            label: p.label,
            sub: p.defaultModel ?? `${p.kind} · no model set`,
            disabled,
            disabledReason: !hasModel
              ? 'Provider has no model set — pick one in Library'
              : needsKey
                ? 'No API key set on this provider'
                : undefined,
          }
        }),
    [llmProviders],
  )

  if (!agent) return null

  return (
    <div>
      {/* Identity */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">
            Identity
            <span style={{ marginLeft: 10 }}>
              <Pill kind={agent.inspectorEnabled ? 'accent' : 'neutral'}>
                {agent.inspectorEnabled
                  ? 'Repo inspector'
                  : 'Build your own agent'}
              </Pill>
            </span>
            {isDirty && (
              <span
                className="ab-dirty-dot"
                aria-label="Unsaved changes in this section"
                title="Unsaved · saves when you leave or hit Save all"
              />
            )}
          </div>
          <div className="ab-section-sub">
            How the agent introduces itself when called from your IDE.
            {agent.inspectorEnabled
              ? ' Inspector toolkit auto-attached; toggle from the Tools tab.'
              : ' No built-in toolkit. Add the Inspector toolkit from the Tools tab if you want code-search wrappers.'}
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="b-name">
              Name
            </label>
            <input
              id="b-name"
              className="ab-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="b-slug">
              Slug
            </label>
            <input
              id="b-slug"
              className="ab-input ab-mono"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            {slug !== agent.slug && (
              <span
                className="ab-field-help"
                style={{ color: 'var(--warn)' }}
              >
                ⚠ IDE tool name{agent.inspectorEnabled ? 's' : ''} will
                change to{' '}
                <code className="ab-mono">{slug || '<slug>'}__ask_agent</code>
                {agent.inspectorEnabled && (
                  <>
                    {' '}+{' '}
                    <code className="ab-mono">
                      {slug || '<slug>'}__inspect_codebase
                    </code>
                  </>
                )}{' '}
                — connected IDEs need to reconnect to pick up the rename.
              </span>
            )}
          </div>
          <div
            id="agent-prompt-section"
            className="ab-field ab-field-col"
            style={{ scrollMarginTop: 80 }}
          >
            <label className="ab-field-label" htmlFor="b-prompt">
              System prompt
            </label>
            <textarea
              id="b-prompt"
              className="ab-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
            />
            <span className="ab-field-help">
              Prepended to every conversation. Markdown supported.
            </span>
          </div>
        </div>
      </div>

      {/* Provider */}
      <div
        id="agent-provider-section"
        className="ab-card ab-card-pad ab-form-section"
        style={{ scrollMarginTop: 80 }}
      >
        <div className="ab-section-head">
          <div className="ab-section-title">Provider</div>
          <div className="ab-section-sub">
            Which provider answers chat for this agent. The provider's{' '}
            <code className="ab-mono">defaultModel</code> is what runs —
            change it on the provider page if you want a different model.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <span className="ab-field-label">Provider</span>
            <Dropdown
              value={providerId}
              onChange={setProviderId}
              options={providerOpts}
              placeholder={
                providerOpts.length === 0
                  ? 'No providers yet — add one in Library'
                  : 'Pick a provider'
              }
              disabled={providerOpts.length === 0}
            />
            {provider && (
              <span className="ab-field-help">
                Model:{' '}
                <code className="ab-mono">
                  {provider.defaultModel ?? '(not set)'}
                </code>
              </span>
            )}
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="b-max-steps">
              Step limit
            </label>
            <input
              id="b-max-steps"
              className="ab-input ab-mono"
              type="text"
              inputMode="numeric"
              placeholder="default (10)"
              value={maxStepsInput}
              onChange={(e) => setMaxStepsInput(e.target.value)}
              aria-invalid={parsedMaxSteps === 'invalid' ? true : undefined}
            />
            <span
              className="ab-field-help"
              style={
                parsedMaxSteps === 'invalid'
                  ? { color: 'var(--warn)' }
                  : undefined
              }
            >
              {parsedMaxSteps === 'invalid'
                ? 'Enter an integer between 1 and 100, or leave blank.'
                : 'How many tool calls the agent can make before it has to give a final answer. Blank uses the default (10). Raise it for agents that need to chase multiple leads through complex code. Lower it for fast Q&A agents where one or two calls is usually enough. Each call carries the previous results forward, so token cost grows quickly as you raise this.'}
            </span>
          </div>
          {agent.inspectorEnabled && (
            <div className="ab-field">
              <label className="ab-field-label" htmlFor="b-inspection-report-cap">
                Tool response budget
              </label>
              <input
                id="b-inspection-report-cap"
                className="ab-input ab-mono"
                type="text"
                inputMode="numeric"
                placeholder="default (12,000 tokens)"
                value={reportCapInput}
                onChange={(e) => setReportCapInput(e.target.value)}
                aria-invalid={
                  parsedReportCap === 'invalid' ? true : undefined
                }
              />
              <span
                className="ab-field-help"
                style={
                  parsedReportCap === 'invalid'
                    ? { color: 'var(--warn)' }
                    : undefined
                }
              >
                {parsedReportCap === 'invalid'
                  ? 'Enter an integer between 2,000 and 64,000, or leave blank.'
                  : 'How much code and context each Inspector tool (find_in_codebase, trace_flow, etc.) can pack into one response. Blank uses the default (12,000 tokens). Raise this if run logs show repeated "dropped … to fit under cap" warnings on large repos. Lower it on small repos to keep responses lean.'}
              </span>
            </div>
          )}
        </div>
      </div>

      <ContextBudgetCard agentId={agentId} />
    </div>
  )
}
