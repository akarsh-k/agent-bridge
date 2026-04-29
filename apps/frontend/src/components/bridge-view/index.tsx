/**
 * BridgeView — Phase 5 IDE-bridge dashboard.
 *
 * Three sections, top-to-bottom:
 *   1. Setup card with the paste-ready MCP config block + copy button.
 *   2. Tools list — every agent currently exposed as a `query_<slug>`
 *      MCP tool (the bridge boots and registers these on each IDE
 *      session). Empty state when no agent has an LLM provider yet.
 *   3. Runs feed — bridge-prefixed runs (`stream_id LIKE 'bridge:%'`),
 *      polled every 4s. Shows agent · status · prompt preview ·
 *      duration. Polling, not SSE — the dispatcher already publishes
 *      to per-run streams; a workspace-wide stream is Phase 6 polish.
 *
 * No mutation paths — this view is read-only. Operators add agents
 * from the canvas and the bridge picks them up on the next IDE
 * restart. We surface a "Restart Cursor to pick up new agents" hint
 * next to the tools list since that's the most-asked question.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import {
  ApiError,
  getBridgeConfig,
  listRuns,
  type BridgeConfigResponse,
} from '../../lib/rpc'
import type { RunListRow } from '@agent-bridge/shared'
import { BRIDGE_TOOL_RESERVED_PREFIX } from '@agent-bridge/shared'

import './index.css'

const RUNS_POLL_MS = 4_000
const RUNS_LIMIT = 50

export function BridgeView() {
  return (
    <div className="bridge-view">
      <header className="bridge-view-header">
        <div>
          <h1 className="bridge-view-title">Connect IDE</h1>
          <p className="bridge-view-subtitle">
            Paste the config below into your IDE, then call your agents
            with <code>@query_&lt;slug&gt;</code> from inside Cursor or
            Claude Code.
          </p>
        </div>
      </header>

      <SetupCard />
      <ToolsList />
      <RunsFeed />
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
        if (!active) return
        setConfig(data)
      } catch (err) {
        if (!active) return
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load bridge config',
        )
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
      // Short reset — long enough that the user sees the success flash,
      // not so long that a second copy looks broken.
      setTimeout(() => setCopied(false), 1_400)
    } catch {
      // Older browsers / blocked permissions: no-op. The textarea is
      // selectable so the user can ⌘A + ⌘C.
    }
  }, [config])

  return (
    <section className="bridge-card">
      <div className="bridge-card-header">
        <h2 className="bridge-card-title">1 · MCP server config</h2>
        <span className="bridge-card-subtitle">
          Paste into <code>~/.cursor/mcp.json</code> or your Claude Code
          MCP config.
        </span>
      </div>
      {error ? (
        <div className="status-strip error" role="alert">
          {error}
        </div>
      ) : null}
      {config && !config.ready && config.readyHint ? (
        <div className="status-strip error" role="alert">
          <strong>Not runnable yet:</strong> {config.readyHint}
        </div>
      ) : null}
      {config ? (
        <>
          <div className="bridge-config-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleCopy()}
            >
              {copied ? 'Copied!' : 'Copy config'}
            </button>
            <span className="bridge-config-meta mono">
              {config.command} {config.args.join(' ')}
            </span>
          </div>
          <textarea
            readOnly
            className="bridge-config-textarea mono"
            value={config.configBlock}
            spellCheck={false}
            rows={Math.min(14, config.configBlock.split('\n').length)}
          />
          <ol className="bridge-setup-steps">
            <li>Paste the JSON above into your IDE's MCP config file.</li>
            <li>Restart the IDE so it picks up the new server.</li>
            <li>
              Call <code>@query_&lt;agent.slug&gt;</code> from a chat —
              the agent runs with all its repos, skills, and MCP tools
              just like in the workspace UI.
            </li>
          </ol>
        </>
      ) : !error ? (
        <div className="bridge-card-loading">Loading config…</div>
      ) : null}
    </section>
  )
}

// ─── Tools list ──────────────────────────────────────────────────────────

function ToolsList() {
  const { agents, llmProviders } = useWorkspace()
  // Same filter the bridge applies at boot: agents with a configured
  // provider get exposed; the rest are silently skipped.
  const exposed = useMemo(
    () => agents.filter((a) => a.llmProviderId !== null),
    [agents],
  )

  return (
    <section className="bridge-card">
      <div className="bridge-card-header">
        <h2 className="bridge-card-title">2 · Exposed tools</h2>
        <span className="bridge-card-subtitle">
          {exposed.length} agent{exposed.length === 1 ? '' : 's'} ready ·{' '}
          {agents.length - exposed.length} skipped (no LLM provider)
        </span>
      </div>
      {exposed.length === 0 ? (
        <div className="bridge-empty">
          No agents have an LLM provider yet. Configure one from the
          canvas to expose it as a bridge tool.
        </div>
      ) : (
        <ul className="bridge-tool-list">
          {exposed.map((agent) => {
            const provider = llmProviders.find(
              (p) => p.id === agent.llmProviderId,
            )
            const toolName = `${BRIDGE_TOOL_RESERVED_PREFIX}${agent.slug}`
            return (
              <li key={agent.id} className="bridge-tool-row">
                <div className="bridge-tool-row-head">
                  <code className="bridge-tool-name">{toolName}</code>
                  <span className="bridge-tool-agent">{agent.name}</span>
                </div>
                {agent.description ? (
                  <div className="bridge-tool-desc">{agent.description}</div>
                ) : (
                  <div className="bridge-tool-desc muted">
                    (auto-generated description — set one on the agent
                    inspector for a tailored hint to the IDE.)
                  </div>
                )}
                <div className="bridge-tool-meta">
                  <span>
                    Provider: {provider?.label ?? '?'}
                    {provider?.kind ? ` · ${provider.kind}` : ''}
                  </span>
                  {agent.model ? (
                    <span className="bridge-tool-meta-model mono">
                      {agent.model}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="bridge-card-footer muted">
        Tools refresh on IDE restart — create a new agent and reopen
        Cursor to see it appear in the picker.
      </div>
    </section>
  )
}

// ─── Runs feed ───────────────────────────────────────────────────────────

function RunsFeed() {
  const [runs, setRuns] = useState<readonly RunListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)

  // Polling loop. Runs once on mount, then every RUNS_POLL_MS until
  // the component unmounts. Errors are sticky for one cycle so a brief
  // network blip doesn't flash an error banner; the next successful
  // poll clears it.
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

  return (
    <section className="bridge-card">
      <div className="bridge-card-header">
        <h2 className="bridge-card-title">3 · Recent IDE runs</h2>
        <span className="bridge-card-subtitle">
          {loading
            ? 'Loading…'
            : runs.length === 0
              ? 'No IDE invocations yet'
              : `${runs.length} run${runs.length === 1 ? '' : 's'}`}
          {lastRefresh ? ` · refreshed ${formatRelative(lastRefresh)}` : ''}
        </span>
      </div>
      {error ? (
        <div className="status-strip error" role="alert">
          {error}
        </div>
      ) : null}
      {!loading && runs.length === 0 ? (
        <div className="bridge-empty">
          Connect your IDE and call <code>@query_&lt;slug&gt;</code> —
          invocations will stream in here in real time.
        </div>
      ) : null}
      {runs.length > 0 ? (
        <ul className="bridge-runs-list">
          {runs.map((row) => (
            <RunRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function RunRow({ row }: { row: RunListRow }) {
  return (
    <li className={`bridge-run-row status-${row.status}`}>
      <div className="bridge-run-head">
        <span className={`badge ${runStatusBadge(row.status)}`}>
          <span className="badge-dot" />
          {row.status}
        </span>
        <span className="bridge-run-agent">
          {row.agentName} · <code>{row.agentSlug}</code>
        </span>
        <span className="bridge-run-time mono">
          {formatRelative(Date.parse(row.startedAt))}
          {row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : ''}
        </span>
      </div>
      <div className="bridge-run-prompt">{row.inputPromptPreview}</div>
      {row.status === 'error' && row.errorMessage ? (
        <div className="bridge-run-error">{row.errorMessage}</div>
      ) : null}
      {row.outputSummaryPreview ? (
        <div className="bridge-run-output">{row.outputSummaryPreview}</div>
      ) : null}
    </li>
  )
}

function runStatusBadge(status: RunListRow['status']): string {
  switch (status) {
    case 'completed':
      return 'badge-success'
    case 'running':
    case 'pending':
      return 'badge-accent'
    case 'error':
    case 'aborted':
      return 'badge-error'
    default:
      return ''
  }
}

function formatRelative(ts: number): string {
  if (Number.isNaN(ts)) return ''
  const delta = Date.now() - ts
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s}s`
}
