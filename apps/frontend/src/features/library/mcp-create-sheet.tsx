/**
 * "Connect MCP" side-sheet. Stdio + http + sse transports.
 */

import { useMemo, useState, type ClipboardEvent } from 'react'
import {
  mcpAuthKinds,
  mcpConnectionCreateInputSchema,
  mcpTransports,
  type McpAuthKind,
  type McpConnectionResponse,
  type McpTransport,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { useDirtyClose } from '../../lib/use-dirty-close'

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio (run a local command)',
  http: 'http (POST endpoint)',
  sse: 'sse (server-sent events)',
}

const AUTH_LABEL: Record<McpAuthKind, string> = {
  oauth: 'OAuth (we manage the flow + token refresh)',
  headers: 'Custom headers (you supply a static token)',
  none: 'None (anonymous)',
}

const AUTH_SUB: Record<McpAuthKind, string> = {
  oauth: 'managed',
  headers: 'static token',
  none: 'anonymous',
}

/**
 * Sensible default per transport. Stdio uses env vars or wrapper-managed
 * auth so 'none' from our perspective is correct. HTTP/SSE servers
 * almost always require OAuth (Notion, Linear, Atlassian, GitHub MCP)
 * — defaulting there means clicking Discover Just Works for the
 * common case.
 */
function defaultAuthFor(transport: McpTransport): McpAuthKind {
  return transport === 'stdio' ? 'none' : 'oauth'
}

function McpCreateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated?: (connection: McpConnectionResponse) => void
}) {
  const { createMcpConnection } = useWorkspace()
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [commandOrUrl, setCommandOrUrl] = useState('')
  const [argsRaw, setArgsRaw] = useState('')
  const [allowHostHome, setAllowHostHome] = useState(false)
  // Default to the right thing per transport. The transport-change
  // handler keeps this in sync if the operator switches transports
  // without manually touching the auth picker (most common path —
  // operator picks transport, leaves auth at default).
  const [authKind, setAuthKind] = useState<McpAuthKind>(
    defaultAuthFor('stdio'),
  )
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const transportOpts: DropdownOption<McpTransport>[] = useMemo(
    () =>
      mcpTransports.map((t) => ({
        value: t,
        label: TRANSPORT_LABEL[t],
        sub: t === 'stdio' ? 'local' : 'remote',
      })),
    [],
  )

  const authOpts: DropdownOption<McpAuthKind>[] = useMemo(
    () =>
      mcpAuthKinds.map((k) => ({
        value: k,
        label: AUTH_LABEL[k],
        sub: AUTH_SUB[k],
      })),
    [],
  )

  const isStdio = transport === 'stdio'

  // Reset auth to the per-transport default when the operator switches
  // transports — but only if they hadn't already overridden it. Tracking
  // "did the user touch the auth picker" gets fiddly; cheaper heuristic
  // is to always reset on transport change. Worst case: operator picks
  // a non-default auth, switches transport, has to re-pick. Acceptable
  // since transport changes are rare during a single create flow.
  const handleTransportChange = (next: McpTransport): void => {
    setTransport(next)
    setAuthKind(defaultAuthFor(next))
  }

  const dirty =
    name.length > 0 ||
    commandOrUrl.length > 0 ||
    argsRaw.length > 0 ||
    transport !== 'stdio' ||
    authKind !== defaultAuthFor('stdio') ||
    allowHostHome
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  // Accept either format: one-arg-per-line (the textarea convention)
  // OR a JSON string array — `["-y", "mcp-remote", "https://…"]` —
  // which is what every IDE config (Cursor `mcp.json`, Claude Desktop,
  // etc.) ships. Operators copy from there 90% of the time, so the
  // form handles both rather than forcing them to reformat.
  const submit = async () => {
    setErr(null)
    const argsJson = isStdio
      ? parseJsonStringArray(argsRaw) ??
        argsRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : []
    const parsed = mcpConnectionCreateInputSchema.safeParse({
      name: name.trim(),
      transport,
      commandOrUrl: commandOrUrl.trim(),
      argsJson: isStdio && argsJson.length > 0 ? argsJson : undefined,
      allowHostHome: isStdio ? allowHostHome : undefined,
      // Stdio always sends `none` — auth lives in the subprocess, not
      // in our state machine. HTTP/SSE sends whatever the picker holds
      // (defaults to `oauth` per `defaultAuthFor`).
      auth: { kind: isStdio ? 'none' : authKind },
    })
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid MCP connection')
      return
    }
    setBusy(true)
    try {
      const created = await createMcpConnection(parsed.data)
      toast.success(`MCP “${name.trim()}” connected`)
      onCreated?.(created)
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to connect MCP',
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
      subtitle="Plug in any MCP-compatible tool server — Linear, Notion, Slack, Postgres, anything."
      primaryLabel="Connect"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!name.trim() || !commandOrUrl.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="mc-name">
          Name
        </label>
        <input
          id="mc-name"
          className="ab-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Linear, Notion, my-postgres"
          autoFocus
        />
      </div>
      <div className="ab-field">
        <span className="ab-field-label">Transport</span>
        <Dropdown<McpTransport>
          value={transport}
          onChange={handleTransportChange}
          options={transportOpts}
        />
        <span className="ab-field-help">
          {transportGuidanceFor(transport)}
        </span>
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="mc-cmd">
          {isStdio ? 'Command' : 'URL'}
        </label>
        <input
          id="mc-cmd"
          className="ab-input ab-mono"
          value={commandOrUrl}
          onChange={(e) => setCommandOrUrl(e.target.value)}
          placeholder={
            isStdio
              ? 'npx -y @modelcontextprotocol/server-…'
              : transport === 'sse'
                ? 'https://api.example.com/sse'
                : 'https://api.example.com/mcp'
          }
        />
      </div>
      {!isStdio && (
        <div className="ab-field">
          <span className="ab-field-label">Auth</span>
          <Dropdown<McpAuthKind>
            value={authKind}
            onChange={setAuthKind}
            options={authOpts}
          />
          <span className="ab-field-help">
            {authGuidanceFor(authKind)}
          </span>
        </div>
      )}
      {isStdio && (
        <>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="mc-args">
              Args (one per line)
            </label>
            <textarea
              id="mc-args"
              className="ab-textarea ab-mono"
              value={argsRaw}
              onChange={(e) => setArgsRaw(e.target.value)}
              onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                // If the operator pasted a full JSON string array
                // (`["-y", "mcp-remote", …]` — what IDE configs ship),
                // expand it to one-arg-per-line in the textarea so what
                // they see matches what we'll send.
                const pasted = e.clipboardData.getData('text')
                const arr = parseJsonStringArray(pasted)
                if (arr === null) return // let the default paste run
                e.preventDefault()
                setArgsRaw(arr.join('\n'))
              }}
              placeholder={'--db-url\npostgres://…'}
            />
            <span className="ab-field-help">
              Or paste a JSON array like{' '}
              <code className="ab-mono">
                {'["-y", "mcp-remote", "https://…"]'}
              </code>{' '}
              — we'll split it for you.
            </span>
          </div>
          <div className="ab-field">
            <label
              className="ab-field-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <input
                type="checkbox"
                checked={allowHostHome}
                onChange={(e) => setAllowHostHome(e.target.checked)}
              />
              Allow access to host $HOME
            </label>
            <span className="ab-field-help">
              Off by default. Only enable if the server needs to read your
              home directory (e.g. credentials in <code>~/.config</code>).
            </span>
          </div>
        </>
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
    </Sheet>
  )
}

export function McpCreateSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /**
   * Optional hook fired after successful creation, before `onClose`.
   * Used by the agent-attach flow so the caller can auto-select the
   * freshly-created connection in its own dropdown.
   */
  onCreated?: (connection: McpConnectionResponse) => void
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
  return (
    <McpCreateForm key={openCount} onClose={onClose} onCreated={onCreated} />
  )
}

/**
 * Steer the operator to the right transport at the point of decision.
 * Auth lifecycle differs sharply: HTTP/SSE OAuth gets full lifecycle
 * management on our side (authorize once, auto-refresh, alive forever);
 * stdio means whatever the subprocess does for itself, which Agent
 * Bridge can't track. The Notion-via-mcp-remote class of confusion was
 * a direct consequence of operators picking stdio for OAuth-protected
 * services without realising what they were giving up.
 */
function transportGuidanceFor(transport: McpTransport): string {
  switch (transport) {
    case 'stdio':
      return (
        'Pick stdio for local tools (filesystem, sqlite, git, etc.) or ' +
        'services using static API keys via env vars. ' +
        'For OAuth-protected services with an HTTP MCP endpoint ' +
        '(Notion, Linear, Atlassian, …), choose http instead — Agent ' +
        "Bridge will handle the OAuth lifecycle (authorize once, " +
        "auto-refresh tokens, you're done)."
      )
    case 'http':
      return (
        "We'll manage the OAuth flow and refresh tokens automatically. " +
        'After saving, click Discover on the connection page to authorize ' +
        "(opens a popup); you won't need to re-authorize until the upstream " +
        'refresh token expires (rare).'
      )
    case 'sse':
      return (
        'Same managed-OAuth lifecycle as http — pick sse only if the ' +
        'server explicitly requires the older Server-Sent-Events ' +
        'transport. Most modern MCP servers prefer http (Streamable-HTTP).'
      )
  }
}

/**
 * Per-auth-kind hint shown under the auth dropdown. Mirrors the
 * transport-guidance pattern — the operator reads the consequence of
 * their choice at the point of decision instead of finding out after
 * the fact (the Notion-with-auth-none-and-no-tools situation).
 */
function authGuidanceFor(authKind: McpAuthKind): string {
  switch (authKind) {
    case 'oauth':
      return (
        "After saving, click Discover to authorize — a popup opens the " +
        "upstream OAuth flow. Tokens are stored encrypted; Agent Bridge " +
        "refreshes them automatically so the connection stays alive " +
        "across IDE sessions without you returning here."
      )
    case 'headers':
      return (
        'Provide a static auth token via the headers field on the ' +
        'connection page (e.g. ' +
        "'Authorization: Bearer <token>'). Use this for personal access " +
        "tokens / API keys that don't expire. We don't refresh anything."
      )
    case 'none':
      return (
        'Anonymous — no auth header sent. Only valid for MCP servers ' +
        "that explicitly allow unauthenticated access (rare for hosted " +
        "services). Discover will fail silently with 0 tools if the " +
        "server actually requires auth."
      )
  }
}

/**
 * Parse a textarea string as a JSON array of strings, the format every
 * IDE config (Cursor `mcp.json`, Claude Desktop, etc.) uses for stdio
 * server `args`. Returns the parsed array on a clean match; `null`
 * otherwise so the caller can fall back to the line-split convention.
 *
 * Strict on both ends: requires the trimmed content to start with `[`
 * and end with `]` AND parse as an array AND have every element be a
 * string. Anything else (single bracket, mixed types, malformed JSON)
 * falls through so partial typed input doesn't get silently mangled.
 */
function parseJsonStringArray(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  if (!parsed.every((x) => typeof x === 'string')) return null
  return parsed as string[]
}
