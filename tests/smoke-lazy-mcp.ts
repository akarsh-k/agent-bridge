/**
 * Lazy-MCP contract smoke. Pure — no real MCP subprocess, no model, no
 * network, no OAuth. Uses the test seams in `external-mcps.ts` (an injectable
 * `LazyConnectionOpener` + a `LazyToolsetSource` the proxy tool talks to) to
 * lock the lazy guarantees that the whole feature rests on:
 *
 *   - Building a proxy tool opens NO connection (the model seeing the tool
 *     costs nothing).
 *   - Invoking the proxy opens the connection exactly once, then caches it.
 *   - An expired (OAuth) connection surfaces `run.mcp.authorize_required`
 *     ONLY when the tool is actually invoked — never at build time and never
 *     for a turn that doesn't call it. (This is the "no Reconnect button
 *     unless the model decides to call it" property; the model's decision is
 *     stood in for here by calling `execute` directly.)
 *   - The proxy returns a friendly result on auth failure instead of crashing
 *     the run.
 *   - The manager classifies a failed open as auth-required for OAuth
 *     connections and as a generic error otherwise.
 *
 * The real-model end-to-end (the model actually deciding to call the tool) is
 * `packages/agents/scripts/smoke-lazy-mcp` — that one needs a provider.
 *
 * Run from repo root:
 *   pnpm test:lazy-mcp
 */

/* eslint-disable no-console */

import {
  buildLazyTool,
  LazyMcpConnections,
  ExternalMcpAuthRequiredError,
  type LazyToolsetSource,
  type LazyConnectionOpener,
} from '../packages/agents/src/mcp/external-mcps.js'
import { runWithInspectorContext } from '../packages/agents/src/inspector/run-context.js'

import type { ConnectionToolSchema } from '@agent-bridge/db'
import type { RunEvent } from '@agent-bridge/shared'

// ─── harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(`${name}${diag ? ` — ${diag}` : ''}`)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

console.log('━'.repeat(60))
console.log(' Lazy-MCP contract smoke')
console.log('━'.repeat(60))

// ─── helpers ──────────────────────────────────────────────────────────────

const STORED: ConnectionToolSchema = {
  name: 'search',
  description: 'search the workspace',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  },
}

/** A fake upstream tool that echoes its input — stands in for the real MCP
 *  tool the proxy delegates to. */
const fakeUpstreamTool = {
  execute: async (input: unknown) => ({ echoed: input }),
} as any

/** LazyMcpConnections needs a LogBroker for its default opener, but we always
 *  inject our own opener so the broker is never touched. */
const noBroker = undefined as unknown as ConstructorParameters<
  typeof LazyMcpConnections
>[1]

/** Capture emitted run events by running inside a fake inspector context whose
 *  eventBus records publishes. A chainable no-op db lets the audit insert
 *  resolve silently (the real one persists to `run_events`). */
function withCapturedEvents(): {
  captured: RunEvent[]
  ctx: Parameters<typeof runWithInspectorContext>[0]
} {
  const captured: RunEvent[] = []
  const okQuery: any = {
    values: () => okQuery,
    returning: () => okQuery,
    onConflictDoNothing: () => okQuery,
    then: (resolve: (v: unknown) => void) => resolve([{}]),
  }
  const ctx = {
    db: { db: { insert: () => okQuery } } as unknown,
    eventBus: {
      publish: async (e: RunEvent) => {
        captured.push(e)
      },
    },
    redactor: { redactEvent: (e: RunEvent) => e },
    runId: 'run-1',
    streamId: 'run:run-1',
    agentStreamId: 'agent:agent-1',
    agentId: 'agent-1',
    idePreResolvedRepo: null,
  } as unknown as Parameters<typeof runWithInspectorContext>[0]
  return { captured, ctx }
}

// ─── tests ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. A proxy tool built from a stored schema opens NO connection, and
  //    invoking it opens exactly once and delegates to the upstream tool.
  {
    let getToolsetCalls = 0
    const source: LazyToolsetSource = {
      getToolset: async () => {
        getToolsetCalls += 1
        return { search: fakeUpstreamTool }
      },
    }
    const tool = buildLazyTool({
      slug: 'notion',
      connectionId: 'c1',
      connectionName: 'Notion',
      rawName: 'search',
      stored: STORED,
      manager: source,
    })

    check(
      'building a proxy tool opens no connection',
      getToolsetCalls === 0,
      `getToolset calls=${getToolsetCalls}`,
    )

    const res = await tool.execute!({ q: 'hi' }, {} as never)
    check(
      'invoking the proxy opens the connection',
      getToolsetCalls === 1,
      `getToolset calls=${getToolsetCalls}`,
    )
    check(
      'the proxy delegates to the upstream tool',
      JSON.stringify(res) === JSON.stringify({ echoed: { q: 'hi' } }),
      JSON.stringify(res),
    )
  }

  // 2. Expired (OAuth) connection: the auth event fires ONLY when the tool is
  //    invoked, never at build / when not called, and the proxy returns a
  //    friendly result instead of throwing.
  {
    const authSource: LazyToolsetSource = {
      getToolset: async () => {
        throw new ExternalMcpAuthRequiredError({
          connectionId: 'c1',
          connectionName: 'Notion',
          message: 'session expired',
        })
      },
    }
    const tool = buildLazyTool({
      slug: 'notion',
      connectionId: 'c1',
      connectionName: 'Notion',
      rawName: 'search',
      stored: STORED,
      manager: authSource,
    })

    const a = withCapturedEvents()
    // Build + DON'T invoke → no event (the "no button unless called" case).
    check(
      'no auth event when the tool is never invoked',
      a.captured.length === 0,
      `events=${a.captured.length}`,
    )

    // Invoke inside a run context → emits the event + returns a friendly result.
    const res = await runWithInspectorContext(a.ctx, () =>
      tool.execute!({ q: 'x' }, {} as never),
    )
    const authEvents = a.captured.filter(
      (e) => e.kind === 'run.mcp.authorize_required',
    )
    check(
      'invoking an expired connection emits run.mcp.authorize_required',
      authEvents.length >= 1,
      `authEvents=${authEvents.length}`,
    )
    const data = authEvents[0]?.data as
      | { connectionId?: string; connectionName?: string }
      | undefined
    check(
      'the event carries the connection id + name',
      data?.connectionId === 'c1' && data?.connectionName === 'Notion',
      JSON.stringify(data),
    )
    check(
      'the proxy returns a friendly authorize_required result (no throw)',
      (res as { status?: string } | undefined)?.status === 'authorize_required',
      JSON.stringify(res),
    )
  }

  // 3. The manager opens once and caches across calls; teardown runs.
  {
    let opens = 0
    let disconnects = 0
    const opener: LazyConnectionOpener = async () => {
      opens += 1
      return {
        toolset: { search: fakeUpstreamTool },
        disconnect: async () => {
          disconnects += 1
        },
      }
    }
    const mgr = new LazyMcpConnections('agent-1', noBroker, opener)
    mgr.register({
      connectionId: 'c1',
      connectionName: 'Notion',
      transport: 'sse',
      authKind: 'oauth',
      serverDef: {} as never,
    })

    const t1 = await mgr.getToolset('c1')
    const t2 = await mgr.getToolset('c1')
    check(
      'getToolset opens once and caches across calls',
      opens === 1,
      `opens=${opens}`,
    )
    check('cached toolset is reused', t1 === t2 && 'search' in t1)

    await mgr.disconnectClients()
    check(
      'disconnectClients runs the per-connection teardown',
      disconnects === 1,
    )
  }

  // 4. A failed open is classified: auth-required for OAuth, generic otherwise.
  {
    const failOpener: LazyConnectionOpener = async () => {
      throw new Error('listToolsets failed')
    }

    const oauthMgr = new LazyMcpConnections('agent-1', noBroker, failOpener)
    oauthMgr.register({
      connectionId: 'c2',
      connectionName: 'Notion',
      transport: 'sse',
      authKind: 'oauth',
      serverDef: {} as never,
    })
    let oauthErr: unknown = null
    try {
      await oauthMgr.getToolset('c2')
    } catch (e) {
      oauthErr = e
    }
    check(
      'OAuth open failure classifies as ExternalMcpAuthRequiredError',
      oauthErr instanceof ExternalMcpAuthRequiredError,
      String(oauthErr),
    )

    const stdioMgr = new LazyMcpConnections('agent-1', noBroker, failOpener)
    stdioMgr.register({
      connectionId: 'c3',
      connectionName: 'Local',
      transport: 'stdio',
      authKind: 'none',
      serverDef: {} as never,
    })
    let stdioErr: unknown = null
    try {
      await stdioMgr.getToolset('c3')
    } catch (e) {
      stdioErr = e
    }
    check(
      'non-OAuth open failure stays a generic error (not auth-required)',
      stdioErr instanceof Error &&
        !(stdioErr instanceof ExternalMcpAuthRequiredError),
      String(stdioErr),
    )
  }

  // 5. An OAuth connection that opens but advertises ZERO tools is treated as
  //    auth-required (an expired session that hides its tools, not an empty
  //    server) and the client is disconnected. A non-OAuth empty open is NOT
  //    reclassified — it returns the empty toolset and the proxy surfaces the
  //    generic "no longer advertises" error instead.
  {
    let emptyDisconnects = 0
    const emptyOauthOpener: LazyConnectionOpener = async () => ({
      toolset: {},
      disconnect: async () => {
        emptyDisconnects += 1
      },
    })
    const emptyOauthMgr = new LazyMcpConnections(
      'agent-1',
      noBroker,
      emptyOauthOpener,
    )
    emptyOauthMgr.register({
      connectionId: 'c4',
      connectionName: 'Notion',
      transport: 'sse',
      authKind: 'oauth',
      serverDef: {} as never,
    })
    let emptyOauthErr: unknown = null
    try {
      await emptyOauthMgr.getToolset('c4')
    } catch (e) {
      emptyOauthErr = e
    }
    check(
      'OAuth connection that advertises zero tools classifies as auth-required',
      emptyOauthErr instanceof ExternalMcpAuthRequiredError,
      String(emptyOauthErr),
    )
    check(
      'the zero-tools OAuth open disconnects the client it opened',
      emptyDisconnects === 1,
      `disconnects=${emptyDisconnects}`,
    )

    const emptyNoneOpener: LazyConnectionOpener = async () => ({
      toolset: {},
      disconnect: async () => {},
    })
    const emptyNoneMgr = new LazyMcpConnections(
      'agent-1',
      noBroker,
      emptyNoneOpener,
    )
    emptyNoneMgr.register({
      connectionId: 'c5',
      connectionName: 'Local',
      transport: 'stdio',
      authKind: 'none',
      serverDef: {} as never,
    })
    let emptyNoneToolset: Record<string, unknown> | null = null
    let emptyNoneErr: unknown = null
    try {
      emptyNoneToolset = await emptyNoneMgr.getToolset('c5')
    } catch (e) {
      emptyNoneErr = e
    }
    check(
      'non-OAuth connection with zero tools is NOT reclassified as auth-required',
      emptyNoneErr === null &&
        emptyNoneToolset !== null &&
        Object.keys(emptyNoneToolset).length === 0,
      `err=${String(emptyNoneErr)} toolset=${JSON.stringify(emptyNoneToolset)}`,
    )
  }

  // 6. The per-call timeout fires. A tool whose connection open never resolves
  //    must NOT hang the step: within the (injected, tiny) timeout it resolves
  //    with an error RESULT so the run can finish and `maxSteps` can bound it.
  //    Guards `withMcpCallTimeout` — the entire hang protection for MCP calls.
  {
    const neverResolves: LazyToolsetSource = {
      getToolset: () =>
        new Promise<never>(() => {
          /* never settles — simulates a hung MCP server */
        }),
    }
    const tool = buildLazyTool({
      slug: 'slow',
      connectionId: 'c1',
      connectionName: 'SlowMcp',
      rawName: 'hang',
      stored: STORED,
      manager: neverResolves,
      timeoutMs: 50,
    })
    const start = Date.now()
    const res = (await tool.execute!({ q: 'x' }, {} as never)) as {
      status?: string
    }
    const elapsed = Date.now() - start
    check(
      'a hung tool call times out with an error result (does not hang)',
      res?.status === 'error',
      `status=${res?.status}`,
    )
    check(
      'the timeout fires near the injected 50ms, not the 60s default',
      elapsed < 2_000,
      `elapsed=${elapsed}ms`,
    )
  }

  // ─── summary ───────────────────────────────────────────────────────────────
  console.log('━'.repeat(60))
  console.log(` Passed: ${passed}/${passed + failed}`)
  if (failed > 0) {
    console.log(' Failed:')
    for (const f of failures) console.log(`   ✗ ${f}`)
    console.log('━'.repeat(60))
    process.exitCode = 1
  } else {
    console.log(' All checks passed.')
    console.log('━'.repeat(60))
  }
}

main().catch((err) => {
  console.error('[lazy-mcp-smoke] fatal:', err)
  process.exit(1)
})
