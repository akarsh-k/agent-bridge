/**
 * `/api/repos/:id/{clone|index}` — enqueue sandboxed clone + index jobs.
 *
 * Contract:
 *   POST /api/repos/:id/clone
 *     202 { ok: true, jobId, streamId: 'repo:<uuid>' }
 *       → row flipped from pending|cloned|ready|error → cloning. Worker
 *         handles the transition plus auto-chains into `indexRepo` on
 *         success (see apps/worker/src/jobs/clone-repo.ts).
 *     404                              — repo not found
 *     409 { ok: false }                — row already cloning/indexing;
 *                                        worker is the sole owner and a
 *                                        duplicate job would race.
 *
 *   POST /api/repos/:id/index
 *     202 { ok: true, jobId, streamId: 'repo:<uuid>' }
 *       → manual re-index. Row flipped `cloned|ready|error → indexing`.
 *         Requires a successful clone first (cloned/ready/error
 *         means `source/` exists on disk; ready/error means a prior
 *         index ran).
 *     404                              — repo not found
 *     409                              — row in a state that can't
 *                                        transition to indexing (e.g.
 *                                        pending/cloning/indexing itself).
 *
 * Status authority split mirrors the clone route: the HTTP layer CAS-flips
 * exactly one intermediate state (`cloning` or `indexing`) via the helpers
 * in `@agent-bridge/db`; every terminal transition (`cloned`/`ready`/
 * `error`) belongs to the worker.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { repoIdParamSchema, repoStreamId } from '@agent-bridge/shared'
import { reposRepo } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { enqueueCloneRepo, enqueueIndexRepo } from '../lib/queues.js'

export const repoJobsRouter = new Hono().post(
  '/:id/clone',
  zValidator('param', repoIdParamSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const handle = getDb()

    // Read first so we can distinguish 404 from 409 cleanly, and give
    // the user a message that names the actual blocker. The CAS in
    // `markCloning` also rejects these, but its error channel is a
    // single "transitioned out from under us" bucket — useless for
    // telling apart "already cloning" from "indexing is holding the
    // source tree" from a real TOCTOU race.
    const row = await reposRepo.getForWorker(handle, id)
    if (!row) {
      return httpError(c, {
        code: 'not_found',
        message: `repo ${id} not found`,
      })
    }
    if (row.status === 'cloning') {
      return httpError(c, {
        code: 'conflict',
        message: `repo ${id} is already cloning`,
      })
    }
    if (row.status === 'indexing') {
      return httpError(c, {
        code: 'conflict',
        message:
          `repo ${id} is indexing; wait for the analyze pass to finish ` +
          `before re-cloning`,
      })
    }

    // CAS flip. Any concurrent request loses here — the second call sees
    // `null` because the WHERE clause filters on the old status. The UI's
    // own double-click guard handles the common case; this is defence in
    // depth against a stale browser tab retrying mid-clone.
    const updated = await reposRepo.markCloning(handle, id)
    if (!updated) {
      return httpError(c, {
        code: 'conflict',
        message: `repo ${id} transitioned out from under us; retry`,
      })
    }

    try {
      const { jobId } = await enqueueCloneRepo({
        repoId: updated.id,
        remoteUrl: updated.remoteUrl,
        branch: updated.branch,
        hasPat: Boolean(updated.gitPatEnvelope),
      })
      return c.json(
        {
          ok: true as const,
          jobId,
          streamId: repoStreamId(updated.id),
        },
        202,
      )
    } catch (err) {
      // Enqueue failed after we flipped status — best-effort revert back to
      // error so the UI isn't stuck on "cloning" forever.
      const message = err instanceof Error ? err.message : String(err)
      await reposRepo.finishClone(handle, updated.id, {
        status: 'error',
        lastError: `Failed to enqueue clone job: ${message}`,
      })
      return httpError(c, {
        code: 'internal',
        message: `Failed to enqueue clone job: ${message}`,
      })
    }
  },
)
  // ─── POST /api/repos/:id/index ───────────────────────────────────────────
  .post(
    '/:id/index',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const handle = getDb()

      // Read-first so we can emit a precise 404 vs 409 message. The 409
      // branch covers two cases: already indexing (duplicate click) and
      // states that are pre-clone (pending/cloning — no source/ on disk).
      const row = await reposRepo.getForWorker(handle, id)
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }
      if (row.status === 'indexing') {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} is already indexing`,
        })
      }
      // markIndexing's CAS only accepts cloned | ready | error — anything
      // else means we don't have a `source/` tree to analyze yet.
      if (row.status !== 'cloned' && row.status !== 'ready' && row.status !== 'error') {
        return httpError(c, {
          code: 'conflict',
          message:
            `repo ${id} is ${row.status}; index requires a completed clone ` +
            `(cloned|ready|error)`,
        })
      }

      const updated = await reposRepo.markIndexing(handle, id)
      if (!updated) {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} transitioned out from under us; retry`,
        })
      }

      // `initial` means "first time after a fresh clone" (clone worker
      // auto-chains). Here we're a user-initiated re-index of a repo that
      // already had a prior clone, so always `reindex` — even if the prior
      // state was 'error' (user's mental model is "try again", not "first
      // time"), the previous summary row is still there and `--force` on
      // analyze will rebuild cleanly.
      try {
        const { jobId } = await enqueueIndexRepo({
          repoId: updated.id,
          mode: 'reindex',
        })
        return c.json(
          {
            ok: true as const,
            jobId,
            streamId: repoStreamId(updated.id),
          },
          202,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await reposRepo.finishIndex(handle, updated.id, {
          status: 'error',
          lastError: `Failed to enqueue index job: ${message}`,
        })
        return httpError(c, {
          code: 'internal',
          message: `Failed to enqueue index job: ${message}`,
        })
      }
    },
  )

export type RepoJobsRouter = typeof repoJobsRouter
