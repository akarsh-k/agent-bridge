import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Job } from 'bullmq'

import { reposRepo, workerJobsRepo } from '@agent-bridge/db'
import {
  cloneRepoJobSchema,
  redactSecrets,
  repoStreamId,
  type RepoCloneFailPayload,
  type RepoCloneOkPayload,
  type RepoCloneProgressPayload,
  type RepoCloneStartedPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  ensureDataDirs,
  repoSourceDir,
  repoTmpDir,
} from '@agent-bridge/shared/paths'
import { spawnSandboxed } from '@agent-bridge/shared/spawn'

import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'
import { enqueueIndexRepo } from './enqueue.js'

/**
 * Sandboxed `git clone` with atomic rename, live progress SSE, and PAT
 * injection via `GIT_ASKPASS` — zero plaintext on disk.
 *
 * Flow per job:
 *   1. Validate the BullMQ payload (Zod).
 *   2. Re-fetch the repo row; decrypt the PAT envelope into a local var.
 *   3. Wipe any leftover `source.tmp/` from a previous failure.
 *   4. Spawn `git clone --depth 1 --single-branch --branch <b> <url>
 *      source.tmp/` with:
 *        - sandbox: 'git' (HOME clamp, config isolation, no terminal prompt)
 *        - env.GIT_ASKPASS: our helper (bin/git-askpass.mjs)
 *        - env.AGENT_BRIDGE_GIT_PAT: the plaintext PAT (child only)
 *   5. Stream stderr → `repo.clone.progress` (one event per line),
 *      redacted against the PAT.
 *   6. On exit=0: `rm -rf source/` → `rename source.tmp → source`.
 *   7. Update the DB row (`finishClone`) and publish the terminal event.
 *
 * Failure semantics: the `source/` dir is either a complete successful
 * clone or it doesn't exist. A partial `source/` is never observable from
 * outside this handler — git writes into `source.tmp/` and we only promote
 * it atomically after a successful exit. On failure we best-effort clean
 * up `source.tmp/`.
 */

export async function handleCloneRepoJob(
  job: Job<unknown, CloneRepoJobResult>,
): Promise<CloneRepoJobResult> {
  const input = cloneRepoJobSchema.parse(job.data)
  const startedAt = Date.now()

  const streamId = repoStreamId(input.repoId)
  const bus = getEventBus()
  const db = getDb()

  // `jobId` is set after the repo-existence check creates the
  // `worker_jobs` row. Until then `publish` is publish-only (the
  // pre-job-start fail path can't audit anywhere — no FK target
  // would exist for an event row). Once set, every publish ALSO
  // appends to `worker_events` so the /logs page can replay the
  // job's full timeline after the fact.
  let jobId: string | null = null
  const publish = async (event: RunEvent): Promise<number> => {
    const subscribers = await bus.publish(event)
    if (jobId) {
      try {
        await workerJobsRepo.appendWorkerEvent(db, {
          jobId,
          kind: event.kind,
          payload: event.data ?? null,
          ts: new Date(event.ts),
        })
      } catch (err) {
        // Audit-log failure must never break the live stream — log
        // and continue. Same fail-soft policy the agent dispatcher
        // uses (see run-dispatcher.ts:799).
        console.warn(
          `[clone-repo] failed to audit ${event.kind} for job ${jobId}: ${errMsg(err)}`,
        )
      }
    }
    return subscribers
  }
  const now = (): number => Date.now()

  // Re-fetch the row inside the worker. The backend already ran `markCloning`
  // so we expect status='cloning' — but we also need the encrypted PAT
  // envelope and the remote/branch at the moment the job actually runs
  // (in case the user edited them between enqueue and dequeue).
  const row = await reposRepo.getForWorker(db, input.repoId)
  if (!row) {
    const message = `Repo ${input.repoId} was deleted before the clone job ran`
    await publish({
      kind: 'repo.clone.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoCloneFailPayload,
    })
    throw new Error(message)
  }

  // Create the `worker_jobs` lifecycle row before any subsequent
  // publish so every event from this point on is auditable. If the
  // insert itself fails (DB hiccup), we proceed publish-only — the
  // job still runs, it just won't show up on /logs as a separate
  // attempt.
  try {
    const jobRow = await workerJobsRepo.createWorkerJob(db, {
      repoId: input.repoId,
      jobKind: 'clone',
    })
    jobId = jobRow.id
  } catch (err) {
    console.warn(
      `[clone-repo] failed to create worker_jobs row for repo ${input.repoId}: ${errMsg(err)}`,
    )
  }

  const remoteUrl = row.remoteUrl
  const branch = row.branch
  const patEnvelope = row.gitPatEnvelope
  const hasPat = Boolean(patEnvelope)

  // Secrets stay in this local var + the child env; never logged, never on
  // the BullMQ job record.
  let patPlaintext: string | null = null
  if (hasPat && patEnvelope) {
    try {
      patPlaintext = decryptSecret(patEnvelope)
    } catch (err) {
      const message = `Failed to decrypt PAT for repo ${input.repoId}: ${errMsg(err)}`
      await finishAndPublish({
        publish,
        db,
        streamId,
        repoId: input.repoId,
        result: { status: 'error', lastError: message },
        jobId,
      })
      throw new Error(message)
    }
  }

  const redactList: readonly string[] = patPlaintext ? [patPlaintext] : []

  await publish({
    kind: 'repo.clone.started',
    ts: now(),
    streamId,
    data: {
      repoId: input.repoId,
      remoteUrl,
      branch,
    } satisfies RepoCloneStartedPayload,
  })

  // Fs layout prep. The path is slug-keyed (`<owner>__<repo>__<branch>__<shortId>`)
  // so we use the live `remoteUrl`/`branch` we just loaded — not the payload
  // copy — in case the user renamed either between enqueue and dequeue. If
  // the slug changes mid-flight we'd happily clone into a new directory;
  // the DB's `localPath` update below will point to it. Ensure
  // `<dataDir>/repos/` exists with the right perms, then wipe any stale
  // `source.tmp/` left behind by a previous failure.
  ensureDataDirs()
  const descriptor = { id: input.repoId, remoteUrl, branch }
  const rootDir = path.dirname(repoSourceDir(descriptor))
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 })

  const tmpDir = repoTmpDir(descriptor)
  const finalDir = repoSourceDir(descriptor)
  await rmrfBestEffort(tmpDir)

  try {
    await runGitClone({
      remoteUrl,
      branch,
      targetDir: tmpDir,
      patPlaintext,
      onStderrLine: async (line) => {
        const cleaned = redactSecrets(line, redactList)
        await publish({
          kind: 'repo.clone.progress',
          ts: now(),
          streamId,
          data: {
            repoId: input.repoId,
            line: cleaned,
          } satisfies RepoCloneProgressPayload,
        })
      },
    })

    // Success path: swap tmpDir → finalDir atomically. `fs.rename` over an
    // existing directory fails on POSIX, so clear `finalDir` first.
    await rmrfBestEffort(finalDir)
    await fs.rename(tmpDir, finalDir)

    await finishAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      result: { status: 'cloned', localPath: finalDir },
      startedAt,
      jobId,
    })

    // Auto-chain into index. We own the `cloned → indexing` CAS here
    // rather than letting the backend enqueue because the clone is a
    // single user gesture — "make this repo ready for agents" — and a
    // round-trip through HTTP for every successful clone would just be
    // latency. CAS-fails (e.g. user manually kicked a re-clone that
    // somehow raced) are logged and swallowed: the repo stays at
    // 'cloned' and the inspector surfaces an "Index" button the user
    // can click. Enqueue errors also don't roll back the clone — the
    // `source/` dir is still useful.
    await chainIntoIndex({
      db,
      repoId: input.repoId,
    })

    return {
      repoId: input.repoId,
      status: 'cloned',
      localPath: finalDir,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    const message = redactSecrets(rawMessage, redactList)
    await rmrfBestEffort(tmpDir)
    await finishAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      result: { status: 'error', lastError: message },
      startedAt,
      jobId,
    })
    // BullMQ shows the thrown error in its admin UI; keep it redacted too.
    throw new Error(message)
  }
}

export interface CloneRepoJobResult {
  readonly repoId: string
  readonly status: 'cloned' | 'error'
  readonly localPath?: string
  readonly durationMs: number
  readonly lastError?: string
}

// ─── git clone plumbing ───────────────────────────────────────────────────

/**
 * Resolve the absolute path to `bin/git-askpass.mjs`. Dev (tsx) and prod
 * (node dist/) both keep `src`/`dist` as siblings of `bin/`, so `../..`
 * from either `src/jobs/` or `dist/jobs/` lands on the worker app root.
 */
function askpassScriptPath(): string {
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..', '..', 'bin', 'git-askpass.mjs')
}

interface RunGitCloneArgs {
  readonly remoteUrl: string
  readonly branch: string
  readonly targetDir: string
  readonly patPlaintext: string | null
  readonly onStderrLine: (line: string) => Promise<void> | void
}

async function runGitClone(args: RunGitCloneArgs): Promise<void> {
  const { remoteUrl, branch, targetDir, patPlaintext, onStderrLine } = args
  const askpass = askpassScriptPath()
  if (!existsSync(askpass)) {
    throw new Error(`GIT_ASKPASS helper not found at ${askpass}`)
  }

  const gitArgs = [
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    branch,
    '--progress',
    remoteUrl,
    targetDir,
  ]

  const child = spawnSandboxed('git', gitArgs, {
    sandbox: 'git',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // Override the sandbox-default empty-password askpass with our helper.
      GIT_ASKPASS: askpass,
      // Some OS-es also look at SSH_ASKPASS; normalise to the same helper
      // so we don't fall through to a GUI prompt on misconfigured boxes.
      SSH_ASKPASS: askpass,
      // PAT is read by the helper from this env var. Empty-string when
      // absent; we don't leak it to the child's parent at all.
      AGENT_BRIDGE_GIT_PAT: patPlaintext ?? '',
    },
  })

  // Line-buffer stderr so each progress chunk ends up as one event.
  const streamLines = readLineByLine(child.stderr, onStderrLine)
  // Drain stdout so git doesn't block on a full pipe buffer. We don't
  // publish it as progress — git's stdout is usually empty for `clone`,
  // but consume it anyway for safety.
  child.stdout?.resume()

  const [code] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    }),
    streamLines,
  ])

  if (code !== 0) {
    throw new GitCloneError(`git clone exited with code ${code}`, code)
  }
}

class GitCloneError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'GitCloneError'
  }
}

/**
 * Buffer a readable stream and invoke `sink` once per newline. Important
 * for two reasons:
 *   - Git writes progress using \r, not \n, to overwrite the same line.
 *     We split on both so a single "Receiving objects: 1%…100%" stream
 *     surfaces as many progress events rather than one fat event.
 *   - Calling `sink` sync-inline with each chunk is fine — we don't await
 *     each publish because Redis publish is async but we want to let git
 *     keep streaming.
 */
async function readLineByLine(
  stream: NodeJS.ReadableStream | null,
  sink: (line: string) => Promise<void> | void,
): Promise<void> {
  if (!stream) return
  let buffer = ''
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Split on \n OR \r — git uses \r for in-place progress updates.
    const parts = buffer.split(/[\r\n]/)
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      await sink(trimmed)
    }
  }
  const tail = buffer.trim()
  if (tail.length > 0) await sink(tail)
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function rmrfBestEffort(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true })
  } catch (err) {
    // Best-effort: the next mkdir/rename will surface a real error if this
    // mattered. We don't want a stat race to block the clone path.
    console.warn(
      `[clone-repo] rm -rf ${target} failed (ignored): ${errMsg(err)}`,
    )
  }
}

async function finishAndPublish(args: {
  publish: (event: RunEvent) => Promise<number>
  db: ReturnType<typeof getDb>
  streamId: string
  repoId: string
  result: reposRepo.CloneResult
  startedAt?: number
  /** When set, the matching `worker_jobs` row gets its terminal
   *  status (completed/error) and `finished_at` written before the
   *  terminal event is published. Best-effort — a failed update is
   *  logged and swallowed so the live event still ships. */
  jobId?: string | null
}): Promise<void> {
  const { publish, db, streamId, repoId, result, startedAt, jobId } = args
  await reposRepo.finishClone(db, repoId, result)
  if (jobId) {
    try {
      await workerJobsRepo.markWorkerJobFinished(db, jobId, {
        status: result.status === 'cloned' ? 'completed' : 'error',
        errorMessage:
          result.status === 'error' ? result.lastError ?? null : null,
      })
    } catch (err) {
      console.warn(
        `[clone-repo] failed to finalise job ${jobId}: ${errMsg(err)}`,
      )
    }
  }

  if (result.status === 'cloned') {
    await publish({
      kind: 'repo.clone.ok',
      ts: Date.now(),
      streamId,
      data: {
        repoId,
        localPath: result.localPath,
        durationMs: startedAt ? Date.now() - startedAt : 0,
      } satisfies RepoCloneOkPayload,
    })
  } else {
    await publish({
      kind: 'repo.clone.fail',
      ts: Date.now(),
      streamId,
      data: {
        repoId,
        message: result.lastError,
      } satisfies RepoCloneFailPayload,
    })
  }
}

/**
 * Flip `cloned → indexing` via CAS and enqueue `indexRepo { mode:'initial' }`.
 * Failures here are logged but never bubble up: the clone itself already
 * succeeded, and the UI ships a manual "Index" button as a fallback.
 */
async function chainIntoIndex(args: {
  db: ReturnType<typeof getDb>
  repoId: string
}): Promise<void> {
  const { db, repoId } = args
  try {
    const claimed = await reposRepo.markIndexing(db, repoId)
    if (!claimed) {
      console.warn(
        `[clone-repo] chain-into-index CAS lost for repo ${repoId} ` +
          `(row transitioned before we got there); manual index still works`,
      )
      return
    }
    await enqueueIndexRepo({ repoId, mode: 'initial' })
  } catch (err) {
    console.error(
      `[clone-repo] failed to auto-chain index for repo ${repoId}: ${errMsg(err)}`,
    )
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
