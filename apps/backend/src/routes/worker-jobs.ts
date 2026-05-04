/**
 * `GET /api/worker-jobs[?repoId=&jobKind=&limit=]` — list worker
 * jobs (clone / index / wiki) across the workspace, newest-first.
 * `GET /api/worker-jobs/:id` — full detail row + every `worker_events`
 * entry for that job, ordered ts ASC.
 *
 * Mirrors `routes/runs.ts` for the agent side. The /logs page reads
 * both shapes and merges them into one chronological feed; the
 * detail sheet reuses the same rendering primitives for events.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  workerJobListQuerySchema,
  type WorkerJobDetailEvent,
  type WorkerJobDetailResponse,
  type WorkerJobKind,
  type WorkerJobListResponse,
  type WorkerJobListRow,
  type WorkerJobStatus,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpValidationError } from '../lib/errors.js'

const DEFAULT_LIMIT = 50

/** Last segment of a clone URL — matches the `repo_label` semantics
 *  used elsewhere in the app for "what humans call this repo." */
function urlTail(remoteUrl: string): string {
  const clean = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const segs = clean.split(/[/:]/).filter((s) => s.length > 0)
  return segs[segs.length - 1] ?? remoteUrl
}

export const workerJobsRouter = new Hono()
  .get(
    '/',
    zValidator('query', workerJobListQuerySchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const q = c.req.valid('query')
      const limit = q.limit ?? DEFAULT_LIMIT
      const handle = getDb()

      const filters = []
      if (q.repoId) filters.push(eq(schema.workerJobs.repoId, q.repoId))
      if (q.jobKind) filters.push(eq(schema.workerJobs.jobKind, q.jobKind))
      const whereClause =
        filters.length === 0
          ? undefined
          : filters.length === 1
            ? filters[0]
            : and(...filters)

      const rows = await handle.db
        .select({
          id: schema.workerJobs.id,
          repoId: schema.workerJobs.repoId,
          jobKind: schema.workerJobs.jobKind,
          status: schema.workerJobs.status,
          startedAt: schema.workerJobs.startedAt,
          finishedAt: schema.workerJobs.finishedAt,
          errorMessage: schema.workerJobs.errorMessage,
          repoRemoteUrl: schema.repos.remoteUrl,
        })
        .from(schema.workerJobs)
        // LEFT JOIN defensively — the FK CASCADE means a deleted
        // repo also drops the job, but the join shape stays valid.
        .leftJoin(
          schema.repos,
          eq(schema.repos.id, schema.workerJobs.repoId),
        )
        .where(whereClause)
        .orderBy(desc(schema.workerJobs.startedAt))
        .limit(limit)

      const out: WorkerJobListRow[] = rows.map((r) => {
        const startedAt = r.startedAt.toISOString()
        const finishedAt = r.finishedAt ? r.finishedAt.toISOString() : null
        const durationMs = r.finishedAt
          ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime())
          : null
        const remoteUrl = r.repoRemoteUrl ?? '<deleted>'
        return {
          id: r.id,
          repoId: r.repoId,
          repoLabel: urlTail(remoteUrl),
          repoRemoteUrl: remoteUrl,
          jobKind: r.jobKind as WorkerJobKind,
          status: r.status as WorkerJobStatus,
          startedAt,
          finishedAt,
          durationMs,
          errorMessage: r.errorMessage,
        }
      })

      const body: WorkerJobListResponse = { ok: true, jobs: out }
      return c.json(body)
    },
  )
  .get(
    '/:id',
    zValidator(
      'param',
      z.object({ id: z.uuid() }),
      (result, c) => {
        if (!result.success) return httpValidationError(c, result.error)
        return
      },
    ),
    async (c) => {
      const { id } = c.req.valid('param')
      const handle = getDb()

      const [row] = await handle.db
        .select({
          id: schema.workerJobs.id,
          repoId: schema.workerJobs.repoId,
          jobKind: schema.workerJobs.jobKind,
          status: schema.workerJobs.status,
          startedAt: schema.workerJobs.startedAt,
          finishedAt: schema.workerJobs.finishedAt,
          errorMessage: schema.workerJobs.errorMessage,
          repoRemoteUrl: schema.repos.remoteUrl,
        })
        .from(schema.workerJobs)
        .leftJoin(
          schema.repos,
          eq(schema.repos.id, schema.workerJobs.repoId),
        )
        .where(eq(schema.workerJobs.id, id))
        .limit(1)

      if (!row) {
        return c.json(
          {
            ok: false as const,
            code: 'not_found' as const,
            message: `Worker job ${id} not found`,
          },
          404,
        )
      }

      const eventRows = await handle.db
        .select({
          id: schema.workerEvents.id,
          ts: schema.workerEvents.ts,
          kind: schema.workerEvents.kind,
          payloadJson: schema.workerEvents.payloadJson,
        })
        .from(schema.workerEvents)
        .where(eq(schema.workerEvents.jobId, id))
        .orderBy(asc(schema.workerEvents.ts), asc(schema.workerEvents.id))

      const startedAt = row.startedAt.toISOString()
      const finishedAt = row.finishedAt ? row.finishedAt.toISOString() : null
      const durationMs = row.finishedAt
        ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime())
        : null
      const remoteUrl = row.repoRemoteUrl ?? '<deleted>'

      const job: WorkerJobListRow = {
        id: row.id,
        repoId: row.repoId,
        repoLabel: urlTail(remoteUrl),
        repoRemoteUrl: remoteUrl,
        jobKind: row.jobKind as WorkerJobKind,
        status: row.status as WorkerJobStatus,
        startedAt,
        finishedAt,
        durationMs,
        errorMessage: row.errorMessage,
      }

      const events: WorkerJobDetailEvent[] = eventRows.map((e) => ({
        // bigserial → string for JSON safety past 2^53.
        id: e.id.toString(),
        ts: e.ts.toISOString(),
        kind: e.kind,
        payload: e.payloadJson,
      }))

      const body: WorkerJobDetailResponse = { ok: true, job, events }
      return c.json(body)
    },
  )

export type WorkerJobsRouter = typeof workerJobsRouter
