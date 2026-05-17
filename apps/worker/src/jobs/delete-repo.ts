/**
 * `delete-repo` worker — completes the soft-delete the backend started
 * with `DELETE /api/repos/:id`. The route flips
 * `repos.deletion_pending=true`, detaches `agent_repos`, and enqueues
 * one of these jobs; the actual disk + row removal happens here, off
 * the request path, so the operator never waits for `rm -rf` and any
 * in-flight clone/index/wiki for the repo can drain cleanly first.
 *
 * Flow per job:
 *   1. Validate the BullMQ payload (Zod). The payload carries
 *      `remoteUrl` + `branch` so we can compute the on-disk path even
 *      if the row vanished mid-job (paranoid fallback for a manual SQL
 *      delete that races us).
 *   2. Publish `repo.delete.started` on `repo:<id>` so any operator
 *      tailing the Logs page sees the cleanup begin.
 *   3. Wait for any active/waiting clone/index/wiki job for this repo
 *      to finish. We poll the three sibling queues every 2s for up to
 *      5 minutes, publishing one `repo.delete.waiting` per cycle that
 *      finds something blocking. Past 5 minutes, the job fails —
 *      BullMQ retries with `attempts: 2` and the operator sees a
 *      stuck "deletion pending" repo to investigate.
 *   4. `rm -rf` the repo's directory under `<dataDir>/repos/<slug>/`.
 *      That single tree contains the cloned source, the gitnexus index
 *      under `source/.gitnexus/`, and any wiki output — one call wipes
 *      everything per-repo. The shared gitnexus-home cache directory
 *      is NOT touched (it's process-level state, used across repos).
 *   5. Hard-delete the `repos` row. Cascades drop any remaining
 *      `repo_relationships` and `worker_jobs` (and their `worker_events` via
 *      the worker_jobs cascade).
 *   6. Publish `repo.delete.ok` (or `repo.delete.fail` from the catch
 *      arm) so the Logs UI shows a terminal state instead of just
 *      stopping mid-stream.
 *
 * Idempotent: if the row is already gone, step 5 is a no-op. If the
 * directory is already gone, `rm -rf` succeeds silently. Re-running
 * the job is safe.
 *
 * No `worker_jobs` audit row is created. The cascade on the hard
 * delete in step 5 would drop it anyway, so there's nothing to read
 * back from /logs after success — the SSE events are the live signal,
 * console.info is the persistent worker-side trail.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Job, Queue } from 'bullmq'

import {
  QUEUE_NAMES,
  deleteRepoJobSchema,
  repoStreamId,
  type DeleteRepoJob,
  type RepoDeleteFailPayload,
  type RepoDeleteOkPayload,
  type RepoDeleteStartedPayload,
  type RepoDeleteWaitingPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { repoRootDir } from '@agent-bridge/shared/paths'
import { reposRepo } from '@agent-bridge/db'

import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'

const POLL_INTERVAL_MS = 2_000
const MAX_WAIT_MS = 5 * 60_000

export interface DeleteRepoJobResult {
  readonly repoId: string
  readonly diskRemoved: boolean
  readonly rowRemoved: boolean
  readonly waitedMs: number
}

export interface DeleteRepoJobDeps {
  /**
   * Sibling queues to poll for in-flight work. Injected so the worker
   * boot in `index.ts` can hand its already-constructed `Queue`
   * instances in without re-opening Redis sockets here.
   */
  readonly siblingQueues: {
    readonly cloneRepo: Queue
    readonly indexRepo: Queue
    readonly generateWiki: Queue
  }
}

export function makeDeleteRepoHandler(deps: DeleteRepoJobDeps) {
  return async function handleDeleteRepoJob(
    job: Job<unknown, DeleteRepoJobResult>,
  ): Promise<DeleteRepoJobResult> {
    const input = deleteRepoJobSchema.parse(job.data)
    const streamId = repoStreamId(input.repoId)
    const bus = getEventBus()
    const log = (msg: string): void => {
      console.info(`[worker:delete-repo:${input.repoId}] ${msg}`)
    }
    // Publish-only — there's no `worker_jobs` row for this lifecycle
    // (see module docstring) so we just push to the SSE bus.
    const publish = async (event: RunEvent): Promise<void> => {
      try {
        await bus.publish(event)
      } catch (err) {
        // Never let a bus hiccup take down the actual cleanup. The
        // operator loses live visibility on this attempt; the next
        // poll-driven repo refresh still shows the right state.
        console.warn(
          `[worker:delete-repo:${input.repoId}] publish ${event.kind} failed: ${errMsg(err)}`,
        )
      }
    }

    log(`starting cleanup for ${input.remoteUrl}@${input.branch}`)
    await publish({
      kind: 'repo.delete.started',
      ts: Date.now(),
      streamId,
      data: {
        repoId: input.repoId,
        remoteUrl: input.remoteUrl,
        branch: input.branch,
      } satisfies RepoDeleteStartedPayload,
    })

    let waitedMs = 0
    let diskRemoved = false
    let rowRemoved = false
    try {
      waitedMs = await waitForInFlightJobs({
        repoId: input.repoId,
        queues: deps.siblingQueues,
        publish,
        streamId,
        log,
      })

      diskRemoved = await removeRepoDir({ input, log })
      rowRemoved = await deleteRepoRow({ repoId: input.repoId, log })
    } catch (err) {
      const message = errMsg(err)
      log(`failed: ${message}`)
      await publish({
        kind: 'repo.delete.fail',
        ts: Date.now(),
        streamId,
        data: {
          repoId: input.repoId,
          message,
          // The wait throw is the only one that's recoverable-by-time.
          // Tag it so the UI can word the message ("still draining…")
          // rather than treating it like a permanent failure.
          ...(message.startsWith('timed out after')
            ? { waitTimeout: true }
            : {}),
        } satisfies RepoDeleteFailPayload,
      })
      throw err
    }

    log(
      `done — waited ${waitedMs}ms, diskRemoved=${diskRemoved}, rowRemoved=${rowRemoved}`,
    )
    await publish({
      kind: 'repo.delete.ok',
      ts: Date.now(),
      streamId,
      data: {
        repoId: input.repoId,
        waitedMs,
        diskRemoved,
        rowRemoved,
      } satisfies RepoDeleteOkPayload,
    })

    return {
      repoId: input.repoId,
      diskRemoved,
      rowRemoved,
      waitedMs,
    }
  }
}

async function waitForInFlightJobs(args: {
  readonly repoId: string
  readonly queues: DeleteRepoJobDeps['siblingQueues']
  readonly publish: (event: RunEvent) => Promise<void>
  readonly streamId: string
  readonly log: (msg: string) => void
}): Promise<number> {
  const { repoId, queues, publish, streamId, log } = args
  const startedAt = Date.now()
  const queueList = [
    { name: QUEUE_NAMES.cloneRepo, queue: queues.cloneRepo },
    { name: QUEUE_NAMES.indexRepo, queue: queues.indexRepo },
    { name: QUEUE_NAMES.generateWiki, queue: queues.generateWiki },
  ] as const

  while (true) {
    const elapsed = Date.now() - startedAt
    if (elapsed > MAX_WAIT_MS) {
      // Don't `rm -rf` while another job might still be writing to the
      // tree. Surface the stall as a job failure so BullMQ retries
      // (one more attempt) and an operator can see something is wrong.
      throw new Error(
        `timed out after ${Math.floor(elapsed / 1_000)}s waiting for ` +
          `in-flight clone/index/wiki on repo ${repoId} to finish`,
      )
    }

    const counts = await Promise.all(
      queueList.map(async (q) => ({
        name: q.name,
        count: await countActiveForRepo(q.queue, repoId),
      })),
    )
    const total = counts.reduce((sum, c) => sum + c.count, 0)
    if (total === 0) return Date.now() - startedAt

    const pendingByQueue: Record<string, number> = {}
    for (const c of counts) {
      if (c.count > 0) pendingByQueue[c.name] = c.count
    }
    const summary = counts
      .filter((c) => c.count > 0)
      .map((c) => `${c.name}=${c.count}`)
      .join(', ')
    log(`waiting on in-flight job(s): ${summary} (elapsed ${elapsed}ms)`)
    await publish({
      kind: 'repo.delete.waiting',
      ts: Date.now(),
      streamId,
      data: {
        repoId,
        elapsedMs: elapsed,
        pendingByQueue,
      } satisfies RepoDeleteWaitingPayload,
    })
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Count `active`/`waiting`/`delayed` jobs in `queue` whose payload's
 * `repoId` matches. We don't include `paused` (different lifecycle —
 * a paused queue won't progress on its own and waiting on it would
 * hang forever) or `failed`/`completed` (already terminal).
 */
async function countActiveForRepo(
  queue: Queue,
  repoId: string,
): Promise<number> {
  const jobs = await queue.getJobs(['active', 'waiting', 'delayed'])
  let count = 0
  for (const j of jobs) {
    const data = j.data as { repoId?: unknown } | null
    if (data && typeof data === 'object' && data.repoId === repoId) {
      count += 1
    }
  }
  return count
}

async function removeRepoDir(args: {
  readonly input: DeleteRepoJob
  readonly log: (msg: string) => void
}): Promise<boolean> {
  const { input, log } = args
  // Pass the exact descriptor the clone/index workers used so the slug
  // we generate matches what's actually on disk.
  const dir = repoRootDir({
    id: input.repoId,
    remoteUrl: input.remoteUrl,
    branch: input.branch,
  })

  // Defence against a misconfigured `AGENT_BRIDGE_DATA_DIR` that
  // somehow points at `/`. The shared paths helper already enforces
  // this via `ensureDataDirs`, but a belt-and-braces check here keeps
  // the worst-case rm from being literal.
  if (dir === '/' || dir === path.parse(dir).root) {
    throw new Error(
      `delete-repo: refusing to rm repo dir resolving to root: ${dir}`,
    )
  }

  try {
    await fs.rm(dir, { recursive: true, force: true })
    log(`removed ${dir}`)
    return true
  } catch (err) {
    // `force: true` already swallows ENOENT; anything else (EACCES,
    // EBUSY mid-clone) is a real failure we want BullMQ to retry.
    throw new Error(`failed to remove ${dir}: ${errMsg(err)}`)
  }
}

async function deleteRepoRow(args: {
  readonly repoId: string
  readonly log: (msg: string) => void
}): Promise<boolean> {
  const { repoId, log } = args
  const db = getDb()
  const removed = await reposRepo.hardDelete(db, repoId)
  if (removed) {
    log(`hard-deleted repos row ${repoId}`)
    return true
  }
  // Idempotent: row was already gone (manual SQL delete or a re-run
  // of this same job after a successful run).
  log(`row ${repoId} already gone`)
  return false
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
