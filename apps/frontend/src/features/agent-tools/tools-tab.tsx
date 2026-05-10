/**
 * Tools tab content (rendered inside `Resources`). Shows the agent's
 * INBOUND tool surface — the inspector wrappers (find_in_codebase,
 * trace_flow, assess_change_impact, debug_help, understand_module,
 * list_repos) auto-mounted when the agent has at least one indexed
 * repo.
 *
 * Native-tool authoring (HTTP / shell / mastra_builtin / custom from
 * the `tools` table) is parked: buildAgent doesn't currently read
 * `schema.tools`, so anything authored here would be persisted but
 * never wired into the runtime Agent. The DB table + backend routes
 * stay intact for a future native-tool initiative; the CRUD UI is
 * hidden so operators don't spend effort on rows nothing consumes.
 * Existing rows (if any) render read-only with an Inactive pill.
 *
 * NOTE: this file ONLY deals with inbound tools. The OUTBOUND surface
 * — what the IDE sees on `tools/list` — lives in
 * `features/agent-bridge-tools/bridge-tools-tab.tsx`. Don't conflate
 * them: same word, opposite directions, two different DB tables.
 * See `docs/ARCHITECTURE.md` §8.
 */

import { useEffect, useState } from 'react'
import type { SystemToolDefinition } from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import { ChevronDownIcon, PlusIcon, ToolIcon } from '../../ui/icons'
import { ApiError, getGitnexusSystemTools } from '../../lib/rpc'
import { confirmDialog } from '../../ui/dialog-store'
import { toast } from '../../ui/toast-store'

type SystemToolsState =
  | { status: 'loading' }
  | { status: 'ready'; tools: ReadonlyArray<SystemToolDefinition> }
  | { status: 'error'; message: string }

// Small uppercase caption that separates the operator-authored rows
// from the always-attached built-in rows inside a Tools / Skills card.
function BuiltInSubhead() {
  return (
    <div
      style={{
        margin: '18px 4px 8px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}
    >
      Built-in
    </div>
  )
}

// Pull a one-line summary out of a tool description so the System
// defaults rows stay scannable. Cuts at the first hard newline OR the
// first sentence terminator followed by a capital letter — that handles
// both "X. WHEN TO USE: …" and "X.\nDetails …" styles. Falls back to
// the raw text when neither marker is present (short descriptions).
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const nl = trimmed.indexOf('\n')
  const sentenceMatch = trimmed.match(/[.!?]\s+(?=[A-Z])/)
  const sentenceCut =
    sentenceMatch && sentenceMatch.index !== undefined
      ? sentenceMatch.index + 1
      : -1
  let cut = -1
  if (nl >= 0 && sentenceCut >= 0) cut = Math.min(nl, sentenceCut)
  else if (nl >= 0) cut = nl
  else if (sentenceCut >= 0) cut = sentenceCut
  return cut < 0 ? trimmed : trimmed.slice(0, cut).trim()
}

export function ToolsTab({ agentId }: { agentId: string }) {
  const { agentResources, agents, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  const inspectorEnabled = agent?.inspectorEnabled ?? true
  const tools = agentResources[agentId]?.tools ?? []
  const attachedRepos = agentResources[agentId]?.attachedRepos ?? []
  const readyRepos = attachedRepos.filter((r) => r.repo.status === 'ready')
  const [systemTools, setSystemTools] = useState<SystemToolsState>({
    status: 'loading',
  })
  const [expandedSystemTool, setExpandedSystemTool] = useState<string | null>(
    null,
  )
  const [enabling, setEnabling] = useState(false)
  const toggleSystemTool = (name: string) =>
    setExpandedSystemTool((cur) => (cur === name ? null : name))

  const enableInspector = async () => {
    if (!agent || enabling) return
    const ok = await confirmDialog({
      title: 'Enable Inspector toolkit?',
      body:
        'This attaches the six built-in wrappers (find / trace / impact / debug / understand / list) and the IDE-facing tool will switch to <slug>__inspect_codebase. Requires an embedding provider in the workspace if you have repos attached.',
      confirmLabel: 'Enable',
    })
    if (!ok) return
    setEnabling(true)
    try {
      await patchAgent(agentId, { inspectorEnabled: true })
      toast.success('Inspector toolkit enabled')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to enable Inspector toolkit',
      )
    } finally {
      setEnabling(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await getGitnexusSystemTools()
        if (cancelled) return
        if (result.ok) {
          setSystemTools({ status: 'ready', tools: result.tools })
        } else {
          setSystemTools({ status: 'error', message: result.message })
        }
      } catch (e) {
        if (cancelled) return
        setSystemTools({
          status: 'error',
          message:
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : 'Failed to load system tools',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Built-in (system) tool rows. Read-only list of the inspector
  // wrappers auto-mounted when this agent has a ready repo. The raw
  // `gitnexus_*` MCP tools are NOT shown here — under the wrapper-
  // tool architecture the LLM only sees the wrappers; gitnexus is an
  // implementation detail the wrappers call internally.
  const renderSystemRows = () => {
    if (systemTools.status === 'loading') {
      return (
        <div
          className="ab-list-row"
          style={{ opacity: 0.6, fontSize: 13, color: 'var(--text-dim)' }}
        >
          <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
            <ToolIcon />
          </div>
          <div className="ab-list-row-head">
            <div className="ab-list-row-title">Loading built-in tools…</div>
          </div>
        </div>
      )
    }
    if (systemTools.status === 'error') {
      return (
        <div className="ab-list-row" style={{ fontSize: 13 }}>
          <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
            <ToolIcon />
          </div>
          <div className="ab-list-row-head">
            <div className="ab-list-row-title">Built-in tools (unavailable)</div>
            <div className="ab-list-row-sub" style={{ color: 'var(--warn)' }}>
              {systemTools.message}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div style={{ opacity: readyRepos.length === 0 ? 0.6 : 1 }}>
        {systemTools.tools.map((t) => {
          const summary = firstSentence(t.description)
          const hasMore = summary !== t.description.trim()
          const isExpanded = expandedSystemTool === t.name
          return (
            <div key={t.name}>
              <button
                type="button"
                className="ab-list-row"
                onClick={hasMore ? () => toggleSystemTool(t.name) : undefined}
                disabled={!hasMore}
                aria-expanded={hasMore ? isExpanded : undefined}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: hasMore ? 'pointer' : 'default',
                }}
              >
                <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                  <ToolIcon />
                </div>
                <div className="ab-list-row-head">
                  <div className="ab-list-row-title ab-mono">{t.name}</div>
                  <div className="ab-list-row-sub">{summary}</div>
                </div>
                <div className="ab-list-row-meta">
                  <Pill kind="accent">Built-in</Pill>
                  {hasMore && (
                    <span
                      className="ab-row-affordance"
                      aria-hidden="true"
                      style={{
                        transform: isExpanded ? 'rotate(180deg)' : undefined,
                        transition: 'transform 160ms var(--ease-out)',
                        display: 'inline-flex',
                      }}
                    >
                      <ChevronDownIcon />
                    </span>
                  )}
                </div>
              </button>
              {isExpanded && (
                <div
                  style={{
                    padding: '14px 18px 14px 62px',
                    fontSize: 13,
                    lineHeight: 1.55,
                    background: 'var(--surface-hi)',
                    borderTop: '1px solid var(--border)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {t.description.trim()}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Existing operator-authored rows (rare; the CRUD UI is hidden but
  // older agents may still have rows). Render read-only with an
  // "Inactive" pill so operators can see what's parked.
  const renderInactiveRows = () => (
    <div className="ab-card ab-list-card" style={{ opacity: 0.85 }}>
      {tools.map((t) => (
        <div className="ab-list-row" key={t.id} style={{ cursor: 'default' }}>
          <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
            <ToolIcon />
          </div>
          <div className="ab-list-row-head">
            <div className="ab-list-row-title ab-mono">{t.name}</div>
            <div className="ab-list-row-sub">
              {t.description ?? 'No description'}
            </div>
          </div>
          <div className="ab-list-row-meta">
            <Pill kind="neutral">{t.kind}</Pill>
            <Pill kind="warn">Inactive</Pill>
          </div>
        </div>
      ))}
    </div>
  )

  const systemToolCount =
    systemTools.status === 'ready' ? systemTools.tools.length : 0

  // Inspector-disabled (Build-your-own) agents see an opt-in card
  // instead of the wrapper listing. Enabling the toolkit flips the
  // agent flag and re-renders this tab with the standard layout.
  if (!inspectorEnabled) {
    return (
      <div>
        <div className="ab-card ab-card-pad ab-form-section">
          <div className="ab-section-head">
            <div className="ab-section-title">Tools</div>
            <div className="ab-section-sub">
              This is a Build-your-own agent — no built-in toolkit is
              attached. Add the Inspector toolkit below to give the
              agent code-search and graph-walk wrappers, or wire your
              own external MCPs from the Bridge tools tab.
            </div>
          </div>

          {tools.length > 0 && (
            <>
              <div
                className="ab-field-help"
                style={{ marginBottom: 8, fontStyle: 'italic' }}
              >
                The {tools.length} tool{tools.length === 1 ? '' : 's'} below
                {tools.length === 1 ? ' was' : ' were'} authored before
                native-tool support was deferred. They're persisted but
                not currently mounted on the agent.
              </div>
              {renderInactiveRows()}
            </>
          )}

          <BuiltInSubhead />
          <div className="ab-card ab-list-card">
            <div className="ab-list-row">
              <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                <ToolIcon />
              </div>
              <div className="ab-list-row-head">
                <div className="ab-list-row-title">Inspector toolkit</div>
                <div className="ab-list-row-sub">
                  Six wrappers for codebase Q&A: find_in_codebase,
                  trace_flow, assess_change_impact, debug_help,
                  understand_module, list_repos. Switches the IDE-facing
                  tool to <span className="ab-mono">&lt;slug&gt;__inspect_codebase</span>.
                </div>
              </div>
              <div className="ab-list-row-meta">
                <Pill kind="neutral">Built-in</Pill>
                <Button
                  variant="primary"
                  size="sm"
                  leading={<PlusIcon strokeWidth={2.4} />}
                  onClick={() => void enableInspector()}
                  disabled={enabling}
                >
                  {enabling ? 'Enabling…' : 'Add'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Tools</div>
          <div className="ab-section-sub">
            {systemToolCount} built-in · the inspector wrappers
            (find_in_codebase, trace_flow, assess_change_impact,
            debug_help, understand_module, list_repos) — the LLM picks
            among these to query the attached repos. Auto-attached to
            every agent with at least one indexed repo. For tools the
            IDE calls into the agent, see the{' '}
            <strong>Bridge tools</strong> tab.
          </div>
        </div>

        {readyRepos.length === 0 && systemTools.status === 'ready' && (
          <div
            className="ab-field-help"
            style={{ marginBottom: 10, color: 'var(--warn)' }}
          >
            No indexed repositories attached. The built-in tools below
            are listed for reference but won't have data to query until
            at least one repo finishes indexing.
          </div>
        )}

        {tools.length === 0 ? (
          <>
            <EmptyState
              glyph={<ToolIcon />}
              title="Inspector toolkit auto-attached"
              body="Every agent with an indexed repo gets the six inspector wrappers. They're shown below for reference; nothing to configure here."
            />
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">{renderSystemRows()}</div>
          </>
        ) : (
          <>
            <div
              className="ab-field-help"
              style={{ marginBottom: 8, fontStyle: 'italic' }}
            >
              The {tools.length} tool{tools.length === 1 ? '' : 's'} below
              {tools.length === 1 ? ' was' : ' were'} authored before
              native-tool support was deferred. They're persisted but
              not currently mounted on the agent.
            </div>
            {renderInactiveRows()}
            <BuiltInSubhead />
            <div className="ab-card ab-list-card">{renderSystemRows()}</div>
          </>
        )}
      </div>
    </div>
  )
}
