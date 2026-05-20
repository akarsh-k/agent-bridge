/**
 * Worker-job repository. Mirrors `runs-repo` for agent invocations,
 * but for the background jobs the worker process runs against repos
 * (clone / index / wiki). Each call from a worker job:
 *
 *   1. `createWorkerJob({ repoId, jobKind })` → returns the new
 *      `WorkerJobRow`. The job's `id` becomes the FK target for
 *      every `worker_events` row that follows.
 *   2. `appendWorkerEvent({ jobId, kind, payload })` for each
 *      progress / log line. Append-only, never updated.
 *   3. `markWorkerJobFinished(jobId, { status, errorMessage? })` at
 *      the end (status='completed' on success, 'error' on failure,
 *      'aborted' if the user cancelled).
 *
 * The split mirrors `runs` + `run_events`: a single lifecycle row
 * with start/finish timestamps + status, plus an append-only event
 * stream keyed off it. The /logs page reads both via the same
 * shape.
 */

import { eq } from 'drizzle-orm'

import type { AgentBridgeDb } from './client.js'
import {
  workerEvents,
  workerJobs,
  type WorkerEventRow,
  type WorkerJobRow,
} from './schema.js'

export type WorkerJobKind = 'clone' | 'pull' | 'index' | 'wiki'
export type WorkerJobStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface CreateWorkerJobInput {
  readonly repoId: string
  readonly jobKind: WorkerJobKind
}

/**
 * Insert a fresh `worker_jobs` row in `status='running'` state.
 * The DB defaults handle `started_at` and `id`.
 */
export async function createWorkerJob(
  handle: AgentBridgeDb,
  input: CreateWorkerJobInput,
): Promise<WorkerJobRow> {
  const [row] = await handle.db
    .insert(workerJobs)
    .values({
      repoId: input.repoId,
      jobKind: input.jobKind,
    })
    .returning()
  if (!row) {
    throw new Error('createWorkerJob: insert returned no rows')
  }
  return row
}

export interface AppendWorkerEventInput {
  readonly jobId: string
  readonly kind: string
  readonly payload?: unknown
  /** Optional. defaults to `now()` via the column. Pass when replaying
   *  events with a specific timestamp (e.g. backfill from logs). */
  readonly ts?: Date
}

/**
 * Append one event row. Errors propagate so callers can decide
 * whether a failed audit is fatal or best-effort. The worker's
 * `publishAndAudit` wrapper logs+swallows so live SSE keeps flowing
 * even when the DB write fails — same pattern the agent dispatcher
 * uses.
 */
export async function appendWorkerEvent(
  handle: AgentBridgeDb,
  input: AppendWorkerEventInput,
): Promise<WorkerEventRow> {
  const [row] = await handle.db
    .insert(workerEvents)
    .values({
      jobId: input.jobId,
      kind: input.kind,
      payloadJson: (input.payload ?? null) as Record<string, unknown> | null,
      ...(input.ts ? { ts: input.ts } : {}),
    })
    .returning()
  if (!row) {
    throw new Error('appendWorkerEvent: insert returned no rows')
  }
  return row
}

export interface MarkWorkerJobFinishedInput {
  readonly status: Exclude<WorkerJobStatus, 'running'>
  readonly errorMessage?: string | null
}

/**
 * Boot-time reaper. Marks every `worker_jobs` row currently in
 * `status='running'` as `aborted` with a stamped `finished_at` and
 * a clear `error_message`. Called by the worker process at startup
 * so a previous crash doesn't leave the table littered with stale
 * "still running" rows. Returns the number of rows touched so the
 * caller can log it on boot.
 *
 * Safe to call concurrently with a freshly-booted worker that has
 * not yet created any new job rows: the worker creates new rows
 * AFTER passing the status check in the handler, so the reaper's
 * blanket `status='running'` update can't race a freshly-inserted
 * row from this process. If you ever fan out to multiple workers
 * sharing a queue, switch this to a watchdog pattern (last_heartbeat
 * column + reap older than N minutes).
 */
export async function reapStaleRunningJobs(
  handle: AgentBridgeDb,
): Promise<number> {
  const rows = await handle.db
    .update(workerJobs)
    .set({
      status: 'aborted',
      finishedAt: new Date(),
      errorMessage: 'worker restart while job was running',
    })
    .where(eq(workerJobs.status, 'running'))
    .returning({ id: workerJobs.id })
  return rows.length
}

/**
 * Set `status` + `finished_at` (= now). No-op on `running` since a
 * still-running job shouldn't be finalised. Returns the updated row
 * for the caller's logging convenience.
 */
export async function markWorkerJobFinished(
  handle: AgentBridgeDb,
  jobId: string,
  input: MarkWorkerJobFinishedInput,
): Promise<WorkerJobRow | null> {
  const [row] = await handle.db
    .update(workerJobs)
    .set({
      status: input.status,
      finishedAt: new Date(),
      errorMessage: input.errorMessage ?? null,
    })
    .where(eq(workerJobs.id, jobId))
    .returning()
  return row ?? null
}
