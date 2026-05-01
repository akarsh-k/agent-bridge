/**
 * MCP detail page. Edit transport, command/url, args, env/headers,
 * allow-host-home toggle. Discover tools live. Delete from here.
 */

import { useMemo, useState } from 'react'
import { useWorkspace } from '../../../../lib/workspace-context'
import { Link } from '../../../../lib/link'
import { navigate } from '../../../../lib/router'
import { Button } from '../../../../ui/button'
import { Pill } from '../../../../ui/pill'
import { BrandGlyph, type BrandKind } from '../../../../ui/brand-glyph'
import { ApiError, discoverMcpTools, pollMcpTest } from '../../../../lib/rpc'
import { toast } from '../../../../ui/toast-store'
import { confirmDialog } from '../../../../ui/dialog-store'

function brandFor(name: string): BrandKind {
  const n = name.toLowerCase()
  if (n.includes('linear')) return 'linear'
  if (n.includes('notion')) return 'notion'
  if (n.includes('github')) return 'github'
  return 'mcp'
}

interface DiscoveredTool {
  name: string
  description?: string
}

interface DiscoverSummary {
  toolCount: number
  durationMs: number
  serverVersion: string | null
  message: string
  ranAt: number
}

export function McpDetailPage({ id }: { id: string }) {
  const { mcpConnections, patchMcpConnection, removeMcpConnection, agentResources } =
    useWorkspace()
  const conn = mcpConnections.find((m) => m.id === id)
  const dependentAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [agentId, bundle] of Object.entries(agentResources)) {
      if (bundle.mcpAllowlist.some((m) => m.mcpConnectionId === id)) {
        ids.add(agentId)
      }
    }
    return [...ids]
  }, [agentResources, id])

  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [commandOrUrl, setCommandOrUrl] = useState('')
  const [argsRaw, setArgsRaw] = useState('')
  const [allowHostHome, setAllowHostHome] = useState(false)
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [tools, setTools] = useState<DiscoveredTool[] | null>(null)
  const [discoverErr, setDiscoverErr] = useState<string | null>(null)
  const [discoverSummary, setDiscoverSummary] =
    useState<DiscoverSummary | null>(null)

  if (conn && seededFor !== conn.id) {
    setSeededFor(conn.id)
    setName(conn.name)
    setCommandOrUrl(conn.commandOrUrl)
    setArgsRaw((conn.argsJson ?? []).join('\n'))
    setAllowHostHome(conn.allowHostHome)
  }

  if (!conn) {
    return (
      <div className="ab-page">
        <div className="ab-card ab-card-pad">
          <div className="ab-section-title">MCP connection not found</div>
          <div style={{ marginTop: 12 }}>
            <Link to="/library/mcp" className="ab-btn ab-btn-secondary">
              Back to MCPs
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isStdio = conn.transport === 'stdio'

  const save = async () => {
    setBusy(true)
    try {
      const args = isStdio
        ? argsRaw
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : []
      await patchMcpConnection(conn.id, {
        name: name.trim(),
        commandOrUrl: commandOrUrl.trim(),
        argsJson: isStdio ? args : undefined,
        allowHostHome: isStdio ? allowHostHome : undefined,
      })
      toast.success('MCP connection saved')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Save failed',
      )
    } finally {
      setBusy(false)
    }
  }

  const discover = async () => {
    setDiscovering(true)
    setDiscoverErr(null)
    setTools(null)
    setDiscoverSummary(null)
    const popupRef: { current: Window | null } = { current: null }
    const apply = async (
      res: Awaited<ReturnType<typeof discoverMcpTools>>,
    ): Promise<void> => {
      if (res.ok) {
        setTools(
          res.tools.map((t) => ({
            name: t.name,
            description: t.description ?? undefined,
          })),
        )
        setDiscoverSummary({
          toolCount: res.toolCount,
          durationMs: res.durationMs,
          serverVersion: res.serverVersion,
          message: res.message,
          ranAt: Date.now(),
        })
        toast.success(`Discovered ${res.tools.length} tools`)
        setDiscovering(false)
        return
      }
      if (res.code === 'authorize_required' && res.sessionId) {
        if (res.authorizeUrl && !popupRef.current) {
          popupRef.current = window.open(
            res.authorizeUrl,
            'agent-bridge-mcp-oauth',
            'popup,width=520,height=720',
          )
        }
        await new Promise((r) => setTimeout(r, 1500))
        const next = await pollMcpTest(
          conn.id,
          res.sessionId,
          'authorize_required',
        )
        return apply(next)
      }
      setDiscoverErr(res.message ?? `Discovery failed (${res.code})`)
      setTools([])
      setDiscovering(false)
    }
    try {
      const res = await discoverMcpTools(conn.id, {})
      await apply(res)
    } catch (e) {
      setDiscoverErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Discovery failed',
      )
      setDiscovering(false)
    } finally {
      const p = popupRef.current
      if (p && !p.closed) p.close()
    }
  }

  const remove = async () => {
    const body =
      dependentAgentIds.length === 0
        ? 'No agents reference this connection.'
        : `${dependentAgentIds.length} agent${
            dependentAgentIds.length === 1 ? '' : 's'
          } reference this connection — their allowlists will be cleared.`
    if (
      !(await confirmDialog({
        title: `Delete MCP “${conn.name}”?`,
        body,
        confirmLabel: 'Delete connection',
        destructive: true,
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await removeMcpConnection(conn.id)
      toast.success('MCP connection deleted')
      navigate('/library/mcp')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ab-page">
      <Link to="/library/mcp" className="ab-back-link">
        Back to MCP servers
      </Link>
      <div className="ab-detail-header">
        <BrandGlyph kind={brandFor(conn.name)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ab-page-title" style={{ marginBottom: 0 }}>
            {conn.name}
          </h1>
          <div className="ab-detail-meta">
            <Pill kind="neutral">{conn.transport}</Pill>
            <span>·</span>
            <span className="ab-mono">{conn.commandOrUrl}</span>
          </div>
        </div>
        <div className="ab-page-actions">
          <Button
            variant="primary"
            onClick={discover}
            disabled={discovering}
          >
            {discovering ? 'Discovering…' : 'Discover tools'}
          </Button>
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Connection</div>
          <div className="ab-section-sub">
            Transport is fixed after creation; everything else is editable.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="md-name">
              Name
            </label>
            <input
              id="md-name"
              className="ab-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="ab-field">
            <span className="ab-field-label">Transport</span>
            <input className="ab-input ab-mono" value={conn.transport} disabled />
          </div>
          <div className="ab-field ab-field-col">
            <label className="ab-field-label" htmlFor="md-cmd">
              {isStdio ? 'Command' : 'URL'}
            </label>
            <input
              id="md-cmd"
              className="ab-input ab-mono"
              value={commandOrUrl}
              onChange={(e) => setCommandOrUrl(e.target.value)}
            />
          </div>
          {isStdio && (
            <>
              <div className="ab-field ab-field-col">
                <label className="ab-field-label" htmlFor="md-args">
                  Args (one per line)
                </label>
                <textarea
                  id="md-args"
                  className="ab-textarea ab-mono"
                  value={argsRaw}
                  onChange={(e) => setArgsRaw(e.target.value)}
                  rows={4}
                />
              </div>
              <div className="ab-field ab-field-col">
                <label
                  className="ab-field-label"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowHostHome}
                    onChange={(e) => setAllowHostHome(e.target.checked)}
                  />
                  Allow access to host $HOME
                </label>
                <span className="ab-field-help">
                  Off by default. Only enable if the server reads files in your
                  home directory (e.g. credentials in{' '}
                  <code className="ab-mono">~/.config</code>).
                </span>
              </div>
            </>
          )}
          <div className="ab-field">
            <span className="ab-field-label">Env vars</span>
            <Pill kind={conn.env.set ? 'success' : 'neutral'} dot>
              {conn.env.set ? 'Set' : 'None'}
            </Pill>
          </div>
          <div className="ab-field">
            <span className="ab-field-label">Headers</span>
            <Pill kind={conn.headers.set ? 'success' : 'neutral'} dot>
              {conn.headers.set ? 'Set' : 'None'}
            </Pill>
          </div>
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Discovered tools</div>
          <div className="ab-section-sub">
            Hit <strong>Discover tools</strong> to fetch the live tool list
            from this MCP server.
          </div>
        </div>
        {discoverErr && (
          <div
            className="ab-field-help"
            style={{ color: 'var(--danger)' }}
            role="alert"
          >
            {discoverErr}
          </div>
        )}
        {discoverSummary && (
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '10px 12px',
              marginBottom: 12,
              background: 'var(--success-bg)',
              border: '1px solid rgba(52, 211, 153, 0.22)',
              borderRadius: 'var(--radius)',
            }}
          >
            <Pill kind="success" dot>
              Reachable
            </Pill>
            <span className="ab-mono" style={{ fontSize: 12, color: 'var(--text)' }}>
              {discoverSummary.toolCount} tool
              {discoverSummary.toolCount === 1 ? '' : 's'} ·{' '}
              {discoverSummary.durationMs}ms
              {discoverSummary.serverVersion &&
                ` · server ${discoverSummary.serverVersion}`}
            </span>
            <span
              className="ab-field-help"
              style={{ margin: 0, marginLeft: 'auto' }}
            >
              {discoverSummary.message}
            </span>
          </div>
        )}
        {tools === null ? (
          <div className="ab-field-help">No discovery run yet.</div>
        ) : tools.length === 0 ? (
          <div className="ab-field-help">
            This server didn't advertise any tools.
          </div>
        ) : (
          <div className="ab-card ab-list-card">
            {tools.map((t) => (
              <div className="ab-list-row is-static" key={t.name}>
                <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                  ⚙
                </div>
                <div className="ab-list-row-head">
                  <div className="ab-list-row-title ab-mono">{t.name}</div>
                  {t.description && (
                    <div
                      className="ab-list-row-sub"
                      title={t.description}
                      style={{
                        display: '-webkit-box',
                        WebkitBoxOrient: 'vertical',
                        WebkitLineClamp: 1,
                        overflow: 'hidden',
                        wordBreak: 'break-word',
                      }}
                    >
                      {t.description}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Button variant="danger" onClick={remove} disabled={busy}>
          Delete connection
        </Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/library/mcp" className="ab-btn ab-btn-ghost">
            Cancel
          </Link>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
