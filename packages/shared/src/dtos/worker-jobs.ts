/**
 * Worker-job DTOs. Mirrors `runs.ts` for the agent side, but for
 * the background jobs the worker process runs against repos
 * (clone / index / wiki). Two surfaces:
 *
 *   - List: `GET /api/worker-jobs` returns recent jobs across all
 *     repos. Powers the /logs page's worker-job rows.
 *   - Detail: `GET /api/worker-jobs/:id` returns one job + every
 *     row from `worker_events` for that job. Powers the right-slide
 *     detail sheet — same shape as `runDetailResponseSchema`, just
 *     keyed by the worker job id.
 */

import { z } from 'zod'

/** Statuses a worker_jobs row can be in. Mirrors the workerJobsRepo
 *  type. `running` is the initial state; the others are terminal. */
export const workerJobStatuses = [
  'running',
  'completed',
  'error',
  'aborted',
] as const
export type WorkerJobStatus = (typeof workerJobStatuses)[number]

/** Job kind — which worker entrypoint produced it. */
export const workerJobKinds = ['clone', 'index', 'wiki'] as const
export type WorkerJobKind = (typeof workerJobKinds)[number]

export const workerJobListRowSchema = z.object({
  id: z.uuid(),
  repoId: z.uuid(),
  /** Joined from `repos`. Defensive fallback when the repo was
   *  deleted (FK CASCADE means we never actually see this in
   *  practice; kept for shape stability). */
  repoLabel: z.string(),
  repoRemoteUrl: z.string(),
  jobKind: z.enum(workerJobKinds),
  status: z.enum(workerJobStatuses),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
})
export type WorkerJobListRow = z.infer<typeof workerJobListRowSchema>

export const workerJobListQuerySchema = z
  .object({
    /** Cap at 100 to keep the response bounded; default 50. */
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** Filter to one repo's history. */
    repoId: z.uuid().optional(),
    /** Filter to one job kind (clone/index/wiki). */
    jobKind: z.enum(workerJobKinds).optional(),
  })
  .strict()
export type WorkerJobListQuery = z.infer<typeof workerJobListQuerySchema>

export const workerJobListResponseSchema = z.object({
  ok: z.literal(true),
  jobs: z.array(workerJobListRowSchema),
})
export type WorkerJobListResponse = z.infer<typeof workerJobListResponseSchema>

/** Detail row — same fields as the list row plus stream events. */
export const workerJobDetailEventSchema = z.object({
  /** `bigserial` stringified — `Number` precision tops out at 2^53. */
  id: z.string(),
  ts: z.iso.datetime(),
  kind: z.string(),
  payload: z.unknown().nullable(),
})
export type WorkerJobDetailEvent = z.infer<typeof workerJobDetailEventSchema>

export const workerJobDetailResponseSchema = z.object({
  ok: z.literal(true),
  job: workerJobListRowSchema,
  events: z.array(workerJobDetailEventSchema),
})
export type WorkerJobDetailResponse = z.infer<typeof workerJobDetailResponseSchema>
