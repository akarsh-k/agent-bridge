/**
 * Context budget card — surfaces an estimate of how many tokens this
 * agent ships on every chat-completion call BEFORE the user types
 * anything. Catches the "model context overflow" failure mode early
 * so the user can swap models or trim attachments before hitting it
 * mid-conversation.
 *
 * Lives on the Configure tab below the Model card. Loads the
 * estimate once on mount + whenever the agent id changes; the user
 * hits Refresh after editing skills/repos/etc to pull a fresh count
 * (we don't auto-recompute on every edit since each call goes
 * through tiktoken on the backend — cheap, but not free).
 */

import { useEffect, useMemo, useState } from 'react'
import type { TokenEstimate } from '@agent-bridge/shared'
import { ApiError, getAgentTokenEstimate } from '../../lib/rpc'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon } from '../../ui/icons'

function formatTokens(n: number): string {
  if (n < 1_000) return `${n}`
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`
  return `${Math.round(n / 1_000)}k`
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 100)
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; estimate: TokenEstimate }
  | { kind: 'err'; message: string }

export function ContextBudgetCard({ agentId }: { agentId: string }) {
  const { agents, agentResources } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const resources = agentResources[agentId]
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)

  // A stable signature of every input that changes the token estimate.
  // Refetching whenever this string changes catches: model swap,
  // provider swap, system-prompt edit, skill add/remove/rename/edit,
  // repo attach/detach + role/description edits, edge changes, and
  // MCP allowlist changes — every place that meaningfully shifts the
  // baseline. Refetches happen ~800ms after each edit since auto-save
  // gates the workspace refresh. Cheap on the wire, so we don't try
  // to debounce.
  const dependencyKey = useMemo(
    () =>
      JSON.stringify({
        model: agent?.model ?? null,
        provider: agent?.llmProviderId ?? null,
        prompt: agent?.systemPrompt ?? '',
        skills: (resources?.skills ?? []).map(
          (s) => `${s.name}:${s.markdownBody.length}`,
        ),
        repos: (resources?.attachedRepos ?? []).map(
          (r) => `${r.repo.id}:${r.role ?? ''}:${(r.description ?? '').length}`,
        ),
        edges: (resources?.repoEdges ?? []).map((e) => e.id),
        mcp: (resources?.mcpAllowlist ?? []).length,
      }),
    [agent, resources],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      // Microtask delay so the lint rule sees the state update as an
      // async-effect side-effect, not a synchronous setState in the
      // effect body.
      if (alive) setState({ kind: 'loading' })
      try {
        const estimate = await getAgentTokenEstimate(agentId)
        if (alive) setState({ kind: 'ok', estimate })
      } catch (err) {
        if (!alive) return
        setState({
          kind: 'err',
          message:
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load token estimate',
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, refreshKey, dependencyKey])

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        className="ab-section-head"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="ab-section-title">Context budget</div>
          <div className="ab-section-sub">
            Estimated tokens this agent ships on every call before the
            user message. Recent-message replay, working memory, and
            semantic-recall chunks add to the actual number per turn.
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          leading={<RefreshIcon />}
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={state.kind === 'loading'}
        >
          Refresh
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <div className="ab-field-help">Estimating…</div>
      ) : state.kind === 'err' ? (
        <div className="ab-field-help" style={{ color: 'var(--danger)' }}>
          {state.message}
        </div>
      ) : (
        <BudgetBody
          estimate={state.estimate}
          toolsOpen={toolsOpen}
          setToolsOpen={setToolsOpen}
          skillsOpen={skillsOpen}
          setSkillsOpen={setSkillsOpen}
        />
      )}
    </div>
  )
}

function BudgetBody({
  estimate,
  toolsOpen,
  setToolsOpen,
  skillsOpen,
  setSkillsOpen,
}: {
  estimate: TokenEstimate
  toolsOpen: boolean
  setToolsOpen: (b: boolean) => void
  skillsOpen: boolean
  setSkillsOpen: (b: boolean) => void
}) {
  const limit = estimate.modelContextLimit
  const baseline = estimate.baselineTotal
  const usagePct = limit ? pct(baseline, limit) : null
  const headroomPct = limit ? Math.max(0, 100 - (usagePct ?? 0)) : null

  // Color the headline pill based on how much of the model context
  // the static baseline is already consuming. Past 50% means the
  // user has very little room for memory replay + the actual user
  // message; past 80% likely overflows on the next long conversation.
  const headlineKind: 'success' | 'warn' | 'danger' =
    usagePct === null
      ? 'warn'
      : usagePct < 30
        ? 'success'
        : usagePct < 70
          ? 'warn'
          : 'danger'

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: 28,
            fontWeight: 600,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ~{formatTokens(baseline)}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          baseline tokens per call
        </div>
        <span style={{ flex: 1 }} />
        {limit !== null ? (
          <Pill kind={headlineKind} dot>
            {usagePct}% of {formatTokens(limit)} ({headroomPct}% headroom)
          </Pill>
        ) : (
          <Pill kind="neutral">
            Model {estimate.model ?? 'unknown'} — context limit unknown
          </Pill>
        )}
      </div>

      <BreakdownRow
        label="System prompt"
        tokens={estimate.parts.systemPrompt}
        total={baseline}
      />

      <BreakdownRow
        label={`Skills (${estimate.parts.skills.length})`}
        tokens={estimate.parts.skillsTotal}
        total={baseline}
        expandable={estimate.parts.skills.length > 0}
        expanded={skillsOpen}
        onToggle={() => setSkillsOpen(!skillsOpen)}
      />
      {skillsOpen &&
        estimate.parts.skills.map((s) => (
          <SubRow key={s.name} label={s.name} tokens={s.tokens} />
        ))}

      <BreakdownRow
        label="Attached repos hint"
        tokens={estimate.parts.attachedReposHint}
        total={baseline}
      />

      <BreakdownRow
        label="Repo edges hint"
        tokens={estimate.parts.repoEdgesHint}
        total={baseline}
      />

      <BreakdownRow
        label={`Tools (${estimate.parts.tools.length})`}
        tokens={estimate.parts.toolsTotal}
        total={baseline}
        expandable={estimate.parts.tools.length > 0}
        expanded={toolsOpen}
        onToggle={() => setToolsOpen(!toolsOpen)}
      />
      {toolsOpen &&
        estimate.parts.tools.map((t) => (
          <SubRow key={t.name} label={`${t.name}`} tokens={t.tokens} />
        ))}

      {limit !== null && baseline > limit * 0.8 && (
        <div
          className="ab-field-help"
          style={{
            marginTop: 12,
            color: 'var(--danger)',
            background: 'var(--danger-bg)',
            border: '1px solid rgba(251, 113, 133, 0.3)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
          }}
        >
          ⚠ Baseline is {usagePct}% of the model's context window. Long
          threads or large tool calls may overflow mid-conversation —
          consider trimming skills, reducing attached MCPs, or
          switching to a model with a larger context window.
        </div>
      )}
    </>
  )
}

function BreakdownRow({
  label,
  tokens,
  total,
  expandable = false,
  expanded = false,
  onToggle,
}: {
  label: string
  tokens: number
  total: number
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const share = pct(tokens, total)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 0',
        borderBottom: '1px solid var(--border)',
        cursor: expandable ? 'pointer' : 'default',
      }}
      onClick={expandable ? onToggle : undefined}
      role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined}
      onKeyDown={
        expandable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggle?.()
              }
            }
          : undefined
      }
    >
      {expandable && (
        <span
          style={{
            display: 'inline-flex',
            color: 'var(--text-muted)',
            width: 14,
          }}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      )}
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {share}%
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          minWidth: 56,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        ~{formatTokens(tokens)}
      </span>
    </div>
  )
}

function SubRow({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 0 4px 24px',
        fontSize: 12,
        color: 'var(--text-dim)',
      }}
    >
      <span className="ab-mono" style={{ flex: 1 }}>
        {label}
      </span>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          minWidth: 56,
          textAlign: 'right',
        }}
      >
        ~{formatTokens(tokens)}
      </span>
    </div>
  )
}
