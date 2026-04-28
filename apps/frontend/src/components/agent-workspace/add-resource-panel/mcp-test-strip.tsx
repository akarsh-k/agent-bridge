/**
 * "Test connection" strip for the MCP form. Posts to
 * `POST /api/mcp-connections/:id/test` via the RPC helper, optionally
 * passing override env/headers/command for a draft test, and renders a
 * status strip with the result.
 *
 * Phase-4H: when the backend reports `code: 'authorize_required'`, the
 * strip opens the upstream consent URL in a new tab and long-polls
 * `/test/poll` until the session resolves. The UX goal is: the
 * operator clicks Test, gets bounced to Notion in a new tab,
 * approves, closes the tab, and watches the strip flip to "Connected
 * · N tools" without touching the form again.
 *
 * The strip is intentionally thin — the heavier tool-picker UI lives in
 * the per-agent picker. For the create/edit form we just want to
 * answer: "does this connection spin up and advertise tools?"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  McpConnectionDiscoverInput,
  McpConnectionDiscoverResponse,
  DiscoveredMcpTool,
} from '@agent-bridge/shared'
import { ApiError, discoverMcpTools, pollMcpTest } from '../../../lib/rpc'

type Phase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | {
      kind: 'authorize_required'
      sessionId: string
      authorizeUrl: string
      startedAt: number
      /** Last status we passed to the long-poll. Drives the poll
       *  suspend-until-change predicate. */
      lastSeen: 'pending' | 'authorize_required'
    }
  | { kind: 'done'; result: McpConnectionDiscoverResponse }
  | { kind: 'failed'; message: string }

export interface McpTestStripProps {
  readonly connectionId: string | null
  readonly overrides?: McpConnectionDiscoverInput
  readonly disabled?: boolean
  readonly connectionName?: string
}

export function McpTestStrip({
  connectionId,
  overrides,
  disabled = false,
  connectionName,
}: McpTestStripProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  // Used to invalidate the poll loop if the user clicks Test again
  // (or unmounts). `runId` changes on every new test — the effect
  // body captures its value and bails on any subsequent tick if the
  // ref has moved.
  const runIdRef = useRef(0)

  const run = useCallback(async () => {
    if (!connectionId) return
    const thisRun = ++runIdRef.current
    setPhase({ kind: 'testing' })
    try {
      const result = await discoverMcpTools(connectionId, overrides ?? {})
      if (runIdRef.current !== thisRun) return

      if (
        !result.ok &&
        result.code === 'authorize_required' &&
        result.sessionId &&
        result.authorizeUrl
      ) {
        // Fire the consent tab as a side-effect of the synchronous
        // click → browsers don't block this (no popup heuristic
        // trips because the user initiated).
        window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
        setPhase({
          kind: 'authorize_required',
          sessionId: result.sessionId,
          authorizeUrl: result.authorizeUrl,
          startedAt: Date.now(),
          lastSeen: 'authorize_required',
        })
        return
      }

      setPhase({ kind: 'done', result })
    } catch (err) {
      if (runIdRef.current !== thisRun) return
      setPhase({
        kind: 'failed',
        message:
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Test failed',
      })
    }
  }, [connectionId, overrides])

  // Invalidate any running poll when the form unmounts. The lint
  // rule here assumes cleanup references a DOM node; we're just
  // incrementing a tick counter to poison any in-flight loop, so
  // reading the live value is intentional.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      runIdRef.current++
    }
  }, [])

  // Poll loop for the `authorize_required` phase. Kicks off when we
  // enter that phase and tears down when we leave.
  useEffect(() => {
    if (phase.kind !== 'authorize_required' || !connectionId) return
    const thisRun = runIdRef.current
    let cancelled = false

    const loop = async () => {
      // Backoff on transient errors only — success reshapes `phase`
      // and the effect re-runs against the new value.
      while (!cancelled && runIdRef.current === thisRun) {
        try {
          const snap = await pollMcpTest(
            connectionId,
            phase.sessionId,
            phase.lastSeen,
          )
          if (cancelled || runIdRef.current !== thisRun) return

          if (snap.ok) {
            setPhase({ kind: 'done', result: snap })
            return
          }
          if (snap.code === 'authorize_required') {
            // Still waiting. Loop re-enters the poll with the same
            // `lastSeen`; the server will suspend for 25 s unless
            // the session ticks to a different status.
            continue
          }
          // Any other ok:false code is terminal (auth, timeout, …).
          setPhase({ kind: 'done', result: snap })
          return
        } catch (err) {
          if (cancelled || runIdRef.current !== thisRun) return
          if (err instanceof ApiError && err.status === 404) {
            // Session expired or was superseded. Surface as a
            // soft failure so the operator can retry.
            setPhase({
              kind: 'failed',
              message:
                'Test session expired — open the drawer again and click Test.',
            })
            return
          }
          // Transient network error — brief backoff, then retry.
          await sleep(1_500)
        }
      }
    }
    void loop()

    return () => {
      cancelled = true
    }
  }, [phase, connectionId])

  const busy = phase.kind === 'testing'
  const authorizing = phase.kind === 'authorize_required'
  const canTest = !disabled && !busy && !authorizing && connectionId !== null
  const slug = useMemo(
    () => (connectionName ? slugifyPreview(connectionName) : null),
    [connectionName],
  )

  return (
    <div className="mcp-test-strip">
      <button
        type="button"
        className="btn btn-primary btn-sm mcp-test-button"
        onClick={() => void run()}
        disabled={!canTest}
        aria-busy={busy || authorizing || undefined}
        title={
          connectionId === null
            ? 'Save the connection first, then test'
            : undefined
        }
      >
        <span className="mcp-test-button-icon" aria-hidden="true">
          {busy || authorizing ? '⟳' : '▶'}
        </span>
        <span>
          {busy
            ? 'Testing connection…'
            : authorizing
              ? 'Waiting for approval…'
              : 'Test connection'}
        </span>
      </button>

      {phase.kind === 'authorize_required' ? (
        <AuthorizeStrip phase={phase} />
      ) : phase.kind === 'done' ? (
        <ResultStrip result={phase.result} slug={slug} />
      ) : phase.kind === 'failed' ? (
        <div className="status-strip error" role="alert">
          {phase.message}
        </div>
      ) : null}
    </div>
  )
}

function AuthorizeStrip({
  phase,
}: {
  phase: Extract<Phase, { kind: 'authorize_required' }>
}) {
  return (
    <div className="status-strip warning wrap" role="status">
      <div className="mcp-test-result">
        <div className="mcp-test-headline">
          <span className="mcp-test-stage">Waiting for authorization</span>
          <span className="muted">· approve in the new tab</span>
        </div>
        <div className="mcp-test-message">
          Agent Bridge opened the upstream consent page. Approve the
          connection there, then come back to this tab — the tool
          list will appear here automatically.
        </div>
        <a
          className="btn btn-ghost btn-sm mcp-test-authorize-link"
          href={phase.authorizeUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Reopen authorize page ↗
        </a>
      </div>
    </div>
  )
}

function ResultStrip({
  result,
  slug,
}: {
  result: McpConnectionDiscoverResponse
  slug: string | null
}) {
  if (!result.ok) {
    return (
      <div className="status-strip error" role="alert">
        <div className="mcp-test-result">
          <div className="mcp-test-headline">
            <span className="mcp-test-stage">{humanizeCode(result.code)}</span>
            <span className="muted">· {formatMs(result.durationMs)}</span>
          </div>
          <div className="mcp-test-message">{result.message}</div>
        </div>
      </div>
    )
  }

  const zero = result.toolCount === 0
  return (
    <div
      className={`status-strip ${zero ? 'warning' : 'saved'}`}
      role="status"
    >
      <div className="mcp-test-result">
        <div className="mcp-test-headline">
          <span className="mcp-test-stage">
            {zero
              ? 'Connected, 0 tools advertised'
              : `Connected · ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}`}
          </span>
          <span className="muted">· {formatMs(result.durationMs)}</span>
        </div>
        <div className="mcp-test-message">{result.message}</div>
        {zero ? (
          <div className="mcp-test-zero-hint">
            The server handshake succeeded but its{' '}
            <code>tools/list</code> call returned an empty array. Common
            causes: the MCP requires OAuth or a bearer token that
            wasn't supplied, or the account hasn't been granted access
            to any resources yet.
          </div>
        ) : (
          <ToolList tools={result.tools} slug={slug} />
        )}
      </div>
    </div>
  )
}

function ToolList({
  tools,
  slug,
}: {
  tools: readonly DiscoveredMcpTool[]
  slug: string | null
}) {
  return (
    <ul className="mcp-test-tool-list">
      {tools.map((tool) => (
        <li key={tool.name} className="mcp-test-tool-row">
          <div className="mcp-test-tool-name">
            <code>{slug ? `${slug}__${tool.name}` : tool.name}</code>
          </div>
          {tool.description ? (
            <div className="mcp-test-tool-desc">{tool.description}</div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function slugifyPreview(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}

function humanizeCode(
  code: Extract<McpConnectionDiscoverResponse, { ok: false }>['code'],
): string {
  switch (code) {
    case 'unreachable':
      return 'Unreachable'
    case 'auth':
      return 'Auth failed'
    case 'spawn_failed':
      return 'Spawn failed'
    case 'timeout':
      return 'Timed out'
    case 'authorize_required':
      // Shouldn't actually reach humanizeCode — the strip renders the
      // Authorize UI before it falls through to the generic error
      // path. Kept for exhaustiveness so TS doesn't fall off when
      // the discover DTO gains another code.
      return 'Authorize required'
    case 'unknown':
    default:
      return 'Failed'
  }
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
