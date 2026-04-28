/**
 * In-memory test-session registry — Phase 4H.
 *
 * A "test session" owns the state of a single
 * `POST /api/mcp-connections/:id/test` that hasn't terminated yet. Its
 * most interesting job is bridging the OAuth redirect: the initial
 * POST kicks off an `MCPClient.listToolsets()` call, that call blocks
 * on Mastra's provider which emits `onRedirectToAuthorization(url)`,
 * and the session parks the in-flight client + its provider in this
 * registry while the user walks through the consent screen in their
 * browser.
 *
 * When the browser redirects to `/oauth/mcp/:id/callback?code&state`,
 * the callback handler resolves the session by `connectionId` and
 * hands the code to the waiting transport. Once the provider writes
 * the exchanged tokens to `mcp_oauth_state`, `listToolsets()`
 * unblocks and the session transitions to `ok`.
 *
 * Lifecycle rules:
 *   - In-memory only; losing a session on restart is acceptable (the
 *     user just clicks Test again, the browser reopens the authorize
 *     URL, and Notion happily re-approves since it cached the
 *     dynamic-client registration).
 *   - Exactly one active (non-terminal) session per `connectionId`.
 *     Creating a new one cancels the old one. No concurrent OAuth
 *     flows for the same row — Notion's `state` parameter guarantees
 *     that the "stale" one couldn't succeed anyway.
 *   - Terminal sessions linger for `TERMINAL_TTL_MS` so pollers can
 *     observe the final state. Non-terminal sessions expire after
 *     `SESSION_TTL_MS` (the user walked away from the authorize tab).
 *
 * Scope: this module knows nothing about Mastra, drizzle, or DTOs —
 * the dispatcher in `discover.ts` holds those connections and hands
 * plain values into the registry.
 */

import { randomUUID } from 'node:crypto'
import type { DiscoveredMcpTool, McpTransport } from '@agent-bridge/shared'

// ─── Public types ────────────────────────────────────────────────────────

export type TestSessionStatus =
  | 'pending'
  | 'authorize_required'
  | 'ok'
  | 'failed'

export type TestSessionTerminal = Extract<TestSessionStatus, 'ok' | 'failed'>

/**
 * What each status carries. Kept as a discriminated union so
 * downstream code can exhaustively switch on `status`.
 */
export type TestSessionSnapshot =
  | {
      readonly status: 'pending'
      readonly sessionId: string
      readonly connectionId: string
      readonly transport: McpTransport
      readonly startedAt: number
    }
  | {
      readonly status: 'authorize_required'
      readonly sessionId: string
      readonly connectionId: string
      readonly transport: McpTransport
      readonly startedAt: number
      readonly authorizeUrl: string
    }
  | {
      readonly status: 'ok'
      readonly sessionId: string
      readonly connectionId: string
      readonly transport: McpTransport
      readonly startedAt: number
      readonly durationMs: number
      readonly tools: readonly DiscoveredMcpTool[]
      readonly rawToolCount: number
      readonly serverVersion: string | null
    }
  | {
      readonly status: 'failed'
      readonly sessionId: string
      readonly connectionId: string
      readonly transport: McpTransport
      readonly startedAt: number
      readonly durationMs: number
      readonly code:
        | 'unreachable'
        | 'auth'
        | 'spawn_failed'
        | 'timeout'
        | 'unknown'
      readonly message: string
    }

/**
 * Callback the dispatcher hands to the registry. Fired exactly once
 * when the session transitions to a terminal state. Used for
 * resource cleanup (disconnect MCPClient, abort OAuth waiter, etc.)
 * without coupling the registry to those objects.
 */
export type TestSessionDisposer = () => void | Promise<void>

// ─── Internal record ─────────────────────────────────────────────────────

interface TestSessionRecord {
  snapshot: TestSessionSnapshot
  /**
   * Listeners registered by `/test/poll` long-polls. Fired once each
   * on state change, then cleared. Rejected poll-waiters silently
   * resolve with the current snapshot (which may still be pending) —
   * the HTTP layer re-polls.
   */
  waiters: Array<(snap: TestSessionSnapshot) => void>
  /** TTL timer handle; reset on every state change. */
  expiryTimer: NodeJS.Timeout
  disposer: TestSessionDisposer
  /**
   * OAuth `state` param the provider generated. Used by the callback
   * route as a CSRF guard on top of the connection-id path scope.
   */
  oauthState: string | null
}

// ─── Config ──────────────────────────────────────────────────────────────

/** Max lifetime of a non-terminal session (user walked away from consent). */
const SESSION_TTL_MS = 5 * 60 * 1000

/** How long a terminal session sticks around so pollers can observe it. */
const TERMINAL_TTL_MS = 30 * 1000

// ─── Registry class ──────────────────────────────────────────────────────

export class TestSessionRegistry {
  private readonly byId = new Map<string, TestSessionRecord>()
  private readonly byConnection = new Map<string, string>() // connId → sessionId

  /**
   * Create a fresh `pending` session and cancel any prior one for the
   * same connection. Returns the initial snapshot; store the
   * `sessionId` for later updates.
   *
   * `disposer` fires exactly once on terminal transition or TTL
   * expiry. Use it to close the MCPClient, abort in-flight fetches,
   * etc.
   */
  create(args: {
    readonly connectionId: string
    readonly transport: McpTransport
    readonly disposer: TestSessionDisposer
  }): TestSessionSnapshot {
    this.cancelForConnection(args.connectionId)

    const sessionId = randomUUID()
    const startedAt = Date.now()
    const snap: TestSessionSnapshot = {
      status: 'pending',
      sessionId,
      connectionId: args.connectionId,
      transport: args.transport,
      startedAt,
    }
    const record: TestSessionRecord = {
      snapshot: snap,
      waiters: [],
      expiryTimer: this.armTimer(sessionId, SESSION_TTL_MS),
      disposer: args.disposer,
      oauthState: null,
    }
    this.byId.set(sessionId, record)
    this.byConnection.set(args.connectionId, sessionId)
    return snap
  }

  get(sessionId: string): TestSessionSnapshot | undefined {
    return this.byId.get(sessionId)?.snapshot
  }

  getByConnection(connectionId: string): TestSessionSnapshot | undefined {
    const sid = this.byConnection.get(connectionId)
    if (!sid) return undefined
    return this.byId.get(sid)?.snapshot
  }

  /**
   * Remember the OAuth `state` param the provider generated for this
   * session. The callback route uses it to reject callback hits with
   * a mismatched `state` — a CSRF guard that sits next to the
   * connection-id path scope.
   */
  attachOauthState(sessionId: string, oauthState: string): void {
    const record = this.byId.get(sessionId)
    if (!record) return
    record.oauthState = oauthState
  }

  /**
   * Verify a callback's `state` matches what the provider generated
   * for the session. Returns false for unknown sessions, closed
   * sessions, or state mismatches.
   */
  matchOauthState(sessionId: string, oauthState: string): boolean {
    const record = this.byId.get(sessionId)
    if (!record) return false
    return record.oauthState !== null && record.oauthState === oauthState
  }

  /**
   * Flip the session to `authorize_required`. Re-arms the TTL with
   * the full non-terminal budget — the user might take minutes.
   */
  markAuthorizeRequired(sessionId: string, authorizeUrl: string): void {
    const record = this.byId.get(sessionId)
    if (!record) return
    const prev = record.snapshot
    if (prev.status !== 'pending' && prev.status !== 'authorize_required') {
      return // already terminal; no-op
    }
    record.snapshot = {
      status: 'authorize_required',
      sessionId,
      connectionId: prev.connectionId,
      transport: prev.transport,
      startedAt: prev.startedAt,
      authorizeUrl,
    }
    clearTimeout(record.expiryTimer)
    record.expiryTimer = this.armTimer(sessionId, SESSION_TTL_MS)
    this.drainWaiters(record)
  }

  /**
   * Drop to a terminal state. Caller supplies the full payload
   * (tools for ok, code+message for failed). Fires the disposer and
   * schedules GC.
   */
  finalize(
    sessionId: string,
    final:
      | {
          readonly status: 'ok'
          readonly tools: readonly DiscoveredMcpTool[]
          readonly rawToolCount: number
          readonly serverVersion: string | null
        }
      | {
          readonly status: 'failed'
          readonly code:
            | 'unreachable'
            | 'auth'
            | 'spawn_failed'
            | 'timeout'
            | 'unknown'
          readonly message: string
        },
  ): void {
    const record = this.byId.get(sessionId)
    if (!record) return
    const prev = record.snapshot
    if (prev.status === 'ok' || prev.status === 'failed') return

    const durationMs = Date.now() - prev.startedAt
    if (final.status === 'ok') {
      record.snapshot = {
        status: 'ok',
        sessionId,
        connectionId: prev.connectionId,
        transport: prev.transport,
        startedAt: prev.startedAt,
        durationMs,
        tools: final.tools,
        rawToolCount: final.rawToolCount,
        serverVersion: final.serverVersion,
      }
    } else {
      record.snapshot = {
        status: 'failed',
        sessionId,
        connectionId: prev.connectionId,
        transport: prev.transport,
        startedAt: prev.startedAt,
        durationMs,
        code: final.code,
        message: final.message,
      }
    }

    clearTimeout(record.expiryTimer)
    record.expiryTimer = this.armTimer(sessionId, TERMINAL_TTL_MS)
    this.drainWaiters(record)

    // Disposer fires after waiters resolve so the HTTP response with
    // the final snapshot goes out first; a slow disposer can't block
    // the client. Errors inside disposer are swallowed (logged to
    // stderr) — teardown failures must never mask the client-
    // observable outcome.
    void Promise.resolve()
      .then(() => record.disposer())
      .catch((err) => {
        console.error(
          `[test-sessions] disposer for session ${sessionId} failed:`,
          err,
        )
      })
  }

  /**
   * Subscribe to the next state change. Resolves immediately if the
   * current snapshot is already different from `ifSameAs` (= the
   * status the caller last observed). For HTTP long-polling, pass
   * the client's last-seen status so the first poll after a state
   * flip resolves without re-suspending.
   *
   * Rejects never: timeouts fall through to the current snapshot.
   */
  waitForChange(
    sessionId: string,
    ifSameAs: TestSessionStatus,
    timeoutMs: number,
  ): Promise<TestSessionSnapshot> {
    const record = this.byId.get(sessionId)
    if (!record) {
      // Session was GC'd — return a synthetic "unknown session" failure
      // so the poll layer can decide how to surface it.
      return Promise.resolve({
        status: 'failed',
        sessionId,
        connectionId: '',
        transport: 'http',
        startedAt: 0,
        durationMs: 0,
        code: 'unknown',
        message: 'test session expired or was never created',
      })
    }

    if (record.snapshot.status !== ifSameAs) {
      return Promise.resolve(record.snapshot)
    }

    return new Promise<TestSessionSnapshot>((resolve) => {
      const timer = setTimeout(() => {
        const idx = record.waiters.indexOf(resolve)
        if (idx >= 0) record.waiters.splice(idx, 1)
        resolve(record.snapshot)
      }, timeoutMs)

      record.waiters.push((snap) => {
        clearTimeout(timer)
        resolve(snap)
      })
    })
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Cancel the existing session for this connection, if any. Flips
   * it to `failed` so any long-pollers get a terminal answer instead
   * of hanging, then removes it from the maps.
   */
  private cancelForConnection(connectionId: string): void {
    const sid = this.byConnection.get(connectionId)
    if (!sid) return
    this.finalize(sid, {
      status: 'failed',
      code: 'unknown',
      message: 'superseded by a newer test session',
    })
    // `finalize` doesn't remove the record; the TTL does. But the
    // connection-level index must release its slot NOW so the
    // new session can register under the same key.
    this.byConnection.delete(connectionId)
  }

  private drainWaiters(record: TestSessionRecord): void {
    const fns = record.waiters
    record.waiters = []
    for (const fn of fns) {
      try {
        fn(record.snapshot)
      } catch (err) {
        console.error('[test-sessions] waiter callback threw:', err)
      }
    }
  }

  private armTimer(sessionId: string, ttlMs: number): NodeJS.Timeout {
    return setTimeout(() => {
      const record = this.byId.get(sessionId)
      if (!record) return

      // Terminal snapshots just get GC'd. Non-terminal snapshots fail
      // with a timeout first so any active poller gets a terminal
      // answer.
      if (
        record.snapshot.status !== 'ok' &&
        record.snapshot.status !== 'failed'
      ) {
        this.finalize(sessionId, {
          status: 'failed',
          code: 'timeout',
          message:
            'test session expired without completing — re-run the Test button',
        })
        // Re-arm so the terminal snapshot hangs around briefly for
        // the final poll to see it.
        return
      }

      this.byId.delete(sessionId)
      if (this.byConnection.get(record.snapshot.connectionId) === sessionId) {
        this.byConnection.delete(record.snapshot.connectionId)
      }
    }, ttlMs)
  }
}

// ─── Process-wide singleton ──────────────────────────────────────────────

let singleton: TestSessionRegistry | null = null

/**
 * Process-scoped registry instance. Deliberate singleton: the
 * callback route, the discover dispatcher, and the poll handler all
 * need the same map, and there's no per-request identity that would
 * motivate separate instances.
 */
export function getTestSessionRegistry(): TestSessionRegistry {
  if (!singleton) singleton = new TestSessionRegistry()
  return singleton
}

/** Test-only — lets unit tests reset state between cases. */
export function __resetTestSessionsForTests(): void {
  singleton = null
}
