import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentResponse } from '@agent-bridge/shared'
import { SkillForm } from './skill-form'
import { ToolForm } from './tool-form'
import { RepoPicker } from './repo-picker'
import { RepoNewForm } from './repo-new-form'
import { LlmPicker } from './llm-picker'
import { LlmNewForm } from './llm-new-form'

import './index.css'

export type AddResourceKind = 'skill' | 'tool' | 'repo' | 'llm'

type PanelView =
  | AddResourceKind
  | 'repo-new'
  | 'llm-new'

const KINDS: readonly {
  kind: AddResourceKind
  title: string
  hint: string
  glyph: string
}[] = [
  {
    kind: 'skill',
    title: 'Skill',
    hint: 'Reusable prompt and behavior guidance',
    glyph: 'S',
  },
  {
    kind: 'tool',
    title: 'Tool',
    hint: 'Callable capability the agent can use',
    glyph: 'T',
  },
  {
    kind: 'repo',
    title: 'Repository',
    hint: 'Attach source code context',
    glyph: 'R',
  },
  {
    kind: 'llm',
    title: 'LLM provider',
    hint: 'Assign or create a model provider',
    glyph: 'L',
  },
]

export function AddResourcePanel({
  agent,
  initialKind,
  onClose,
}: {
  readonly agent: AgentResponse
  readonly initialKind?: AddResourceKind
  readonly onClose: () => void
}) {
  const [view, setView] = useState<PanelView>(initialKind ?? 'skill')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activeKind: AddResourceKind = useMemo(() => {
    if (view === 'repo-new') return 'repo'
    if (view === 'llm-new') return 'llm'
    return view
  }, [view])

  const closeAfterDone = useCallback(() => onClose(), [onClose])
  const keepOpenAfterDone = useCallback(() => {}, [])

  return (
    <div
      className="add-resource-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="add-resource-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Add resource to ${agent.name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="add-resource-header">
          <div>
            <div className="add-resource-eyebrow">Add to agent</div>
            <h2>{agent.name}</h2>
            <p>
              Add the context and capabilities this agent should use.
            </p>
          </div>
          <button
            type="button"
            className="add-resource-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <span aria-hidden="true" />
          </button>
        </header>

        <div className="add-resource-body">
          <nav className="add-resource-nav" aria-label="Resource type">
            {KINDS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className={`add-resource-nav-item${
                  activeKind === item.kind ? ' active' : ''
                }`}
                onClick={() => setView(item.kind)}
              >
                <span className={`add-resource-glyph ${item.kind}`}>
                  {item.glyph}
                </span>
                <span>
                  <span className="add-resource-nav-title">{item.title}</span>
                  <span className="add-resource-nav-hint">{item.hint}</span>
                </span>
              </button>
            ))}
          </nav>

          <main className="add-resource-main">{renderView()}</main>
        </div>
      </section>
    </div>
  )

  function renderView() {
    switch (view) {
      case 'skill':
        return (
          <PanelSection
            title="Add skill"
            subtitle="Skills are prompt fragments and behavior instructions that shape every run."
          >
            <SkillForm
              agentId={agent.id}
              onCancel={onClose}
              onDone={keepOpenAfterDone}
            />
          </PanelSection>
        )
      case 'tool':
        return (
          <PanelSection
            title="Add tool"
            subtitle="Tools are callable capabilities exposed to the Mastra agent."
          >
            <ToolForm
              agentId={agent.id}
              onCancel={onClose}
              onDone={keepOpenAfterDone}
            />
          </PanelSection>
        )
      case 'repo':
        return (
          <PanelSection
            title="Attach repository"
            subtitle="Attach existing source context, or create a new repo record."
          >
            <RepoPicker
              agentId={agent.id}
              onCreateNew={() => setView('repo-new')}
              onDone={keepOpenAfterDone}
            />
          </PanelSection>
        )
      case 'repo-new':
        return (
          <PanelSection
            title="New repository"
            subtitle="Create a repo record and attach it to this agent in one step."
            onBack={() => setView('repo')}
          >
            <RepoNewForm
              agentId={agent.id}
              onCancel={() => setView('repo')}
              onDone={closeAfterDone}
            />
          </PanelSection>
        )
      case 'llm':
        return (
          <PanelSection
            title="Assign LLM provider"
            subtitle="Pick the model backend this agent should use."
          >
            <LlmPicker
              agentId={agent.id}
              onCreateNew={() => setView('llm-new')}
              onDone={keepOpenAfterDone}
            />
          </PanelSection>
        )
      case 'llm-new':
        return (
          <PanelSection
            title="New LLM provider"
            subtitle="Create a provider and assign it to this agent."
            onBack={() => setView('llm')}
          >
            <LlmNewForm
              agentId={agent.id}
              onCancel={() => setView('llm')}
              onDone={closeAfterDone}
            />
          </PanelSection>
        )
    }
  }
}

function PanelSection({
  title,
  subtitle,
  onBack,
  children,
}: {
  readonly title: string
  readonly subtitle: string
  readonly onBack?: () => void
  readonly children: ReactNode
}) {
  return (
    <div className="add-resource-section">
      {onBack ? (
        <div className="add-resource-section-nav">
          <button
            type="button"
            className="add-resource-back"
            onClick={onBack}
            aria-label="Back"
          >
            <span className="add-resource-back-icon" aria-hidden="true" />
            <span>Back</span>
          </button>
        </div>
      ) : null}
      <div className="add-resource-section-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  )
}
