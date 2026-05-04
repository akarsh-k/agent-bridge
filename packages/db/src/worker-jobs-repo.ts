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

export type WorkerJobKind = 'clone' | 'index' | 'wiki'
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
