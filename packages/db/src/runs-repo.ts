/**
 * Run-table mutation helpers for Phase 3d (`POST /api/agents/:id/runs` +
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
 * Phase 5 bridge MCP runs reuse this helper with a `bridge:<uuid>`
 * prefix; keeping the prefix caller-controlled avoids a second helper.
 */
export async function createRun(
  handle: AgentBridgeDb,
  params: {
    readonly id: string
    readonly agentId: string
    readonly inputPrompt: string
    readonly streamId: string
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

// ─── Mastra thread linkage (Phase 3g) ─────────────────────────────────

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
}

/**
 * Terminal transition `running → completed`. `output_summary` is the
 * model's accumulated `text` output (truncated to something sane at
 * the dispatcher — this helper takes it verbatim). `finished_at`
 * stamps the clock so the UI can render duration.
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
