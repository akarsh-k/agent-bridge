/**
 * Create/edit form for an `mcp_connections` row.
 *
 * Shared between:
 *   - `AddResourcePanel` `'mcp-new'` view (create path)
 *   - `McpInspector` "Edit" mode (update path)
 *
 * Transport-driven UI — the field set changes based on `transport`:
 *
 *   stdio   → Command (path), Args, Env map, Allow host HOME toggle
 *   http/sse→ URL, Headers map                                      (no allow-host-home)
 *
 * Transport is **immutable** after create: the backend DTO refines on
 * PATCH, but we also disable the control in the UI so the operator
 * can't even attempt it.
 *
 * On create the form calls `workspace.createMcpConnection` and then
 * hands the caller a newly-saved row — useful because the "Test
 * connection" button needs a persisted id.
 */

import { useCallback, useMemo, useState, type FormEvent } from 'react'
import {
  mcpConnectionCreateInputSchema,
  mcpConnectionUpdateInputSchema,
  mcpTransports,
  type McpAuthKind,
  type McpConnectionResponse,
  type McpTransport,
  type SecretMapInput,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { AddFormActions, ErrorText } from './form-atoms'
import { McpTestStrip } from './mcp-test-strip'
import { SecretMapEditor } from './secret-map-editor'
import {
  secretMapStateToInput,
  useSecretMapState,
  validateSecretMapState,
} from './secret-map-state'

export type McpFormMode = 'create' | 'edit'

export interface McpFormProps {
  readonly existing: McpConnectionResponse | null
  readonly onCancel: () => void
  /**
   * Fired after a successful create / edit. For create the callback
   * receives the newly-saved row so the parent can transition into the
   * picker (4D) without a second roundtrip.
   */
  readonly onDone: (connection: McpConnectionResponse) => void
}

export function McpForm({ existing, onCancel, onDone }: McpFormProps) {
  const mode: McpFormMode = existing ? 'edit' : 'create'
  const { createMcpConnection, patchMcpConnection, removeMcpConnection } =
    useWorkspace()

  const [name, setName] = useState(existing?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(
    existing?.transport ?? 'stdio',
  )
  const [commandOrUrl, setCommandOrUrl] = useState(existing?.commandOrUrl ?? '')
  const [argsText, setArgsText] = useState(existing?.argsJson.join(' ') ?? '')
  const [allowHostHome, setAllowHostHome] = useState(
    existing?.allowHostHome ?? false,
  )
  // Auth kind is HTTP-only. Stdio rows force it to 'none' (the DTO
  // policy rejects anything else). For new HTTP rows default to
  // 'none' — the operator picks OAuth / Headers explicitly rather
  // than silently inheriting the previous "headers-if-you-say-so"
  // behavior. Existing rows keep whatever the backfill stored.
  const [authKind, setAuthKind] = useState<McpAuthKind>(
    existing?.auth.kind ?? 'none',
  )

  const [envState, setEnvState] = useSecretMapState(
    mode,
    existing?.env.set ?? false,
  )
  const [headersState, setHeadersState] = useSecretMapState(
    mode,
    existing?.headers.set ?? false,
  )

  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Track the newly-saved row id so "Test connection" lights up after
  // create without the user needing to close and reopen the drawer.
  const [currentId, setCurrentId] = useState<string | null>(
    existing?.id ?? null,
  )

  const isHttp = transport === 'http' || transport === 'sse'
  const isStdio = transport === 'stdio'
  // Dedicated flag so the JSX reads cleanly. For stdio/none/oauth
  // the Headers section collapses — the user shouldn't be typing
  // header key/values when auth has no use for them.
  const showHeaders = isHttp && authKind === 'headers'

  const argsArray = useMemo(() => parseArgs(argsText), [argsText])
  const argsWarning = useMemo(
    () => (isStdio ? validateArgsText(argsText) : null),
    [argsText, isStdio],
  )

  // Live-compute the overrides for the "Test connection" button so the
  // operator can hit it mid-draft without saving first. For create, the
  // button stays disabled until we have a saved id (see strip).
  const testOverrides = useMemo(() => {
    if (mode === 'create') return undefined
    const env = isHttp ? undefined : secretMapStateToInput(envState, mode)
    // Only send the draft headers when the draft is header-auth too —
    // otherwise the backend refine rejects "oauth + headers" and the
    // Test button would fail before it could probe.
    const headers = showHeaders
      ? secretMapStateToInput(headersState, mode)
      : undefined
    const auth =
      isHttp && authKind !== (existing?.auth.kind ?? 'none')
        ? { kind: authKind }
        : undefined
    return {
      commandOrUrl:
        commandOrUrl.trim() !== existing?.commandOrUrl
          ? commandOrUrl.trim()
          : undefined,
      argsJson:
        isStdio && argsText !== existing?.argsJson.join(' ')
          ? [...argsArray]
          : undefined,
      env,
      headers,
      auth,
      allowHostHome:
        isStdio && allowHostHome !== existing?.allowHostHome
          ? allowHostHome
          : undefined,
    }
  }, [
    mode,
    commandOrUrl,
    existing,
    isHttp,
    isStdio,
    argsText,
    argsArray,
    envState,
    headersState,
    allowHostHome,
    authKind,
    showHeaders,
  ])

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setErr(null)

      const envIssue = isStdio ? validateSecretMapState(envState) : null
      // Headers validation only runs when the user actually picked the
      // 'headers' auth kind — 'oauth'/'none' collapse the input and
      // the (possibly stale) editor state should not block submission.
      const headerIssue = showHeaders
        ? validateSecretMapState(headersState)
        : null
      const argsIssue = isStdio ? validateArgsText(argsText) : null
      if (argsIssue) return setErr(argsIssue)
      if (envIssue) return setErr(envIssue)
      if (headerIssue) return setErr(headerIssue)

      const envInput: SecretMapInput | undefined = isStdio
        ? secretMapStateToInput(envState, mode)
        : undefined
      const headersInput: SecretMapInput | undefined = showHeaders
        ? secretMapStateToInput(headersState, mode)
        : undefined

      try {
        if (mode === 'create') {
          const parsed = mcpConnectionCreateInputSchema.safeParse({
            name: name.trim(),
            transport,
            commandOrUrl: commandOrUrl.trim(),
            argsJson: argsArray,
            allowHostHome: isStdio ? allowHostHome : false,
            auth: { kind: isHttp ? authKind : 'none' },
            ...(envInput ? { env: envInput } : {}),
            ...(headersInput ? { headers: headersInput } : {}),
          })
          if (!parsed.success) {
            return setErr(firstIssueMessage(parsed.error))
          }
          setBusy(true)
          const saved = await createMcpConnection(parsed.data)
          setCurrentId(saved.id)
          onDone(saved)
        } else if (existing) {
          const prevAuthKind: McpAuthKind = existing.auth.kind
          const parsed = mcpConnectionUpdateInputSchema.safeParse({
            ...(name.trim() !== existing.name ? { name: name.trim() } : {}),
            ...(commandOrUrl.trim() !== existing.commandOrUrl
              ? { commandOrUrl: commandOrUrl.trim() }
              : {}),
            ...(isStdio && argsText !== existing.argsJson.join(' ')
              ? { argsJson: argsArray }
              : {}),
            ...(isStdio && allowHostHome !== existing.allowHostHome
              ? { allowHostHome }
              : {}),
            ...(isHttp && authKind !== prevAuthKind
              ? { auth: { kind: authKind } }
              : {}),
            ...(envInput ? { env: envInput } : {}),
            ...(headersInput ? { headers: headersInput } : {}),
          })
          if (!parsed.success) {
            return setErr(firstIssueMessage(parsed.error))
          }
          setBusy(true)
          const saved = await patchMcpConnection(existing.id, parsed.data)
          onDone(saved)
        }
      } catch (submitErr) {
        setErr(
          submitErr instanceof ApiError
            ? submitErr.message
            : submitErr instanceof Error
              ? submitErr.message
              : 'Failed to save MCP connection',
        )
      } finally {
        setBusy(false)
      }
    },
    [
      allowHostHome,
      argsArray,
      argsText,
      authKind,
      commandOrUrl,
      createMcpConnection,
      envState,
      existing,
      headersState,
      isHttp,
      isStdio,
      mode,
      name,
      onDone,
      patchMcpConnection,
      showHeaders,
      transport,
    ],
  )

  const deleteConnection = useCallback(async () => {
    if (!existing) return
    if (
      !window.confirm(
        `Delete MCP connection "${existing.name}"? ` +
          `This will also clear the allowlist for every agent that uses it.`,
      )
    ) {
      return
    }
    setErr(null)
    setBusy(true)
    try {
      await removeMcpConnection(existing.id)
      onCancel()
    } catch (delErr) {
      setErr(
        delErr instanceof ApiError
          ? delErr.message
          : delErr instanceof Error
            ? delErr.message
            : 'Failed to delete MCP connection',
      )
    } finally {
      setBusy(false)
    }
  }, [existing, onCancel, removeMcpConnection])

  return (
    <form
      className="add-resource-form mcp-form"
      onSubmit={(e) => void submit(e)}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="notion"
          maxLength={120}
          disabled={busy}
          required
        />
        <span className="field-hint">
          Used as the tool-prefix in the agent view
          {name.trim() ? ` (${slugifyPreview(name)}__tool_name)` : ''}.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Transport</span>
        <select
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpTransport)}
          disabled={busy || mode === 'edit'}
        >
          {mcpTransports.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="field-hint">
          {mode === 'edit'
            ? 'Transport is fixed after create.'
            : 'http/sse both use Streamable-HTTP under the hood; the label hints at the shim style.'}
        </span>
      </label>

      <label className="field">
        <span className="field-label">{isStdio ? 'Command path' : 'URL'}</span>
        <input
          className="field-mono"
          value={commandOrUrl}
          onChange={(e) => setCommandOrUrl(e.target.value)}
          placeholder={
            isStdio ? '/usr/local/bin/npx' : 'https://mcp.example.com/rpc'
          }
          disabled={busy}
          spellCheck={false}
          required
        />
      </label>

      {isStdio ? (
        <label className="field">
          <span className="field-label">Args</span>
          <input
            className="field-mono"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="-y @modelcontextprotocol/server-notion"
            disabled={busy}
            spellCheck={false}
            aria-invalid={argsWarning ? true : undefined}
          />
          <span className="field-hint">
            Space-separated. Also accepts a JSON array (e.g.{' '}
            <code>["-y", "mcp-remote", "https://…"]</code>). Quotes and brackets
            are preserved literally in the space-separated form — don't mix
            them.
          </span>
          {argsWarning ? (
            <span className="field-error">{argsWarning}</span>
          ) : argsArray.length > 0 ? (
            <span className="field-hint mcp-args-preview">
              Parsed {argsArray.length} arg{argsArray.length === 1 ? '' : 's'}:{' '}
              {argsArray.map((a, i) => (
                <span key={i}>
                  {i > 0 ? ' ' : null}
                  <code>{a}</code>
                </span>
              ))}
            </span>
          ) : null}
        </label>
      ) : null}

      {isStdio ? (
        <fieldset className="field mcp-env-field">
          <legend className="field-label">Environment</legend>
          <span className="field-hint">
            Key-value pairs passed to the subprocess. Values are encrypted at
            rest. Never appear in logs or run events.
          </span>
          <SecretMapEditor
            state={envState}
            onChange={setEnvState}
            mode={mode}
            hasStoredSecret={existing?.env.set ?? false}
            keyPlaceholder="NOTION_TOKEN"
            valuePlaceholder="secret_xxx…"
            valueLabel="Environment variable value"
            disabled={busy}
          />
        </fieldset>
      ) : null}

      {isHttp ? (
        <label className="field">
          <span className="field-label">Authentication</span>
          <select
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as McpAuthKind)}
            disabled={busy}
          >
            <option value="none">None</option>
            <option value="oauth">OAuth (sign-in flow)</option>
            <option value="headers">Headers / bearer token</option>
          </select>
          <span className="field-hint">
            {authKind === 'oauth' ? (
              <>
                The Test button opens the upstream consent page in a new tab.
                After approval, Agent Bridge stores refresh + access tokens
                encrypted at rest.
              </>
            ) : authKind === 'headers' ? (
              <>
                Static headers sent on every request. Values are encrypted at
                rest.
              </>
            ) : (
              <>
                No auth. Use when the MCP server accepts anonymous requests.
              </>
            )}
          </span>
        </label>
      ) : null}

      {showHeaders ? (
        <fieldset className="field mcp-headers-field">
          <legend className="field-label">Request headers</legend>
          <span className="field-hint">
            Sent on every request to the MCP server (Streamable-HTTP + SSE).
            Values are encrypted at rest.
          </span>
          <SecretMapEditor
            state={headersState}
            onChange={setHeadersState}
            mode={mode}
            hasStoredSecret={existing?.headers.set ?? false}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer sk-…"
            valueLabel="Header value"
            disabled={busy}
          />
        </fieldset>
      ) : null}

      {isStdio ? (
        <details className="mcp-advanced">
          <summary>Advanced</summary>
          <label className="field mcp-toggle-field">
            <input
              type="checkbox"
              checked={allowHostHome}
              onChange={(e) => setAllowHostHome(e.target.checked)}
              disabled={busy}
            />
            <span>
              <span className="field-label">Allow host HOME</span>
              <span className="field-hint">
                Lets the subprocess read your real <code>~/</code>, including{' '}
                <code>~/.config/gh</code>, <code>~/.aws</code>,{' '}
                <code>~/.ssh</code>. Enable only for trusted CLIs that need user
                auth state (e.g. <code>gh</code>).
              </span>
            </span>
          </label>
          {allowHostHome ? (
            <div className="status-strip error wrap" role="alert">
              This MCP will read your real <code>~</code>. Revisit the trade-off
              documented in <em>docs/ARCHITECTURE.md</em> §3 before enabling for
              a connection you don't control.
            </div>
          ) : null}
        </details>
      ) : null}

      <div className="mcp-form-test">
        <McpTestStrip
          connectionId={currentId}
          overrides={testOverrides}
          disabled={busy}
          connectionName={name.trim() || existing?.name}
        />
      </div>

      <ErrorText message={err} />

      <AddFormActions
        submitLabel={
          busy
            ? mode === 'create'
              ? 'Creating…'
              : 'Saving…'
            : mode === 'create'
              ? 'Create connection'
              : 'Save changes'
        }
        busy={busy}
        disabled={name.trim().length === 0 || commandOrUrl.trim().length === 0}
        onCancel={onCancel}
        leading={
          mode === 'edit' && existing ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm mcp-form-delete-btn"
              onClick={() => void deleteConnection()}
              disabled={busy}
            >
              Delete connection
            </button>
          ) : undefined
        }
      />
    </form>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse the Args input into a clean `string[]`. Accepts TWO formats
 * transparently — operators often copy/paste canonical MCP config
 * snippets straight from vendor docs:
 *
 *   1. JSON array:        `["-y", "mcp-remote", "https://…"]`
 *   2. Space-separated:   `-y mcp-remote https://…`
 *
 * The space-separated path is the documented one (see the hint under
 * the input) — we still accept #1 because the alternative is a silent
 * footgun where a mistaken paste stores three garbage tokens with
 * literal `["`, `",`, `"]` in them (the MCP then never connects and
 * "Test connection" reports a meaningless 0 tools).
 *
 * Ambiguity: `[foo] bar` is technically space-separated with a `[foo]`
 * token, not a JSON array. We only attempt `JSON.parse` when the text
 * starts with `[` AND ends with `]` AND the result is a string[]. On
 * any failure we fall through to the split path so legitimate
 * bracketed tokens still work.
 */
function parseArgs(text: string): readonly string[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed.map((s) => s.trim()).filter((s) => s.length > 0)
      }
    } catch {
      // Fall through — validateArgsText will surface the specific
      // issue (broken JSON → parse error; `[ foo, bar ]` without
      // quotes → still caught as suspicious by the space-split
      // validation below).
    }
  }
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Return null when the Args input is clean, or a user-facing error
 * when the tokens post-parse still carry JSON-structural cruft
 * (leading `[`, trailing `]`, a wrapping `"…"` quote pair, or a
 * trailing `,`). This catches the classic footgun of pasting
 * `["-y", "mcp-remote", "…"]` into the space-separated field — the
 * naive split used to store three garbage tokens and the connection
 * silently broke.
 */
function validateArgsText(text: string): string | null {
  const trimmed = text.trim()
  // Explicit failure when the operator clearly meant JSON but the
  // bracket pair is broken ("[foo", "bar]", etc). Checked before the
  // split so we get a clean error instead of a suspicious-token one.
  if (
    (trimmed.startsWith('[') && !trimmed.endsWith(']')) ||
    (!trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return (
      'Args looks like JSON but is missing a matching bracket. Either ' +
      'use a valid JSON array (e.g. ["-y", "mcp-remote"]) or plain ' +
      'space-separated tokens.'
    )
  }
  const tokens = parseArgs(text)
  const suspicious = tokens.find((tok) =>
    /^\[|\]$|^"[^"]*"$|,$|^"|"$/.test(tok),
  )
  if (suspicious) {
    return (
      `Args token ${JSON.stringify(suspicious)} looks like stray JSON ` +
      `syntax. Use plain space-separated args (e.g. -y mcp-remote ` +
      `https://…) or a valid JSON array.`
    )
  }
  return null
}

function firstIssueMessage(error: {
  issues: ReadonlyArray<{ message: string; path?: PropertyKey[] }>
}): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid connection'
  const field = issue.path?.[0]
  return field ? `${String(field)}: ${issue.message}` : issue.message
}

/**
 * Preview the prefix the tool-picker will render. Must stay aligned with
 * `slugifyConnectionName` in `packages/agents/src/mcp/external-mcps.ts`.
 * A drift here is a purely cosmetic lie, but would confuse operators
 * when the picker shows a different prefix than the form preview.
 */
function slugifyPreview(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}
