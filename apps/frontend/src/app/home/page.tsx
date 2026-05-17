/**
 * Home — quick orientation page. If the workspace is empty, lead
 * with a 3-step onboarding checklist; otherwise show a digest of
 * agents / providers / repos / MCPs and a "resume where you left
 * off" featured card for the most recently touched agent.
 */

import { useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Link } from '../../lib/link'
import { PageHeader } from '../_chrome/page-header'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { agentGlyphKind } from '../../lib/agent-helpers'
import {
  ArrowRightIcon,
  CheckIcon,
  PlusIcon,
  ProvidersIcon,
  ReposIcon,
  AgentsIcon,
  BridgeIcon,
} from '../../ui/icons'
import { navigate } from '../../lib/router'
import { ProviderCreateSheet } from '../../features/library/provider-create-sheet'
import { RepoCreateSheet } from '../../features/library/repo-create-sheet'
import { CreateAgentSheet } from '../../features/agent-builder/create-agent-sheet'

export function HomePage() {
  const { agents, llmProviders, repos, mcpConnections } = useWorkspace()

  const lastTouched = [...agents].sort(
    (a, b) =>
      new Date(b.updatedAt ?? 0).getTime() -
      new Date(a.updatedAt ?? 0).getTime(),
  )[0]

  // Show the setup checklist whenever no agent exists — even if the
  // user has already added providers or repos. The first agent is
  // what unlocks the IDE bridge, so until that lands we keep guiding
  // them. Checked steps stay checked, so a partially-set-up
  // workspace just sees fewer remaining items.
  if (agents.length === 0) {
    return <FirstRun />
  }

  return (
    <div className="ab-page">
      <PageHeader
        title="Welcome back"
        subtitle="Bridge your IDE to custom agents wired to your repos, providers, and MCP integrations."
        actions={
          <Button
            variant="primary"
            onClick={() => navigate('/agents')}
            leading={<PlusIcon strokeWidth={2.4} />}
          >
            New agent
          </Button>
        }
      />

      <div className="ab-stat-grid">
        <Stat label="Agents" value={agents.length} />
        <Stat label="LLM providers" value={llmProviders.length} />
        <Stat label="Repositories" value={repos.length} />
        <Stat label="MCP connections" value={mcpConnections.length} />
      </div>

      {lastTouched ? (
        <Link
          to={`/agents/${lastTouched.id}`}
          className="ab-card ab-card-link ab-card-pad ab-card-featured"
          style={{ display: 'block', marginBottom: 14 }}
        >
          <div className="ab-agent-head">
            <div
              className={`ab-glyph ab-glyph-${agentGlyphKind(lastTouched.id)}`}
            >
              {(lastTouched.name ?? 'A').charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="ab-agent-name">{lastTouched.name}</div>
              <div className="ab-agent-slug">{lastTouched.slug}</div>
            </div>
            <Pill kind="accent" className="ab-ml-auto">
              Most recent
            </Pill>
          </div>
          <div className="ab-agent-body">
            {lastTouched.description?.trim() ||
              'Open the agent to keep configuring its prompt, repos, and bridge.'}
          </div>
        </Link>
      ) : (
        <div className="ab-card ab-card-pad">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <div className="ab-section-title">Build your first agent</div>
              <div className="ab-section-sub" style={{ marginTop: 4 }}>
                An agent is a system prompt plus the tools and repos it can
                reach. Wire one up and it becomes a callable tool inside
                your IDE.
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <Button
                variant="primary"
                onClick={() => navigate('/agents')}
                trailing={<ArrowRightIcon />}
              >
                Get started
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="ab-card ab-stat">
      <div className="ab-stat-label">{label}</div>
      <div className="ab-stat-value">{value}</div>
    </div>
  )
}

// ─── First-run flow ──────────────────────────────────────────────────────

function FirstRun() {
  const { llmProviders, repos, agents } = useWorkspace()
  const [providerSheetRole, setProviderSheetRole] = useState<
    'chat' | 'embedding' | null
  >(null)
  const [repoSheet, setRepoSheet] = useState(false)
  const [agentSheet, setAgentSheet] = useState(false)

  const chatProviderDone = llmProviders.some((p) => p.role === 'chat')
  const embeddingProviderDone = llmProviders.some(
    (p) => p.role === 'embedding',
  )
  const repoDone = repos.length > 0
  const agentDone = agents.length > 0

  // Required vs optional: chat provider + agent are gates (no agent
  // runs without them); embedding + repo are recommended (needed
  // only for coding-helper / inspector agents). Order goes
  // chat → embedding → repo → agent so each step builds on the
  // previous one.
  const steps: ReadonlyArray<Step> = [
    {
      n: 1,
      title: 'Add a chat provider',
      body: 'Anthropic, OpenAI, or any OpenAI-compatible endpoint. Answers every turn the agent takes.',
      cta: 'Add chat provider',
      Icon: ProvidersIcon,
      done: chatProviderDone,
      onClick: () => setProviderSheetRole('chat'),
    },
    {
      n: 2,
      title: 'Add an embedding provider',
      body: 'Workspace-wide. Powers code search for coding-helper agents. Skip if you only plan to build non-code helpers.',
      cta: 'Add embedding provider',
      Icon: ProvidersIcon,
      done: embeddingProviderDone,
      optional: true,
      onClick: () => setProviderSheetRole('embedding'),
    },
    {
      n: 3,
      title: 'Attach a repository',
      body: 'Optional but recommended — once cloned, a coding-helper can read source, generate a wiki, and answer questions about the code.',
      cta: 'Add repository',
      Icon: ReposIcon,
      done: repoDone,
      optional: true,
      onClick: () => setRepoSheet(true),
    },
    {
      n: 4,
      title: 'Create your first agent',
      body: 'Name it, give it a system prompt, pick a provider. It becomes callable from your IDE through the bridge.',
      cta: 'Create agent',
      Icon: AgentsIcon,
      done: agentDone,
      onClick: () => setAgentSheet(true),
    },
  ]

  return (
    <div className="ab-page">
      <PageHeader
        title="Welcome to Agent Bridge"
        subtitle="A few steps to your first IDE-callable agent. Coding helpers need both a chat provider AND an embedding provider — non-code agents only need the chat one."
      />

      <div
        className="ab-card ab-card-pad ab-card-featured ab-firstrun-hero"
        style={{ marginBottom: 18 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div className="ab-glyph ab-glyph-violet">
            <BridgeIcon />
          </div>
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">
              Get your first agent running
            </div>
            <div className="ab-section-sub" style={{ marginTop: 4 }}>
              Each step takes a minute. You can come back here any time — every
              action lives under Library and Agents in the sidebar too.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          marginBottom: 18,
        }}
      >
        {steps.map((s) => (
          <StepCard key={s.n} step={s} />
        ))}
      </div>

      <ProviderCreateSheet
        open={providerSheetRole !== null}
        defaultRole={providerSheetRole ?? 'chat'}
        onClose={() => setProviderSheetRole(null)}
      />
      <RepoCreateSheet
        open={repoSheet}
        onClose={() => setRepoSheet(false)}
      />
      <CreateAgentSheet
        open={agentSheet}
        onClose={() => setAgentSheet(false)}
      />
    </div>
  )
}

interface Step {
  n: number
  title: string
  body: string
  cta: string
  Icon: React.ComponentType<{ width?: number; height?: number }>
  done: boolean
  optional?: boolean
  onClick: () => void
}

function StepCard({ step }: { step: Step }) {
  const { Icon } = step
  return (
    <div
      className="ab-card ab-card-pad"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        opacity: step.done ? 0.7 : 1,
      }}
    >
      <div
        className={`ab-glyph ${step.done ? 'ab-glyph-green' : 'ab-glyph-violet'}`}
        aria-hidden="true"
      >
        {step.done ? (
          <CheckIcon width={18} height={18} strokeWidth={2.6} />
        ) : (
          <Icon width={18} height={18} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
            Step {step.n}
          </span>
          <span>{step.title}</span>
          {step.optional && (
            <Pill kind="neutral">Optional</Pill>
          )}
          {step.done && (
            <Pill kind="success">Done</Pill>
          )}
        </div>
        <div
          className="ab-section-sub"
          style={{ marginTop: 4, fontSize: 13 }}
        >
          {step.body}
        </div>
      </div>
      <Button
        variant={step.done ? 'ghost' : 'primary'}
        onClick={step.onClick}
        trailing={step.done ? undefined : <ArrowRightIcon strokeWidth={2.4} />}
      >
        {step.done ? 'Add another' : step.cta}
      </Button>
    </div>
  )
}
