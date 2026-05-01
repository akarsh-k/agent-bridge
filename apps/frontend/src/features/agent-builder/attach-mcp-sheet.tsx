/**
 * "Connect MCP" side-sheet for an agent — choose a connection from
 * the library, discover its tools, and toggle which tools the agent
 * is allowed to call. Persists via `setAgentMcpTools` (PUT replace).
 */

import { useEffect, useMemo, useState } from 'react'
import type { AllowlistEntry } from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { Button } from '../../ui/button'
import { PlusIcon } from '../../ui/icons'
import { useWorkspace } from '../../lib/workspace-context'
import { ApiError, discoverMcpTools, pollMcpTest } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'
import { McpCreateSheet } from '../library/mcp-create-sheet'

interface DiscoveredTool {
  name: string
  description?: string
}

function AttachMcpForm({
  agentId,
  onClose,
}: {
  agentId: string
  onClose: () => void
}) {
  const { mcpConnections, agentResources, setAgentMcpTools } = useWorkspace()
  const opts: DropdownOption[] = useMemo(
    () =>
      mcpConnections.map((m) => ({
        value: m.id,
        label: m.name,
        sub: m.transport,
      })),
    [mcpConnections],
  )

  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredTool[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverErr, setDiscoverErr] = useState<string | null>(null)
  const [createSheetOpen, setCreateSheetOpen] = useState(false)

  // Initialise the allowed set with whatever's currently allowed.
  const initiallyAllowed = useMemo(
    () =>
      new Set(
        (agentResources[agentId]?.mcpAllowlist ?? [])
          .filter((m) => m.mcpConnectionId === connectionId && m.enabled)
          .map((m) => m.toolName),
      ),
    [agentResources, agentId, connectionId],
  )
  const [allowed, setAllowed] = useState<Set<string>>(initiallyAllowed)
  const [allowedConnId, setAllowedConnId] = useState<string | null>(connectionId)
  if (allowedConnId !== connectionId) {
    setAllowedConnId(connectionId)
    setAllowed(new Set(initiallyAllowed))
  }

  // Auto-discover whenever the connection changes. Handles the OAuth
  // happy-path: when discover returns `authorize_required`, open the
  // upstream consent popup and poll until the user approves (or fails).
  useEffect(() => {
    if (!connectionId) return
    let alive = true
    let popup: Window | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const applyResult = (
      res: Awaited<ReturnType<typeof discoverMcpTools>>,
    ): void => {
      if (!alive) return
      if (res.ok) {
        setDiscovered(
          res.tools.map((t) => ({
            name: t.name,
            description: t.description ?? undefined,
          })),
        )
        setDiscovering(false)
        return
      }
      if (res.code === 'authorize_required' && res.sessionId) {
        if (res.authorizeUrl && !popup) {
          popup = window.open(
            res.authorizeUrl,
            'agent-bridge-mcp-oauth',
            'popup,width=520,height=720',
          )
        }
        const sessionId = res.sessionId
        timer = setTimeout(async () => {
          if (!alive) return
          try {
            const next = await pollMcpTest(
              connectionId,
              sessionId,
              'authorize_required',
            )
            applyResult(next)
          } catch (err) {
            if (!alive) return
            setDiscoverErr(
              err instanceof ApiError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'Polling failed',
            )
            setDiscovering(false)
          }
        }, 1500)
        return
      }
      setDiscoverErr(res.message ?? `Discovery failed (${res.code})`)
      setDiscovered([])
      setDiscovering(false)
    }

    void (async () => {
      if (!alive) return
      setDiscovering(true)
      setDiscoverErr(null)
      try {
        const res = await discoverMcpTools(connectionId, {})
        applyResult(res)
      } catch (err) {
        if (alive) {
          setDiscoverErr(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Failed to discover tools',
          )
          setDiscovering(false)
        }
      }
    })()

    // Auto-close the popup when the OAuth callback page sends us a
    // `mcp-oauth-complete` message. The backend's callback HTML
    // posts this before closing itself; we belt-and-suspender by
    // also closing on our side.
    const onMessage = (e: MessageEvent) => {
      if (
        e.data &&
        typeof e.data === 'object' &&
        (e.data as { type?: unknown }).type === 'mcp-oauth-complete'
      ) {
        if (popup && !popup.closed) popup.close()
        popup = null
      }
    }
    window.addEventListener('message', onMessage)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      if (popup && !popup.closed) popup.close()
      window.removeEventListener('message', onMessage)
    }
  }, [connectionId])

  // Reset discovered when the connection clears — derived state pattern,
  // not an effect, so the lint rule stays happy.
  const [resetForConn, setResetForConn] = useState<string | null>(connectionId)
  if (resetForConn !== connectionId) {
    setResetForConn(connectionId)
    if (!connectionId) {
      setDiscovered(null)
      setDiscoverErr(null)
      setDiscovering(false)
    }
  }

  const toggle = (toolName: string) => {
    setAllowed((prev) => {
      const next = new Set(prev)
      if (next.has(toolName)) next.delete(toolName)
      else next.add(toolName)
      return next
    })
  }

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Dirty if the user changed the allowed-set OR picked a connection
  // they haven't saved yet.
  const dirty =
    connectionId !== null &&
    (() => {
      const initSet = new Set(initiallyAllowed)
      if (initSet.size !== allowed.size) return true
      for (const t of allowed) if (!initSet.has(t)) return true
      return false
    })()
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    if (!connectionId) return
    setBusy(true)
    setErr(null)
    try {
      // Merge: keep allowlist entries from OTHER connections, replace
      // entries for the active connection.
      const others: AllowlistEntry[] = (
        agentResources[agentId]?.mcpAllowlist ?? []
      )
        .filter((m) => m.mcpConnectionId !== connectionId && m.enabled)
        .map((m) => ({ mcpConnectionId: m.mcpConnectionId, toolName: m.toolName }))
      const here: AllowlistEntry[] = [...allowed].map((toolName) => ({
        mcpConnectionId: connectionId,
        toolName,
      }))
      await setAgentMcpTools(agentId, [...others, ...here])
      toast.success('MCP allowlist updated')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to update allowlist',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="Connect MCP server"
      subtitle="Pick a server and choose which of its tools this agent can call."
      primaryLabel="Save allowlist"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!connectionId}
    >
      {mcpConnections.length === 0 ? (
        <div className="ab-field" style={{ alignItems: 'flex-start' }}>
          <div className="ab-field-help" style={{ marginBottom: 10 }}>
            No MCP servers in your library yet. Create one to attach it
            to this agent.
          </div>
          <Button
            variant="primary"
            size="sm"
            leading={<PlusIcon strokeWidth={2.4} />}
            onClick={() => setCreateSheetOpen(true)}
          >
            New MCP connection
          </Button>
        </div>
      ) : (
        <>
          <div className="ab-field">
            <span className="ab-field-label">Connection</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Dropdown
                  value={connectionId}
                  onChange={setConnectionId}
                  options={opts}
                  placeholder="Pick a connection"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                leading={<PlusIcon strokeWidth={2.4} />}
                onClick={() => setCreateSheetOpen(true)}
                title="Create a new MCP connection"
              >
                New
              </Button>
            </div>
          </div>
          {discovering && (
            <div className="ab-field-help">Discovering tools…</div>
          )}
          {discoverErr && (
            <div
              className="ab-field-help"
              style={{ color: 'var(--danger)' }}
              role="alert"
            >
              {discoverErr}
            </div>
          )}
          {discovered && discovered.length === 0 && (
            <div className="ab-field-help">
              This server didn't advertise any tools.
            </div>
          )}
          {discovered && discovered.length > 0 && (
            <div className="ab-field">
              <span className="ab-field-label">
                Allowed tools ({allowed.size}/{discovered.length})
              </span>
              <div className="ab-card ab-list-card">
                {discovered.map((t) => {
                  const on = allowed.has(t.name)
                  return (
                    <button
                      key={t.name}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={`ab-list-row${on ? ' is-selected' : ''}`}
                      onClick={() => toggle(t.name)}
                    >
                      <span
                        className={`ab-checkbox${on ? ' is-on' : ''}`}
                        aria-hidden="true"
                      >
                        <svg viewBox="0 0 16 16" fill="none">
                          <path
                            d="M3 8.5l3 3 7-7"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <div className="ab-list-row-head">
                        <div className="ab-list-row-title ab-mono">
                          {t.name}
                        </div>
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
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {err && (
            <div
              className="ab-field-help"
              style={{ color: 'var(--danger)' }}
              role="alert"
            >
              {err}
            </div>
          )}
        </>
      )}
      <McpCreateSheet
        open={createSheetOpen}
        onClose={() => setCreateSheetOpen(false)}
        onCreated={(connection) => {
          // Auto-select the freshly-created MCP so the existing
          // discovery effect kicks off without an extra click. The
          // workspace store already has it (createMcpConnection
          // updates `mcpConnections`), so the dropdown will render
          // it on this same render pass.
          setConnectionId(connection.id)
        }}
      />
    </Sheet>
  )
}

export function AttachMcpSheet({
  open,
  agentId,
  onClose,
}: {
  open: boolean
  agentId: string
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Connect MCP server">
        <></>
      </Sheet>
    )
  }
  return <AttachMcpForm key={openCount} agentId={agentId} onClose={onClose} />
}
