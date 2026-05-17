/**
 * Bridge dashboard — config block from `GET /api/bridge/config`,
 * exposed tools = agents with `llmProviderId !== null` each rendered
 * as one `<slug>__inspect_codebase` MCP tool plus any operator-authored
 * `bridge_tools` rows. The runs card was removed in favour of the global
 * /logs page; users select Source=Bridge there for the equivalent
 * filtered view, with full per-event detail per row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  INSPECT_CODEBASE_METADATA,
  type BridgeToolResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import {
  ApiError,
  getBridgeConfig,
  listBridgeTools,
  type BridgeConfigResponse,
} from '../../lib/rpc'
import { PageHeader } from '../_chrome/page-header'
import { Pill } from '../../ui/pill'
import { EmptyState } from '../../ui/empty'
import {
  BridgeIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from '../../ui/icons'

export function BridgePage() {
  return (
    <div className="ab-page">
      <PageHeader
        title="Bridge"
        subtitle="Wire your agents into your IDE over MCP. Each agent becomes a callable tool in Cursor, Claude Code, Codex, and OpenCode."
      />
      <SetupCard />
      <ToolsCard />
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
        <div className="ab-section-title">MCP server config</div>
        <div className="ab-section-sub">
          Paste the snippet below into your IDE's MCP config file, then
          restart the IDE.
        </div>
      </div>
      {error && (
        <div role="status" className="ab-alert ab-alert-danger">
          <span className="ab-alert-dot" aria-hidden="true" />
          <div className="ab-alert-body">
            <div className="ab-alert-title">Couldn't load bridge config</div>
            <div className="ab-alert-sub">{error}</div>
          </div>
        </div>
      )}
      {config && !config.ready && config.readyHint && (
        <div role="status" className="ab-alert ab-alert-warn">
          <span className="ab-alert-dot" aria-hidden="true" />
          <div className="ab-alert-body">
            <div className="ab-alert-title">Not runnable yet</div>
            <div className="ab-alert-sub">{config.readyHint}</div>
          </div>
        </div>
      )}
      {config ? (
        <div className="ab-codeblock">
          <div className="ab-codeblock-head">
            <span className="ab-codeblock-filename">~/.cursor/mcp.json</span>
            <button
              type="button"
              className={`ab-codeblock-copy${copied ? ' is-copied' : ''}`}
              onClick={() => void handleCopy()}
              aria-live="polite"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="ab-codeblock-body">{config.configBlock}</pre>
        </div>
      ) : !error ? (
        <div className="ab-loading-row">
          <span className="ab-pulse-dot" />
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
        <div className="ab-section-title">Exposed tools</div>
        <div className="ab-section-sub">
          {exposed.length} agent{exposed.length === 1 ? '' : 's'} exposed
          to your IDE. Repo inspectors ship{' '}
          <span className="ab-mono">
            &lt;slug&gt;__{INSPECT_CODEBASE_METADATA.nameSuffix}
          </span>{' '}
          as a system tool. Build-your-own agents ship a starter{' '}
          <span className="ab-mono">&lt;slug&gt;__ask_agent</span>{' '}
          tool that's auto-created when the agent is — fully editable
          (name, description, prompt template) on the agent's
          Bridge-tools tab, like any custom tool. Add more from there.
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
  // System built-in (only on repo inspectors): <slug>__inspect_codebase.
  // Blank agents have NO built-in here — their auto-created
  // `<slug>__ask_agent` lives in `bridge_tools` and renders below as
  // a regular custom tool. Operator-authored rows from `bridge_tools`
  // ship by their literal `name` for both kinds.
  const builtInName = agent.inspectorEnabled
    ? `${agent.slug}__${INSPECT_CODEBASE_METADATA.nameSuffix}`
    : null
  const [open, setOpen] = useState(defaultOpen)
  const [bridgeTools, setBridgeTools] = useState<
    readonly BridgeToolResponse[] | null
  >(null)
  const [loadingBridgeTools, setLoadingBridgeTools] = useState(false)
  const [bridgeToolsErr, setBridgeToolsErr] = useState<string | null>(null)
  // Tracks which agent we've already fetched for. A ref (not state) so
  // marking "done" doesn't re-fire the effect — the previous version
  // had `bridgeTools` and `loadingBridgeTools` in its dep array, which
  // turned the first `setLoadingBridgeTools(true)` into a re-run that
  // tripped the early-return guard and orphaned the fetch. Result:
  // stuck on "Loading…" forever.
  const fetchedForRef = useRef<string | null>(null)

  // Lazy-fetch the per-agent bridge tools the first time the row opens.
  useEffect(() => {
    if (!open) return
    if (fetchedForRef.current === agent.id) return
    let alive = true
    setLoadingBridgeTools(true)
    setBridgeToolsErr(null)
    void (async () => {
      try {
        const list = await listBridgeTools(agent.id)
        if (alive) {
          setBridgeTools(list)
          fetchedForRef.current = agent.id
        }
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
  }, [open, agent.id])

  return (
    <div
      data-bridge-slug={agent.slug}
      style={{
        borderBottom: '1px solid var(--border)',
        ...(highlight
          ? {
              background: 'var(--accent-bg)',
              boxShadow: 'inset 3px 0 0 var(--accent-400)',
              transition: 'background var(--dur-3) var(--ease-out)',
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
          <div className="ab-list-row-title">{agent.name}</div>
          <div className="ab-list-row-sub">
            <span className="ab-mono" style={{ color: 'var(--text-dim)' }}>
              {agent.slug}
            </span>
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
          {provider?.defaultModel && (
            <span
              className="ab-mono"
              style={{ color: 'var(--text-muted)' }}
            >
              {provider.defaultModel}
            </span>
          )}
          <span
            aria-hidden="true"
            style={{
              color: 'var(--text-muted)',
              display: 'inline-flex',
              transition: 'transform var(--dur-1) var(--ease-out)',
              transform: open ? 'rotate(90deg)' : 'rotate(0)',
            }}
          >
            <ChevronRightIcon width={14} height={14} />
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
          {builtInName && (
            <ToolGroup
              label="Inspector (system)"
              sub="System tool shipped on repo inspectors. Returns structured codebase evidence (mini_repos[])."
              tools={[
                {
                  name: builtInName,
                  description: INSPECT_CODEBASE_METADATA.summary,
                  enabled: true,
                },
              ]}
            />
          )}

          {loadingBridgeTools && (
            <div className="ab-loading-row">
              <span className="ab-pulse-dot" />
              Loading custom bridge tools…
            </div>
          )}
          {bridgeToolsErr && (
            <div role="status" className="ab-alert ab-alert-danger">
              <span className="ab-alert-dot" aria-hidden="true" />
              <div className="ab-alert-body">
                <div className="ab-alert-title">
                  Couldn't load bridge tools
                </div>
                <div className="ab-alert-sub">{bridgeToolsErr}</div>
              </div>
            </div>
          )}
          {bridgeTools && bridgeTools.length > 0 && (
            <ToolGroup
              label="Custom bridge tools"
              sub="Tools you added on this agent's Bridge tools tab. The IDE sees these by their literal name. If the name matches a built-in, your version replaces it."
              tools={bridgeTools.map((bt) => ({
                name: bt.name,
                description: bt.description || undefined,
                enabled: bt.enabled,
              }))}
            />
          )}

          {bridgeTools && bridgeTools.length === 0 && !loadingBridgeTools && (
            <div
              className="ab-field-help"
              style={{ marginTop: 8, fontStyle: 'italic' }}
            >
              {agent.inspectorEnabled
                ? "No custom tools on this agent. The IDE sees just the system built-in above. Add a custom tool from the agent's Bridge tools tab."
                : "No tools on this agent yet. Add one from the agent's Bridge tools tab — a starter `<slug>__ask_agent` tool is normally created automatically; if it's missing, create one."}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface ToolGroupTool {
  readonly name: string
  readonly description?: string | undefined
  readonly enabled: boolean
  readonly tag?: 'sync' | 'any-repo' | 'single-repo'
}

/**
 * Compact list-of-tools renderer used twice in the expanded agent
 * row: once for the always-on inspector toolkit and once for
 * operator-authored explicit `bridge_tools` rows. Same visual shape
 * so the two sources read as a single conceptual list ("all the
 * tools your IDE sees").
 */
function ToolGroup({
  label,
  sub,
  tools,
}: {
  label: string
  sub: string
  tools: readonly ToolGroupTool[]
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="ab-section-sub" style={{ marginBottom: 6, fontSize: 12 }}>
        <strong style={{ color: 'var(--text-dim)' }}>{label}</strong> · {sub}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tools.map((t) => (
          <div
            key={t.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 0',
              fontSize: 12,
            }}
          >
            <span className="ab-mono" style={{ color: 'var(--text)' }}>
              {t.name}
            </span>
            {t.enabled ? (
              <Pill kind="success" dot>
                Enabled
              </Pill>
            ) : (
              <Pill kind="neutral">Disabled</Pill>
            )}
            {t.tag && (
              <Pill
                kind={t.tag === 'single-repo' ? 'accent' : 'neutral'}
              >
                {t.tag === 'sync'
                  ? 'Sync'
                  : t.tag === 'any-repo'
                    ? 'Any repo'
                    : 'Single repo'}
              </Pill>
            )}
            {t.description && (
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
                {t.description}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
