/**
 * "Connect MCP" side-sheet. Stdio + http + sse transports.
 */

import { useMemo, useState, type ClipboardEvent } from 'react'
import {
  mcpConnectionCreateInputSchema,
  mcpTransports,
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

  const isStdio = transport === 'stdio'

  const dirty =
    name.length > 0 ||
    commandOrUrl.length > 0 ||
    argsRaw.length > 0 ||
    transport !== 'stdio' ||
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
          onChange={setTransport}
          options={transportOpts}
        />
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
            isStdio ? 'npx -y @modelcontextprotocol/server-…' : 'https://api.example.com/mcp'
          }
        />
      </div>
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
