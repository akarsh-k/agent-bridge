/**
 * Run-table mutation helpers (`POST /api/agents/:id/runs` +
 * SSE event bus). Same pattern as `repos-repo.ts`: every status
 * transition lives behind a single function so the invariants
 * (setting `started_at` exactly once, writing `finished_at` only on
 * terminal states, clearing `error_message` on success) can't silently
 * drift between the HTTP edge and the stream dispatcher.
 *
 * Status lifecycle:
 *
 *   pending ─► running ─┬─► completed
 *                       └─► error
 *
 * Authority split:
 *   - `createRun`          — called by the HTTP handler inside the POST.
 *                            Row lands in `pending`; the handler returns
 *                            202 immediately.
 *   - `markRunning`        — called by the dispatcher right before the
 *                            first Mastra chunk is consumed. Also emits
 *                            the `run.started` SSE frame.
 *   - `markCompleted`      — called by the dispatcher on a clean finish.
 *                            Stamps `finished_at = now()`.
 *   - `markError`          — called by the dispatcher on any failure.
 *                            Also stamps `finished_at` so the UI has a
 *                            consistent "duration" field.
 *   - `appendEvent`        — bulk insert into `run_events`. Tokens use
 *                            the batched `run.token.batch` kind; every
 *                            other `run.*` event lands as one row.
 *
 * All of these accept the shared `AgentBridgeDb` handle so the backend
 * and (future) worker / CLI callers share a pool.
 *
 * Node-only.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Callsite } from '@agent-bridge/shared'
import type { AgentBridgeDb } from './client.js'
import { runEvents, runs, type RunEventRow, type RunRow } from './schema.js'

// ─── creation ────────────────────────────────────────────────────────────

/**
 * Insert a new `runs` row in `pending` state. Caller supplies BOTH the
 * primary key (`id`) and the `streamId` so they can satisfy the
 * `runs.stream_id` NOT NULL + UNIQUE constraint in a single INSERT
 * — no two-step "insert then UPDATE stream_id" dance.
 *
 * Why caller-owned UUIDs here (vs DB-default `gen_random_uuid()`
 * everywhere else)? Because `stream_id = 'run:' + id` is a derived
 * invariant we want enforced at insert time, and Drizzle can't
 * reference a column's own DEFAULT-generated value inside the same
 * INSERT's other columns. Generating the UUID in JS with
 * `crypto.randomUUID()` (same underlying algo as Postgres's
 * `gen_random_uuid()`; collision probability is indistinguishable
 * from zero) lets both values be written atomically.
 *
 * Bridge MCP runs reuse this helper with a `bridge:<uuid>`
 * prefix; keeping the prefix caller-controlled avoids a second helper.
 */
/**
 * Fetch a run row by id. Used by the MCP bridge after
 * `dispatchRun` resolves: the dispatcher writes the final accumulated
 * text to `runs.output_summary`, and the bridge surfaces that as the
 * MCP tool's text content. Returns `null` when the row was deleted
 * mid-flight (which the bridge treats as an internal error).
 */
export async function getRun(
  handle: AgentBridgeDb,
  runId: string,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return row ?? null
}

export async function createRun(
  handle: AgentBridgeDb,
  params: {
    readonly id: string
    readonly agentId: string
    readonly inputPrompt: string
    readonly streamId: string
    /**
     * Bridge tool name when this run was started by
     * `apps/mcp-bridge` AND the agent had ≥1 explicit `bridge_tools`
     * row. 1:1 default and UI-chat runs leave this null.
     */
    readonly bridgeToolName?: string | null
    /**
     * Always-on per-run provenance (`client + agent + tool + repo? +
     * cursor? + started_at`). Bridge handlers stamp the captured IDE
     * clientInfo + tool args; the chat backend synthesises the
     * `web-chat` shape. Persisted on `runs.callsite_json` so /logs can
     * render a per-row badge AND so the dispatcher can prepend a
     * `_Request origin: …_` metadata line to the prompt.
     */
    readonly callsite?: Callsite | null
  },
): Promise<RunRow> {
  const [row] = await handle.db
    .insert(runs)
    .values({
      id: params.id,
      agentId: params.agentId,
      streamId: params.streamId,
      inputPrompt: params.inputPrompt,
      status: 'pending',
      ...(params.bridgeToolName !== undefined
        ? { bridgeToolName: params.bridgeToolName }
        : {}),
      ...(params.callsite !== undefined
        ? { callsiteJson: params.callsite }
        : {}),
    })
    .returning()

  if (!row) {
    // INSERT ... RETURNING never returns zero rows on success; if it
    // does, our assumptions about the DB are broken and there's no
    // safe fallback. Bail loudly.
    throw new Error('createRun: insert returned no rows')
  }

  return row
}

// ─── Mastra thread linkage ─────────────────────────────────

export interface SetMastraThreadInput {
  readonly mastraThreadId: string
  readonly mastraResourceId: string
}

/**
 * Stamp the Mastra-side thread + resource ids that this run is talking
 * to. Called by the dispatcher once per run, right after `buildAgent`
 * resolves memory config and before `markRunning` flips status out of
 * `pending`. A no-op for memory-disabled agents (dispatcher never
 * calls it).
 *
 * Idempotent by runId — a retry writes the same row shape. Restricted
 * to `status IN ('pending','running')` so a duplicate dispatch can't
 * rewrite the thread link of a run that already terminated. Returns
 * the updated row or `null` if the guard didn't match (caller logs;
 * we don't throw since a lost CAS here is informational, not fatal).
 *
 * We do NOT clear these columns on terminal transitions. Even after
 * `error` / `completed`, the link stays so chat replay + history
 * joins work: `SELECT ... FROM runs WHERE mastra_thread_id = $1
 * ORDER BY started_at DESC` is the canonical "give me this thread's
 * run history" query.
 */
export async function setMastraThread(
  handle: AgentBridgeDb,
  runId: string,
  input: SetMastraThreadInput,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .update(runs)
    .set({
      mastraThreadId: input.mastraThreadId,
      mastraResourceId: input.mastraResourceId,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(runs.id, runId), inArray(runs.status, ['pending', 'running'])),
    )
    .returning()
  return row ?? null
}

// ─── status transitions ─────────────────────────────────────────────────

/**
 * CAS flip `pending → running`. Uses WHERE-on-status so a duplicate
 * call (e.g. the dispatcher retried a transient setup error) can't
 * trample a row that already advanced past this state.
 *
 * Does NOT touch `started_at` — that column defaults to `now()` at
 * insert, matching the "run started when the HTTP handler created it"
 * semantic. If we later want "started = when Mastra actually streamed
 * the first token", we can add a nullable `runningAt` column without
 * breaking existing callers.
 *
 * Returns the updated row or `null` if the CAS lost.
 */
export async function markRunning(
  handle: AgentBridgeDb,
  runId: string,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .update(runs)
    .set({
      status: 'running',
      updatedAt: sql`now()`,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'pending')))
    .returning()
  return row ?? null
}

export interface MarkCompletedInput {
  readonly outputSummary: string
  /**
   * Token accounting from the LLM provider's `usage` field. Optional
   * because (a) errored runs may not get one, (b) some local
   * OpenAI-compatible servers don't echo usage. Both columns are
   * nullable on the `runs` table; pass `undefined` to leave them
   * NULL rather than zeroing them.
   */
  readonly promptTokens?: number
  readonly completionTokens?: number
}

/**
 * Terminal transition `running → completed`. `output_summary` is the
 * model's accumulated `text` output (truncated to something sane at
 * the dispatcher — this helper takes it verbatim). `finished_at`
 * stamps the clock so the UI can render duration. Token columns get
 * stamped when the LLM provider returned a `usage` object.
 *
 * Dispatcher-only (HTTP edge must never write these columns). No CAS
 * beyond `status='running'` — the dispatcher is the sole owner after
 * `markRunning` lands.
 */
export async function markCompleted(
  handle: AgentBridgeDb,
  runId: string,
  input: MarkCompletedInput,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .update(runs)
    .set({
      status: 'completed',
      outputSummary: input.outputSummary,
      errorMessage: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(input.promptTokens !== undefined
        ? { promptTokens: input.promptTokens }
        : {}),
      ...(input.completionTokens !== undefined
        ? { completionTokens: input.completionTokens }
        : {}),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
    .returning()
  return row ?? null
}

export interface MarkErrorInput {
  /** Redacted error message. Do NOT pass raw provider responses here. */
  readonly errorMessage: string
}

/**
 * Terminal transition `{pending | running} → error`. Covers both the
 * "dispatcher blew up before streaming" and "LLM errored mid-stream"
 * cases with the same column. `output_summary` is preserved if the run
 * had already produced text before failing (lets the UI show the
 * partial answer alongside the error banner).
 */
export async function markError(
  handle: AgentBridgeDb,
  runId: string,
  input: MarkErrorInput,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .update(runs)
    .set({
      status: 'error',
      errorMessage: input.errorMessage,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['pending', 'running'])))
    .returning()
  return row ?? null
}

// ─── event audit ────────────────────────────────────────────────────────

export interface AppendEventInput {
  readonly runId: string
  readonly kind: string
  readonly payload: unknown
  /**
   * Override the event timestamp. Defaults to `now()` (server clock).
   * The dispatcher passes the millisecond timestamp it derived for the
   * SSE frame so the audit row and the live frame are identical.
   */
  readonly ts?: Date
}

/**
 * Append one row to `run_events`. `run_events` is append-only by
 * design (no UPDATE, no DELETE) — our callers never correct an
 * already-written event. Corrupted events stay in the log with their
 * original kind so forensic replay is always truthful.
 */
export async function appendEvent(
  handle: AgentBridgeDb,
  input: AppendEventInput,
): Promise<RunEventRow> {
  const [row] = await handle.db
    .insert(runEvents)
    .values({
      runId: input.runId,
      kind: input.kind,
      payloadJson: input.payload as Record<string, unknown> | null,
      // Drizzle's timestamp type accepts `Date`; undefined means "use
      // the column default (now())".
      ...(input.ts ? { ts: input.ts } : {}),
    })
    .returning()

  if (!row) {
    throw new Error('appendEvent: insert returned no rows')
  }
  return row
}

/**
 * Append one codebase inspection report to
 * `runs.codebase_inspection_reports_json` (`docs/ARCHITECTURE.md §10`
 * Phase G G3) and re-pack the bundle. The column stores a JSON array;
 * each inspector wrapper invocation contributes one element. The IDE
 * bridge reads the array verbatim under D17's
 * `codebase_inspection_reports[]` field; the chat tab renders each
 * element as an inline tool-call card.
 *
 * `pack` receives `[...existing, report]` and returns the array to
 * persist — it owns the budget + eviction policy (see `packReportBundle`
 * in the agents package, which keeps the highest-confidence reports full
 * and summarizes or drops the weakest to fit a token budget). This layer stays
 * agnostic of the report shape; its only job is to make the
 * read-pack-write atomic.
 *
 * CRITICAL: the SELECT takes a `FOR UPDATE` row lock so concurrent
 * transactions on the same run row serialise instead of racing. The LLM
 * routinely fires multiple wrapper tool calls in parallel within a
 * single step (Mastra's `Promise.all` over tools); each completes its
 * wrapper, each calls this against the SAME `runs.id`. Without the row
 * lock, both transactions read the SAME prior array, each appends its
 * own report, and the second commit clobbers the first — one report
 * silently lost, IDE sees an incomplete evidence set. The lock turns
 * concurrent appends into a queue: T2 blocks on SELECT until T1 commits,
 * then reads the post-T1 array and appends correctly.
 *
 * Returns the stored array length, or null when the run row is gone.
 * The telemetry caller wraps this in try/catch so a failed append never
 * takes down a wrapper's main result path.
 */
export async function appendCodebaseInspectionReport(
  handle: AgentBridgeDb,
  runId: string,
  report: unknown,
  pack: (reports: readonly unknown[]) => readonly unknown[],
): Promise<number | null> {
  return handle.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        codebaseInspectionReportsJson: runs.codebaseInspectionReportsJson,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for('update')
    if (!row) return null

    const current = Array.isArray(row.codebaseInspectionReportsJson)
      ? (row.codebaseInspectionReportsJson as unknown[])
      : []
    const next = pack([...current, report])

    await tx
      .update(runs)
      .set({ codebaseInspectionReportsJson: next as unknown[] })
      .where(eq(runs.id, runId))

    return next.length
  })
}

// ─── reads (used by the HTTP POST pre-flight) ───────────────────────────

/**
 * Look up a run by id. Used by the POST handler to return a consistent
 * 404 when the runId in the URL doesn't exist, and by the (future)
 * history/replay endpoint.
 */
export async function getById(
  handle: AgentBridgeDb,
  runId: string,
): Promise<RunRow | null> {
  const [row] = await handle.db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return row ?? null
}

/**
 * Find the most recent non-terminal run for a given Mastra thread,
 * scoped to the agent. Used by the chat tab on mount: if the user
 * navigated away mid-stream and comes back, this returns the in-flight
 * run so the hook can re-subscribe to its SSE stream. Returns `null`
 * when no run is pending/running (the common case — past completed
 * runs don't need reconnection).
 *
 * Why scope by agentId too: defense-in-depth. `mastra_thread_id` is
 * UUID-shaped and unique in practice, but the index lookup is cheap and
 * the agent scope means a thread-id leak couldn't surface another
 * agent's run to a malicious caller.
 *
 * Uses the `runs_thread_started_idx` partial index
 * (`(mastra_thread_id, started_at) WHERE mastra_thread_id IS NOT NULL`)
 * for the descending lookup.
 */
export interface ActiveRunForThread {
  readonly runId: string
  readonly streamId: string
  readonly status: 'pending' | 'running'
  /**
   * Raw user prompt the dispatcher recorded for this run. Returned
   * alongside the run id so the chat UI can reconstruct the user
   * bubble when Mastra hasn't yet persisted the message to its
   * thread/messages store. That window is small but very real: Mastra
   * batches message writes around the stream's `finish` chunk, so a
   * user who hits send and navigates away within ~1s sees the chat
   * vanish entirely on return without this fallback. The dispatcher
   * may prepend a `_Request origin: ..._` callsite block to the
   * prompt; consumers should strip that before rendering if a clean
   * user message is preferred.
   */
  readonly inputPrompt: string
  /** Run's `started_at` timestamp (ISO8601). Used to position the user
   *  bubble's `createdAt` so the chat sort stays stable across the
   *  resume boundary. */
  readonly startedAt: string
}

export async function findActiveForThread(
  handle: AgentBridgeDb,
  agentId: string,
  mastraThreadId: string,
): Promise<ActiveRunForThread | null> {
  const [row] = await handle.db
    .select({
      id: runs.id,
      streamId: runs.streamId,
      status: runs.status,
      inputPrompt: runs.inputPrompt,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.agentId, agentId),
        eq(runs.mastraThreadId, mastraThreadId),
        inArray(runs.status, ['pending', 'running']),
      ),
    )
    .orderBy(sql`${runs.startedAt} desc`)
    .limit(1)
  if (!row) return null
  // `status` on the row is the broader `RunStatus` union; narrow it
  // here since the WHERE clause guarantees it's pending|running. The
  // cast is structurally safe — the SQL filter is authoritative.
  return {
    runId: row.id,
    streamId: row.streamId,
    status: row.status as 'pending' | 'running',
    inputPrompt: row.inputPrompt,
    startedAt: row.startedAt.toISOString(),
  }
}
