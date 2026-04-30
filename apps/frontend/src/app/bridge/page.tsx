/**
 * Bridge dashboard — real backend wiring (matches the prior
 * BridgeView): config block from `GET /api/bridge/config`, exposed
 * tools = agents with `llmProviderId !== null` rendered as
 * `query_<slug>`, runs feed polled from `GET /api/runs?source=bridge`
 * every 4s.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BRIDGE_TOOL_RESERVED_PREFIX,
  type BridgeToolResponse,
  type RunListRow,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import {
  ApiError,
  getBridgeConfig,
  listBridgeTools,
  listRuns,
  type BridgeConfigResponse,
} from '../../lib/rpc'
import { PageHeader } from '../_chrome/page-header'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { Tabs } from '../../ui/tabs'
import { EmptyState } from '../../ui/empty'
import { BridgeIcon } from '../../ui/icons'

const RUNS_POLL_MS = 4_000
const RUNS_LIMIT = 50

export function BridgePage() {
  return (
    <div className="ab-page">
      <PageHeader
        title="Bridge"
        subtitle={
          <>
            Wire your agents into your IDE over MCP. Once configured, every
            agent shows up as <code className="ab-mono">@query_&lt;slug&gt;</code>
            in Cursor / Claude Code / Codex / OpenCode.
          </>
        }
      />
      <SetupCard />
      <ToolsCard />
      <RunsCard />
    </div>
  )
}

// ─── Setup card ──────────────────────────────────────────────────────────

function SetupCard() {
  const [config, setConfig] = useState<BridgeConfigResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const data = await getBridgeConfig()
        if (active) setConfig(data)
      } catch (err) {
        if (active) {
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load bridge config',
          )
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const handleCopy = useCallback(async () => {
    if (!config) return
    try {
      await navigator.clipboard.writeText(config.configBlock)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Older browsers fall back to manual select-all.
    }
  }, [config])

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-head">
        <div className="ab-section-title">1 · MCP server config</div>
        <div className="ab-section-sub">
          Paste into <code className="ab-mono">~/.cursor/mcp.json</code> or
          your IDE's MCP config file.
        </div>
      </div>
      {error && (
        <div className="ab-field-help" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {config && !config.ready && config.readyHint && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--warn)', marginBottom: 8 }}
        >
          <strong>Not runnable yet:</strong> {config.readyHint}
        </div>
      )}
      {config ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 10,
            }}
          >
            <Button variant="primary" onClick={() => void handleCopy()}>
              {copied ? 'Copied!' : 'Copy config'}
            </Button>
            <span className="ab-mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {config.command} {config.args.join(' ')}
            </span>
          </div>
          <pre
            className="ab-mono"
            style={{
              background: 'var(--surface-hi)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              padding: 16,
              margin: 0,
              fontSize: 12.5,
              lineHeight: 1.6,
              whiteSpace: 'pre',
              overflowX: 'auto',
              color: 'var(--text)',
              maxHeight: 320,
            }}
          >
            {config.configBlock}
          </pre>
          <ol
            style={{
              fontSize: 13,
              color: 'var(--text-dim)',
              lineHeight: 1.7,
              marginTop: 14,
              paddingLeft: 20,
            }}
          >
            <li>Paste the JSON above into your IDE's MCP config.</li>
            <li>Restart the IDE so it picks up the new server.</li>
            <li>
              Call <code className="ab-mono">@query_&lt;slug&gt;</code> from a
              chat — the agent runs with its repos, skills, and MCP tools just
              like in the workspace UI.
            </li>
          </ol>
        </>
      ) : !error ? (
        <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>
          Loading config…
        </div>
      ) : null}
    </div>
  )
}

// ─── Tools card — agents currently exposed as bridge tools ──────────────

function ToolsCard() {
  const { agents, llmProviders } = useWorkspace()
  const exposed = useMemo(
    () => agents.filter((a) => a.llmProviderId !== null),
    [agents],
  )
  const skipped = agents.length - exposed.length
  // Read window.location.hash once on mount, then scroll the matching
  // row into view + highlight it for a short window. Used by the
  // "Open in IDE" button on the agent detail page.
  const initialHash =
    typeof window === 'undefined' ? '' : window.location.hash.slice(1)
  const [highlightSlug, setHighlightSlug] = useState<string | null>(
    initialHash || null,
  )
  useEffect(() => {
    if (!initialHash) return
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-bridge-slug="${CSS.escape(initialHash)}"]`,
      ) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    const t = setTimeout(() => setHighlightSlug(null), 2400)
    return () => clearTimeout(t)
  }, [initialHash])

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-head">
        <div className="ab-section-title">2 · Exposed tools</div>
        <div className="ab-section-sub">
          {exposed.length} agent{exposed.length === 1 ? '' : 's'} ready
          {skipped > 0 && ` · ${skipped} skipped (no LLM provider)`}
        </div>
      </div>

      {exposed.length === 0 ? (
        <EmptyState
          glyph={<BridgeIcon />}
          title="No agents have an LLM provider yet"
          body="Pick a provider on an agent's Configure tab to expose it as a bridge tool."
        />
      ) : (
        <div className="ab-card ab-list-card">
          {exposed.map((agent) => {
            const provider = llmProviders.find(
              (p) => p.id === agent.llmProviderId,
            )
            return (
              <ExposedAgentRow
                key={agent.id}
                agent={agent}
                provider={provider}
                highlight={highlightSlug === agent.slug}
                defaultOpen={highlightSlug === agent.slug}
              />
            )
          })}
        </div>
      )}
      <div className="ab-field-help" style={{ marginTop: 12 }}>
        Tools refresh on IDE restart — create a new agent and reopen Cursor
        to see it appear in the picker.
      </div>
    </div>
  )
}

// ─── Runs feed ───────────────────────────────────────────────────────────

function ExposedAgentRow({
  agent,
  provider,
  highlight,
  defaultOpen,
}: {
  agent: ReturnType<typeof useWorkspace>['agents'][number]
  provider:
    | ReturnType<typeof useWorkspace>['llmProviders'][number]
    | undefined
  highlight: boolean
  defaultOpen: boolean
}) {
  const toolName = `${BRIDGE_TOOL_RESERVED_PREFIX}${agent.slug}`
  const [open, setOpen] = useState(defaultOpen)
  const [bridgeTools, setBridgeTools] = useState<
    readonly BridgeToolResponse[] | null
  >(null)
  const [loadingBridgeTools, setLoadingBridgeTools] = useState(false)
  const [bridgeToolsErr, setBridgeToolsErr] = useState<string | null>(null)

  // Lazy-fetch the per-agent bridge tools the first time the row opens.
  useEffect(() => {
    if (!open || bridgeTools !== null || loadingBridgeTools) return
    let alive = true
    void (async () => {
      if (!alive) return
      setLoadingBridgeTools(true)
      setBridgeToolsErr(null)
      try {
        const list = await listBridgeTools(agent.id)
        if (alive) setBridgeTools(list)
      } catch (err) {
        if (alive) {
          setBridgeToolsErr(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to load bridge tools',
          )
        }
      } finally {
        if (alive) setLoadingBridgeTools(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, agent.id, bridgeTools, loadingBridgeTools])

  return (
    <div
      data-bridge-slug={agent.slug}
      style={{
        borderBottom: '1px solid var(--border)',
        ...(highlight
          ? {
              background: 'var(--accent-bg)',
              boxShadow: 'inset 3px 0 0 var(--accent-400)',
              transition: 'background 320ms ease',
            }
          : null),
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ab-list-row"
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <div className="ab-list-row-head">
          <div className="ab-list-row-title ab-mono">{toolName}</div>
          <div className="ab-list-row-sub">
            {agent.name}
            {agent.description &&
              ' · ' + truncate(agent.description, 80)}
          </div>
        </div>
        <div className="ab-list-row-meta">
          {provider && (
            <Pill kind="neutral">
              {provider.label} · {provider.kind}
            </Pill>
          )}
          {agent.model && (
            <span
              className="ab-mono"
              style={{ color: 'var(--text-muted)' }}
            >
              {agent.model}
            </span>
          )}
          <span
            aria-hidden="true"
            style={{
              color: 'var(--text-muted)',
              fontSize: 14,
              transition: 'transform 160ms var(--ease-out)',
              transform: open ? 'rotate(90deg)' : 'rotate(0)',
              display: 'inline-block',
              width: 14,
              textAlign: 'center',
            }}
          >
            ›
          </span>
        </div>
      </button>
      {open && (
        <div
          style={{
            padding: '10px 18px 16px 64px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-hi)',
          }}
        >
          <div
            className="ab-section-sub"
            style={{ marginBottom: 8, fontSize: 12 }}
          >
            <strong style={{ color: 'var(--text-dim)' }}>
              Bridge tools (Phase 7)
            </strong>{' '}
            — typed functions this agent advertises through MCP. The IDE
            sees them as{' '}
            <code className="ab-mono">
              query_{agent.slug}__&lt;tool_name&gt;
            </code>
            .
          </div>
          {loadingBridgeTools && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--text-dim)',
                fontSize: 12,
                padding: '4px 0',
              }}
            >
              <span className="ab-pulse-dot" />
              Loading…
            </div>
          )}
          {bridgeToolsErr && (
            <div
              className="ab-field-help"
              style={{ color: 'var(--danger)' }}
            >
              {bridgeToolsErr}
            </div>
          )}
          {bridgeTools && bridgeTools.length === 0 && (
            <div
              className="ab-field-help"
              style={{ fontStyle: 'italic' }}
            >
              No bridge tools yet — this agent only exposes the
              built-in <code className="ab-mono">{toolName}</code>{' '}
              query function.
            </div>
          )}
          {bridgeTools && bridgeTools.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {bridgeTools.map((bt) => (
                <div
                  key={bt.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 0',
                    fontSize: 12,
                  }}
                >
                  <span
                    className="ab-mono"
                    style={{ color: 'var(--text)' }}
                  >
                    query_{agent.slug}__{bt.name}
                  </span>
                  <Pill kind={bt.enabled ? 'success' : 'neutral'} dot>
                    {bt.enabled ? 'Enabled' : 'Disabled'}
                  </Pill>
                  {bt.description && (
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {bt.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RunsCard() {
  const [runs, setRuns] = useState<readonly RunListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)
  const [groupBy, setGroupBy] = useState<'time' | 'agent'>('time')

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      try {
        const res = await listRuns({ source: 'bridge', limit: RUNS_LIMIT })
        if (!active) return
        setRuns(res.runs)
        setError(null)
        setLastRefresh(Date.now())
      } catch (err) {
        if (!active) return
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load runs',
        )
      } finally {
        if (active) setLoading(false)
      }
    }

    void tick()
    const schedule = (): void => {
      if (!active) return
      timer = setTimeout(async () => {
        await tick()
        schedule()
      }, RUNS_POLL_MS)
    }
    schedule()

    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Group rows by agent when requested.
  const grouped = useMemo(() => {
    if (groupBy === 'time') return null
    const map = new Map<string, RunListRow[]>()
    for (const r of runs) {
      const key = `${r.agentSlug}|${r.agentName}`
      const arr = map.get(key) ?? []
      arr.push(r)
      map.set(key, arr)
    }
    return [...map.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )
  }, [groupBy, runs])

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        className="ab-section-head"
        style={{ display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <div style={{ flex: 1 }}>
          <div className="ab-section-title">3 · Recent IDE runs</div>
          <div className="ab-section-sub">
            {loading
              ? 'Loading…'
              : runs.length === 0
                ? 'No IDE invocations yet'
                : `${runs.length} run${runs.length === 1 ? '' : 's'}`}
            {lastRefresh && ` · refreshed ${formatRelative(lastRefresh)}`}
          </div>
        </div>
        {runs.length > 0 && (
          <Tabs<'time' | 'agent'>
            value={groupBy}
            onChange={setGroupBy}
            tabs={[
              { value: 'time', label: 'By time' },
              { value: 'agent', label: 'By agent' },
            ]}
            className="ab-tabs-inline"
          />
        )}
      </div>

      {error && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)', marginBottom: 8 }}
        >
          {error}
        </div>
      )}

      {!loading && runs.length === 0 ? (
        <EmptyState
          glyph={<BridgeIcon />}
          title="No IDE invocations yet"
          body={
            <>
              Once your IDE picks up the MCP config above, every call
              streams in here. Try one of these from the IDE chat:
              <pre
                className="ab-mono"
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  padding: '10px 12px',
                  background: 'var(--surface-hi)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontSize: 12,
                  textAlign: 'left',
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                @query_&lt;slug&gt; "Summarise the README"{'\n'}
                @query_&lt;slug&gt; "Where do we register routes?"{'\n'}
                @query_&lt;slug&gt; "Walk me through the auth flow"
              </pre>
            </>
          }
        />
      ) : null}

      {runs.length > 0 && groupBy === 'time' && (
        <div className="ab-card ab-list-card">
          {runs.map((row) => (
            <RunRow key={row.id} row={row} />
          ))}
        </div>
      )}
      {runs.length > 0 &&
        groupBy === 'agent' &&
        grouped?.map(([key, list]) => {
          const [slug, name] = key.split('|') as [string, string]
          return (
            <div key={key} style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '6px 0 8px',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {name}
                </span>
                <span
                  className="ab-mono"
                  style={{ color: 'var(--text-muted)', fontSize: 12 }}
                >
                  {slug}
                </span>
                <Pill kind="neutral">
                  {list.length} run{list.length === 1 ? '' : 's'}
                </Pill>
              </div>
              <div className="ab-card ab-list-card">
                {list.map((row) => (
                  <RunRow key={row.id} row={row} />
                ))}
              </div>
            </div>
          )
        })}
    </div>
  )
}

function RunRow({ row }: { row: RunListRow }) {
  const kind: Parameters<typeof Pill>[0]['kind'] =
    row.status === 'completed'
      ? 'success'
      : row.status === 'error' || row.status === 'aborted'
        ? 'danger'
        : 'accent'
  return (
    <div className="ab-list-row is-static" style={{ alignItems: 'flex-start' }}>
      <Pill kind={kind} dot>
        {row.status}
      </Pill>
      <div className="ab-list-row-head">
        <div className="ab-list-row-title">
          {row.agentName}{' '}
          <span className="ab-mono" style={{ color: 'var(--text-muted)' }}>
            · {row.agentSlug}
          </span>
        </div>
        <div
          className="ab-list-row-sub"
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            overflow: 'hidden',
          }}
        >
          {row.inputPromptPreview}
        </div>
        {row.status === 'error' && row.errorMessage && (
          <div
            className="ab-field-help"
            style={{ color: 'var(--danger)', marginTop: 4 }}
          >
            {row.errorMessage}
          </div>
        )}
      </div>
      <div className="ab-list-row-meta">
        <span className="ab-mono" style={{ color: 'var(--text-muted)' }}>
          {formatRelative(Date.parse(row.startedAt))}
          {row.durationMs !== null && ` · ${formatDuration(row.durationMs)}`}
        </span>
      </div>
    </div>
  )
}

function formatRelative(ts: number): string {
  if (Number.isNaN(ts)) return ''
  const delta = Date.now() - ts
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s}s`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
