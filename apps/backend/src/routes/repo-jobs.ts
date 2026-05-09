/**
 * `/api/repos/:id/{clone|index|wiki}` — enqueue sandboxed clone, index,
 * and wiki-gen jobs.
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
 *   POST /api/repos/:id/wiki  body: { llmProviderId, force?: boolean }
 *     202 { ok: true, jobId, streamId: 'repo:<uuid>' }
 *       → user-initiated wiki gen. Repo must be `status='ready'` (post-
 *         index) and `wiki_status` in {none, ready, error}. The body
 *         picks which LLM provider charges for this run; the backend
 *         resolves the row, validates `defaultModel` is set, and the
 *         worker decrypts the apiKey at spawn time.
 *     404                              — repo or LLM provider not found
 *     409                              — wiki already generating, or
 *                                        the repo isn't ready (status !=
 *                                        ready means there's no meta.json
 *                                        for gitnexus to read).
 *     400                              — selected LLM provider has no
 *                                        defaultModel, OR (for non-openai
 *                                        kinds) no baseUrl.
 *
 * Status authority split mirrors the clone route: the HTTP layer CAS-flips
 * exactly one intermediate state (`cloning`, `indexing`, or `wiki_status=
 * generating`) via the helpers in `@agent-bridge/db`; every terminal
 * transition belongs to the worker.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import {
  indexRepoBodySchema,
  repoIdParamSchema,
  repoStreamId,
  repoWikiInputSchema,
} from '@agent-bridge/shared'
import { llmProvidersRepo, reposRepo } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import {
  enqueueCloneRepo,
  enqueueGenerateWiki,
  enqueueIndexRepo,
} from '../lib/queues.js'

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
    // Body is optional. legacy callers (e.g. existing UI before A5 lands the
    // "Rebuild from scratch" affordance) post no body and get the default
    // incremental behaviour. Explicit `force: true` opts into the
    // full-rebuild path.
    zValidator('json', indexRepoBodySchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const force = body.force ?? false
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
      // time"). `force` is the body flag (D16/A5): default `false` runs
      // gitnexus's incremental analyze; `true` is the explicit
      // "Rebuild from scratch" gesture and adds `-f` to gitnexus.
      try {
        const { jobId } = await enqueueIndexRepo({
          repoId: updated.id,
          mode: 'reindex',
          force,
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
  // ─── POST /api/repos/:id/wiki ────────────────────────────────────────────
  .post(
    '/:id/wiki',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', repoWikiInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const handle = getDb()

      // Read the repo first so 404 vs 409 messaging stays precise. Same
      // shape as the clone/index routes.
      const row = await reposRepo.getForWorker(handle, id)
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }
      if (row.wikiStatus === 'generating') {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} wiki generation is already running`,
        })
      }
      if (row.status !== 'ready') {
        return httpError(c, {
          code: 'conflict',
          message:
            `repo ${id} is ${row.status}; wiki generation requires ` +
            `a successfully indexed repo (status='ready')`,
        })
      }

      // Resolve the LLM provider before flipping wiki_status so a 404 /
      // 400 path doesn't leave the row stuck in 'generating'. The worker
      // re-fetches at spawn time, but the validations we need here
      // (model present, baseUrl resolvable) belong on the request edge —
      // surfacing them as a 400 is much more actionable than a worker
      // failure landing as wiki_status='error' minutes later.
      const provider = await llmProvidersRepo.getForWorker(
        handle,
        body.llmProviderId,
      )
      if (!provider) {
        return httpError(c, {
          code: 'not_found',
          message: `llm_provider ${body.llmProviderId} not found`,
        })
      }
      // Provider owns the model identity: we resolve via the saved
      // `default_model` (no per-request override). Missing model is a
      // synchronous 400 here so the user sees it on click, not a
      // wiki_status='error' row they discover minutes later.
      const effectiveModel = provider.defaultModel ?? null
      if (!effectiveModel) {
        return httpError(c, {
          code: 'validation_failed',
          message:
            `Provider "${provider.label}" has no defaultModel set; ` +
            `configure one on the provider before generating a wiki.`,
        })
      }
      if (provider.kind !== 'openai' && !provider.baseUrl) {
        return httpError(c, {
          code: 'validation_failed',
          message:
            `LLM provider "${provider.label}" (kind=${provider.kind}) ` +
            `requires a baseUrl for wiki generation`,
        })
      }

      // CAS flip; loses if a concurrent click slipped in between the read
      // and now. Same defence-in-depth pattern as markCloning/markIndexing.
      const updated = await reposRepo.markWikiGenerating(handle, id)
      if (!updated) {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} wiki transitioned out from under us; retry`,
        })
      }

      try {
        const { jobId } = await enqueueGenerateWiki({
          repoId: updated.id,
          llmProviderId: provider.id,
          model: effectiveModel,
          mode: body.force ? 'force' : 'initial',
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
        // Same recovery shape as the clone/index routes — if the enqueue
        // fails after we've claimed `wiki_status='generating'`, flip it
        // back to 'error' so the UI doesn't get stuck on a spinner.
        const message = err instanceof Error ? err.message : String(err)
        await reposRepo.finishWiki(handle, updated.id, {
          status: 'error',
          lastError: `Failed to enqueue wiki job: ${message}`,
        })
        return httpError(c, {
          code: 'internal',
          message: `Failed to enqueue wiki job: ${message}`,
        })
      }
    },
  )

export type RepoJobsRouter = typeof repoJobsRouter
