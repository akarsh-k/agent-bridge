/**
 * BullMQ job payload schemas for repo-related worker jobs.
 *
 * Design rule: **secrets NEVER live on the job payload.** BullMQ persists
 * job data in Redis and exposes it via the admin UI — a PAT on the payload
 * would survive beyond the job's lifetime and widen the blast radius of a
 * Redis breach. We pass `repoId` only; the worker re-fetches the row and
 * decrypts the envelope at spawn time, holding plaintext in a local variable
 * and an env var on the child process (never on the Redis-persisted record).
 *
 * `hasPat` is a boolean hint so the worker can fast-fail with a readable
 * error ("repo has no PAT configured — add one via PATCH /api/repos/:id")
 * instead of discovering the missing envelope two levels into the git clone.
 *
 * Browser-safe (the schemas do not import Node-only code).
 */

import { z } from 'zod'

export const cloneRepoJobSchema = z
  .object({
    repoId: z.uuid(),
    remoteUrl: z.string().min(1),
    branch: z.string().min(1),
    /** True if the repo row carries an encrypted PAT envelope on disk. */
    hasPat: z.boolean(),
  })
  .strict()

export type CloneRepoJob = z.infer<typeof cloneRepoJobSchema>

/**
 * `indexRepo` job payload — kicked off either by the clone worker (on
 * successful clone; `mode='initial'`) or by the `POST /api/repos/:id/index`
 * backend route (manual re-index or retry-after-error; `mode='reindex'`).
 *
 * `mode` is purely for UX — it's forwarded verbatim to the `repo.index.started`
 * SSE payload so the frontend can label the log banner ("Initial index…" vs
 * "Re-indexing…"). It does NOT decide whether to force-rebuild. that's
 * the `force` flag below.
 *
 * `force` (default `false`, `docs/ARCHITECTURE.md §10` D16/A5) — when `true`, the
 * worker passes `-f` to `gitnexus analyze`, blowing away the existing
 * graph + embeddings store and rebuilding from scratch. Default behaviour
 * relies on gitnexus's incremental analyze, which only re-parses files
 * whose content/mtime changed since the previous run. This is what every
 * "Update index" click should hit; "Rebuild from scratch" is the explicit
 * escape hatch (separate UI affordance, confirm dialog).
 *
 * No secret lives on the payload. indexing is a local-only operation and
 * the source tree is already on disk.
 */
export const indexRepoJobSchema = z
  .object({
    repoId: z.uuid(),
    mode: z.enum(['initial', 'reindex']),
    force: z.boolean().default(false),
  })
  .strict()

export type IndexRepoJob = z.infer<typeof indexRepoJobSchema>

/**
 * `generateWiki` job payload — kicked off by the
 * `POST /api/repos/:id/wiki` backend route. Wiki generation is LLM-bound
 * (each module page is summarised by the configured provider) so the
 * caller picks which LLM provider charges per run via `llmProviderId`.
 *
 * Secrets stay off the payload — the worker re-fetches the provider row
 * and decrypts `api_key_envelope` at spawn time, same discipline as the
 * clone job's PAT handling. `mode='force'` maps to `gitnexus wiki --force`
 * and skips the "wiki is already up to date" short-circuit; `'initial'`
 * is the default first-run path.
 */
export const generateWikiJobSchema = z
  .object({
    repoId: z.uuid(),
    llmProviderId: z.uuid(),
    /**
     * Resolved model id. The HTTP body accepts an optional `model`
     * override that falls back to `llm_providers.default_model`, but
     * the backend resolves that fallback before enqueueing — so the
     * worker payload always carries a concrete value. Keeps the
     * worker's job purely "execute" and the resolution policy in one
     * place (the route handler).
     */
    model: z.string().trim().min(1).max(200),
    mode: z.enum(['initial', 'force']),
  })
  .strict()

export type GenerateWikiJob = z.infer<typeof generateWikiJobSchema>
