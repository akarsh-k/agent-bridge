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
 *   POST /api/repos/:id/pull
 *     202 { ok: true, jobId, streamId: 'repo:<uuid>' }
 *       → cheap refresh. Row flipped `cloned|ready|error → pulling`. Worker
 *         runs `git fetch --depth=1 + git reset --hard origin/<branch>`
 *         in-place, preserving `<source>/.gitnexus/` so the auto-chained
 *         `gitnexus analyze` is incremental (only walks files whose
 *         content/mtime changed).
 *     404                              — repo not found
 *     409                              — row in a state that can't
 *                                        transition to pulling (pending
 *                                        has no source/ yet; cloning|
 *                                        pulling|indexing are in flight).
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

import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import {
  indexRepoBodySchema,
  repoIdParamSchema,
  repoStreamId,
  repoWikiInputSchema,
} from '@agent-bridge/shared'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  EmbedderProbeError,
  buildEmbedderProbeArgs,
  probeEmbedder,
} from '@agent-bridge/shared/embedder-probe'
import { llmProvidersRepo, reposRepo } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import {
  enqueueCloneRepo,
  enqueueGenerateWiki,
  enqueueIndexRepo,
  enqueuePullRepo,
} from '../lib/queues.js'

/**
 * Probe the workspace's embedding provider, if one is configured.
 *
 *   - `null`               — probe passed, OR no provider needed
 *                            (no row, or row exists but lacks a
 *                            model/baseUrl so the worker would fall
 *                            back to gitnexus's local embedder).
 *   - `Response` (4xx)     — probe failed. Caller returns this verbatim;
 *                            it carries a structured details payload
 *                            (`{ kind: 'embedder_unreachable', … }`)
 *                            so the UI can render a remediation hint.
 *
 * Why this lives on the clone/index/wiki path rather than at provider-
 * save time: the embedding server is most often a local process
 * (llama-server / ollama / lmstudio) that the operator starts and
 * stops manually. Validating at save time would catch a typo on the
 * URL but miss the common case of "server was up earlier, isn't now."
 * Probing at the moment of use surfaces the failure immediately, and
 * before we waste a multi-minute clone.
 */
async function probeConfiguredEmbedderOrReply(
  c: Context,
): Promise<Response | null> {
  const handle = getDb()
  const provider = await llmProvidersRepo.getEmbeddingProvider(handle)
  if (!provider) return null

  // Decrypt only at the moment of use — same discipline as the worker.
  // The probe stays in-process; the plaintext never leaves the request.
  const apiKey = provider.apiKeyEnvelope
    ? decryptSecret(provider.apiKeyEnvelope)
    : null

  const probeArgs = buildEmbedderProbeArgs({
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKey,
  })
  if (!probeArgs) return null

  try {
    await probeEmbedder(probeArgs)
    return null
  } catch (err) {
    if (!(err instanceof EmbedderProbeError)) throw err
    const remediation =
      err.kind === 'auth'
        ? 'Check the API key in Settings → Providers, or restart the embedder if it rotated keys.'
        : err.kind === 'bad_model'
          ? `The embedder is up but doesn't know model "${probeArgs.model}". Update the provider in Settings, or pull/load that model on the embedder.`
          : err.kind === 'timeout'
            ? 'Embedding server didn\'t respond in time. Is it overloaded or paused?'
            : 'Start the embedding server, or update the provider URL in Settings → Providers.'

    return httpError(c, {
      code: 'validation_failed',
      message: `Embedding server is unreachable: ${err.message}. ${remediation}`,
      details: {
        kind: 'embedder_unreachable' as const,
        reason: err.kind,
        endpoint: `${probeArgs.baseUrl}/embeddings`,
        model: probeArgs.model,
        status: err.status,
        responseBody: err.responseBody,
      },
    })
  }
}

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

    // Fail fast if the configured embedder is down. The clone itself
    // doesn't need the embedder, but the auto-chained index does; without
    // this check the user watches a multi-minute clone succeed and then
    // immediately fail on a cryptic `gitnexus analyze` error. Probing
    // here turns that into a single clear 400 before any work runs.
    const embedderError = await probeConfiguredEmbedderOrReply(c)
    if (embedderError) return embedderError

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
  // ─── POST /api/repos/:id/pull ────────────────────────────────────────────
  .post(
    '/:id/pull',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const handle = getDb()

      const row = await reposRepo.getForWorker(handle, id)
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }

      // Friendlier error messages than markPulling's bare CAS-loss bucket.
      // Each branch names the actual blocker so the UI can word the toast
      // ("indexing is holding the tree" vs "already pulling") without
      // string-parsing the generic 409.
      if (row.status === 'pulling') {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} is already pulling`,
        })
      }
      if (row.status === 'cloning') {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} is cloning; wait for it to finish before pulling`,
        })
      }
      if (row.status === 'indexing') {
        return httpError(c, {
          code: 'conflict',
          message:
            `repo ${id} is indexing; wait for the analyze pass to finish ` +
            `before pulling`,
        })
      }
      // markPulling's CAS only accepts cloned | ready | error — `pending`
      // means no clone has ever succeeded, so there's no source/ to update.
      if (row.status !== 'cloned' && row.status !== 'ready' && row.status !== 'error') {
        return httpError(c, {
          code: 'conflict',
          message:
            `repo ${id} is ${row.status}; pull requires a completed clone first`,
        })
      }

      // Pull auto-chains into incremental index — same embedder
      // dependency as the clone path. Probe before the CAS so we
      // never leave a row stuck in 'pulling' on a down embedder.
      const embedderError = await probeConfiguredEmbedderOrReply(c)
      if (embedderError) return embedderError

      const updated = await reposRepo.markPulling(handle, id)
      if (!updated) {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} transitioned out from under us; retry`,
        })
      }

      try {
        const { jobId } = await enqueuePullRepo({
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
        // Enqueue failed after we flipped to pulling — best-effort revert
        // to error so the UI isn't stuck on "pulling" forever.
        const message = err instanceof Error ? err.message : String(err)
        await reposRepo.finishPull(handle, updated.id, {
          status: 'error',
          lastError: `Failed to enqueue pull job: ${message}`,
        })
        return httpError(c, {
          code: 'internal',
          message: `Failed to enqueue pull job: ${message}`,
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
      // Body is optional — the default-incremental path takes no body, the
      // "Rebuild from scratch" path posts `{force: true}`. We can't use
      // `zValidator('json', …)` for that: it calls `c.req.json()` which
      // throws "Malformed JSON in request body" on an empty body, breaking
      // the legacy callsite. Parse manually with an empty-body fallback,
      // then run the schema through Zod ourselves.
      const rawBody = (await c.req.text()).trim()
      let parsedBody: unknown = {}
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody)
        } catch {
          return httpError(c, {
            code: 'validation_failed',
            message: 'request body is not valid JSON',
          })
        }
      }
      const bodyResult = indexRepoBodySchema.safeParse(parsedBody)
      if (!bodyResult.success) {
        return httpValidationError(c, bodyResult.error)
      }
      const body = bodyResult.data
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

      // Direct dependency on the embedder for this path. Probe before
      // the CAS so we never park a row in 'indexing' against a down
      // server — gitnexus would discover it 1-2s later and leave the
      // operator with a cryptic stderr line.
      const embedderError = await probeConfiguredEmbedderOrReply(c)
      if (embedderError) return embedderError

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
