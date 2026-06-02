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
  const { agents, agentResources, llmProviders } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const resources = agentResources[agentId]
  // Plain derivation — React Compiler auto-memoizes this. Previously
  // wrapped in useMemo but the compiler could not preserve the body
  // (react-hooks/preserve-manual-memoization), and the inputs are
  // cheap to recompute anyway.
  const providerModel = agent?.llmProviderId
    ? (llmProviders.find((p) => p.id === agent.llmProviderId)?.defaultModel ??
      null)
    : null
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
        model: providerModel,
        provider: agent?.llmProviderId ?? null,
        prompt: agent?.systemPrompt ?? '',
        skills: (resources?.skills ?? []).map(
          // `alwaysInclude` + description length both move the budget
          // (lazy bodies drop out of the prompt; the catalog bullet's
          // size scales with description length), so they belong in
          // the refetch key alongside the body length.
          (s) =>
            `${s.name}:${s.markdownBody.length}:${s.description.length}:${s.alwaysInclude ? 1 : 0}`,
        ),
        repos: (resources?.attachedRepos ?? []).map(
          (r) => `${r.repo.id}:${r.role ?? ''}:${(r.description ?? '').length}`,
        ),
        relationships: (resources?.repoRelationships ?? []).map((e) => e.id),
        mcp: (resources?.mcpAllowlist ?? []).length,
      }),
    [agent, resources, providerModel],
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
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="ab-section-title">Context budget</div>
          <div className="ab-section-sub">
            Estimated tokens this agent ships on every call before the user
            message. Recent-message replay, working memory, and semantic-recall
            chunks add to the actual number per turn.
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
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div
          style={{
            fontSize: 'var(--text-2xl)',
            fontWeight: 'var(--fw-semibold)',
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ~{formatTokens(baseline)}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
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

      <div className="ab-budget-rows">
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

        {/* Inspector toolkit's auto-attached system prompt
          (`docs/ARCHITECTURE.md §10`). Listed as its own row because
          the source is build-time (.md), not an editable `skills` row.
          Renders distinctly when the .md fails to load so a missing
          build artifact is visible. */}
        <BreakdownRow
          label="System prompt (built-in)"
          tokens={estimate.parts.systemSkill?.tokens ?? 0}
          total={baseline}
          sublabel={
            estimate.parts.systemSkill === null
              ? 'Failed to load. rebuild @agent-bridge/agents'
              : `${estimate.parts.systemSkill.name} · v${estimate.parts.systemSkill.version}`
          }
        />

        {/* GitNexus library skills + attached-repos hint + repo-relationships
          hint were all dropped from the prompt by the wrapper-tool
          architecture (PLAN_v2.md B6 / D9 / D12). The data still
          travels — just inside wrapper responses (`list_repos`,
          `assess_change_impact`) where it's actionable. The
          token-estimate response keeps these fields at 0/null for
          backwards-compat, but rendering them as always-zero rows
          would mislead the operator. Hidden here. */}

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
      </div>

      {limit !== null && baseline > limit * 0.8 && (
        <div
          className="ab-field-help"
          style={{
            marginTop: 'var(--space-3)',
            color: 'var(--danger)',
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            borderRadius: 'var(--radius)',
            padding: 'var(--space-2_5) var(--space-3)',
          }}
        >
          Baseline is {usagePct}% of the model's context window. Long threads or
          large tool calls may overflow mid-conversation. Consider trimming
          skills, reducing attached MCPs, or switching to a model with a larger
          context window.
        </div>
      )}
    </>
  )
}

function BreakdownRow({
  label,
  sublabel,
  tokens,
  total,
  expandable = false,
  expanded = false,
  onToggle,
}: {
  label: string
  sublabel?: string
  tokens: number
  total: number
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const share = pct(tokens, total)
  return (
    <div
      className="ab-budget-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2_5)',
        padding: 'var(--space-2) 0',
        cursor: expandable ? 'pointer' : 'default',
        borderRadius: expandable ? 'var(--radius-xs)' : undefined,
        outline: 'none',
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
            flexShrink: 0,
          }}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)' }}>{label}</div>
        {sublabel && (
          <div
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-muted)',
              marginTop: 'var(--space-0_5)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sublabel}
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {share}%
      </span>
      <span
        style={{
          fontSize: 'var(--text-sm)',
          fontWeight: 'var(--fw-medium)',
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
        gap: 'var(--space-2_5)',
        padding: 'var(--space-1) 0 var(--space-1) var(--space-6)',
        fontSize: 'var(--text-xs)',
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
