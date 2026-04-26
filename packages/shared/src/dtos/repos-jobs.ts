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
 * "Re-indexing…") and choose whether to add `-f/--force` to the gitnexus
 * invocation. No secret lives on the payload — indexing is a local-only
 * operation and the source tree is already on disk.
 */
export const indexRepoJobSchema = z
  .object({
    repoId: z.uuid(),
    mode: z.enum(['initial', 'reindex']),
  })
  .strict()

export type IndexRepoJob = z.infer<typeof indexRepoJobSchema>
