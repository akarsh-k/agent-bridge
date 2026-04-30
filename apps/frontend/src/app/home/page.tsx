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
import { BridgeRow, type IDEKind } from '../../ui/bridge-row'
import { agentGlyphKind, deriveAgentBridges } from '../../lib/agent-helpers'
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

  const bridges: ReadonlyArray<IDEKind> = lastTouched
    ? deriveAgentBridges(lastTouched.id)
    : []

  // Cold-start triggers the checklist when nothing's been wired up
  // anywhere yet. The repo step is optional — agents work without
  // any repo attached — so we don't gate "create agent" on it.
  const isFirstRun =
    agents.length === 0 &&
    llmProviders.length === 0 &&
    repos.length === 0 &&
    mcpConnections.length === 0

  if (isFirstRun) {
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
            <Pill kind="accent" dot className="ab-ml-auto">
              <span style={{ paddingLeft: 0 }}>Most recent</span>
            </Pill>
          </div>
          <div className="ab-agent-body">
            {lastTouched.description?.trim() ||
              'Open the agent to keep configuring its prompt, repos, and bridge.'}
          </div>
          <BridgeRow ides={bridges} live />
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
  const [providerSheet, setProviderSheet] = useState(false)
  const [repoSheet, setRepoSheet] = useState(false)
  const [agentSheet, setAgentSheet] = useState(false)

  const providerDone = llmProviders.length > 0
  const repoDone = repos.length > 0
  const agentDone = agents.length > 0

  // Step 3 (agent) needs at least one provider to actually run, but
  // we let the user create a draft agent without one — the agent
  // detail page will surface the missing-provider banner.
  const steps: ReadonlyArray<Step> = [
    {
      n: 1,
      title: 'Add an LLM provider',
      body: 'Connect Anthropic, OpenAI, or any OpenAI-compatible endpoint. Your agent borrows its model from a provider.',
      cta: 'Add provider',
      Icon: ProvidersIcon,
      done: providerDone,
      onClick: () => setProviderSheet(true),
    },
    {
      n: 2,
      title: 'Attach a repository',
      body: 'Optional but recommended — once cloned, your agent can read source, generate a wiki, and answer questions about the code.',
      cta: 'Add repository',
      Icon: ReposIcon,
      done: repoDone,
      optional: true,
      onClick: () => setRepoSheet(true),
    },
    {
      n: 3,
      title: 'Create your first agent',
      body: 'Name it, give it a system prompt, pick a provider. It becomes callable from your IDE through the bridge.',
      cta: 'Create agent',
      Icon: AgentsIcon,
      done: agentDone,
      onClick: () => setAgentSheet(true),
    },
  ]

  const allCriticalDone = providerDone && agentDone

  return (
    <div className="ab-page">
      <PageHeader
        title="Welcome to Agent Bridge"
        subtitle="Three steps to your first IDE-callable agent. Walks through provider, repo (optional), and agent."
      />

      <div
        className="ab-card ab-card-pad ab-card-featured ab-firstrun-hero"
        data-celebrating={allCriticalDone || undefined}
        style={{ marginBottom: 18 }}
      >
        {allCriticalDone && <CelebrateBurst />}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            className={
              allCriticalDone ? 'ab-glyph ab-glyph-green' : 'ab-glyph ab-glyph-violet'
            }
            style={{ transition: 'background var(--dur-3) var(--ease-out)' }}
          >
            {allCriticalDone ? (
              <CheckIcon strokeWidth={2.6} />
            ) : (
              <BridgeIcon />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">
              {allCriticalDone
                ? 'You’re wired up — connect your IDE'
                : 'Get your first agent running'}
            </div>
            <div className="ab-section-sub" style={{ marginTop: 4 }}>
              {allCriticalDone
                ? 'Provider + agent are live. Drop the MCP config into Cursor / Claude Code / Codex and you’ll see your agent show up as a callable tool.'
                : 'Each step takes a minute. You can come back here any time — every action lives under Library and Agents in the sidebar too.'}
            </div>
          </div>
          {allCriticalDone && (
            <Button
              variant="primary"
              onClick={() => navigate('/bridge')}
              trailing={<ArrowRightIcon strokeWidth={2.4} />}
            >
              Open Bridge
            </Button>
          )}
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
        open={providerSheet}
        onClose={() => setProviderSheet(false)}
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

function CelebrateBurst() {
  // Six accent-coloured rays fanning out from behind the glyph.
  const rays = [0, 60, 120, 180, 240, 300]
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        borderRadius: 'inherit',
      }}
    >
      <div
        className="ab-celebrate-glow"
        style={{
          position: 'absolute',
          left: 36,
          top: '50%',
          width: 80,
          height: 80,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background:
            'radial-gradient(closest-side, rgba(52, 211, 153, 0.45), transparent 70%)',
        }}
      />
      {rays.map((angle, i) => (
        <span
          key={angle}
          className="ab-celebrate-ray"
          style={{
            position: 'absolute',
            left: 36,
            top: '50%',
            width: 1,
            height: 24,
            transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-22px)`,
            background: 'var(--success)',
            borderRadius: 1,
            opacity: 0,
            animation: `ab-burst 700ms ${i * 30}ms var(--ease-out) forwards`,
          }}
        />
      ))}
    </div>
  )
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
        style={{
          width: 36,
          height: 36,
          borderRadius: 'var(--radius)',
          background: step.done ? 'var(--success-bg)' : 'var(--accent-bg)',
          color: step.done ? 'var(--success)' : 'var(--accent-300)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          border:
            '1px solid ' +
            (step.done
              ? 'rgba(52, 211, 153, 0.32)'
              : 'var(--accent-border)'),
        }}
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
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span>{step.title}</span>
          {step.optional && (
            <Pill kind="neutral">Optional</Pill>
          )}
          {step.done && (
            <Pill kind="success" dot>
              Done
            </Pill>
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
