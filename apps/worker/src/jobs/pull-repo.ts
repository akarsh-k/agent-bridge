import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Job } from 'bullmq'

import { reposRepo, workerJobsRepo } from '@agent-bridge/db'
import {
  pullRepoJobSchema,
  redactSecrets,
  repoStreamId,
  type RepoPullFailPayload,
  type RepoPullOkPayload,
  type RepoPullProgressPayload,
  type RepoPullStartedPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import { getGitAskpassPath } from '@agent-bridge/shared/git-remote'
import { repoSourceDir } from '@agent-bridge/shared/paths'
import { spawnSandboxed } from '@agent-bridge/shared/spawn'

import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'
import { enqueueIndexRepo } from './enqueue.js'
import { makeProgressThrottle } from './progress-throttle.js'

/**
 * Refresh an already-cloned repo from its remote without paying the cost of
 * a fresh clone. Two-step shell:
 *
 *   git fetch --depth=1 origin <branch>
 *   git reset --hard origin/<branch>
 *
 * Why fetch+reset and not `git pull`:
 *   - We want mirror semantics ("make local exactly match origin"), not
 *     integration semantics. Force-pushes on the remote produce silent
 *     fast-forwards here; with `pull` they'd either create a meaningless
 *     merge commit (default) or refuse to advance (`--ff-only`).
 *   - `git reset --hard` only touches tracked files. `<source>/.gitnexus/`
 *     is gitignored, so embeddings + the analyze cache survive — the
 *     auto-chained `gitnexus analyze` is incremental (only re-walks
 *     files whose content/mtime changed; see `docs/ARCHITECTURE.md §10.11`).
 *
 * Failure semantics: the `source/` tree is mutated in place, which breaks
 * the clone job's "complete or absent" invariant. We mitigate by (a)
 * checking `.git/` exists up front, (b) running fetch before any
 * destructive op so a transient network error leaves the tree pristine,
 * (c) parking the row in `status='error'` with a redacted last-error
 * message so the UI surfaces a clear failure and the user can re-pull
 * or re-clone.
 */

export async function handlePullRepoJob(
  job: Job<unknown, PullRepoJobResult>,
): Promise<PullRepoJobResult> {
  const input = pullRepoJobSchema.parse(job.data)
  const startedAt = Date.now()

  const streamId = repoStreamId(input.repoId)
  const bus = getEventBus()
  const db = getDb()

  // Same audit-log discipline as the clone/index handlers — publish-only
  // until the `worker_jobs` row exists, then dual-write events to Redis
  // AND `worker_events`. Failures to audit never break the live stream.
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
        console.warn(
          `[pull-repo] failed to audit ${event.kind} for job ${jobId}: ${errMsg(err)}`,
        )
      }
    }
    return subscribers
  }
  const now = (): number => Date.now()

  const row = await reposRepo.getForWorker(db, input.repoId)
  if (!row) {
    const message = `Repo ${input.repoId} was deleted before the pull job ran`
    await publish({
      kind: 'repo.pull.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoPullFailPayload,
    })
    throw new Error(message)
  }

  try {
    const jobRow = await workerJobsRepo.createWorkerJob(db, {
      repoId: input.repoId,
      jobKind: 'pull',
    })
    jobId = jobRow.id
  } catch (err) {
    console.warn(
      `[pull-repo] failed to create worker_jobs row for repo ${input.repoId}: ${errMsg(err)}`,
    )
  }

  if (row.status !== 'pulling') {
    // Defensive: the backend route owns the `… → pulling` CAS. If we
    // observe any other status here it means the row transitioned out
    // from under us — bail cleanly instead of mutating the source tree.
    const message =
      `Repo ${input.repoId} is ${row.status}, expected 'pulling' ` +
      `(the backend should CAS the row before enqueue)`
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

  if (!row.localPath) {
    const message = `Repo ${input.repoId} has no localPath — pull requires a prior successful clone`
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

  const remoteUrl = row.remoteUrl
  const branch = row.branch
  const patEnvelope = row.gitPatEnvelope
  const hasPat = Boolean(patEnvelope)

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

  const sourceDir = repoSourceDir({
    id: row.id,
    remoteUrl,
    branch,
  })

  // Verify the working tree exists AND looks like a git checkout before
  // we run any mutating command against it. A missing `.git/` would mean
  // a previous re-clone wiped the dir but the DB row says otherwise —
  // we'd rather surface a clear "no clone to pull from" error than have
  // `git fetch` fail with the same intent but a less friendly message.
  try {
    const gitDir = path.join(sourceDir, '.git')
    const stat = await fs.stat(gitDir)
    if (!stat.isDirectory()) {
      throw new Error(`${gitDir} is not a directory`)
    }
  } catch (err) {
    const message =
      `Source tree at ${sourceDir} is not a git checkout: ${errMsg(err)}. ` +
      `Re-clone the repo to recover.`
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

  await publish({
    kind: 'repo.pull.started',
    ts: now(),
    streamId,
    data: {
      repoId: input.repoId,
      remoteUrl,
      branch,
    } satisfies RepoPullStartedPayload,
  })

  // Throttle progress to ~1/sec. `git fetch` emits a chunky stream of
  // "Receiving objects" lines on big repos and we'd otherwise burn a
  // Postgres write per line.
  const pullThrottle = makeProgressThrottle()
  const emitProgress = async (line: string): Promise<void> => {
    const cleaned = redactSecrets(line, redactList)
    if (!pullThrottle.shouldEmit()) return
    await publish({
      kind: 'repo.pull.progress',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        line: cleaned,
      } satisfies RepoPullProgressPayload,
    })
  }

  try {
    await runGitFetch({
      sourceDir,
      branch,
      patPlaintext,
      onStderrLine: emitProgress,
    })
    await runGitReset({
      sourceDir,
      branch,
      onStderrLine: emitProgress,
    })
    const headSha = await readHeadSha(sourceDir)

    await finishAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      result: { status: 'cloned' },
      startedAt,
      jobId,
      okExtras: {
        localPath: sourceDir,
        headSha,
      },
    })

    // Auto-chain into the incremental analyze. `.gitnexus/` is preserved
    // across the reset, so this is the cheap path — only files whose
    // content/mtime changed get re-parsed and re-embedded.
    await chainIntoIndex({
      db,
      repoId: input.repoId,
    })

    return {
      repoId: input.repoId,
      status: 'cloned',
      localPath: sourceDir,
      headSha,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    const message = redactSecrets(rawMessage, redactList)
    await finishAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      result: { status: 'error', lastError: message },
      startedAt,
      jobId,
    })
    throw new Error(message)
  }
}

export interface PullRepoJobResult {
  readonly repoId: string
  readonly status: 'cloned' | 'error'
  readonly localPath?: string
  readonly headSha?: string
  readonly durationMs: number
  readonly lastError?: string
}

// ─── git plumbing ─────────────────────────────────────────────────────────

interface RunGitFetchArgs {
  readonly sourceDir: string
  readonly branch: string
  readonly patPlaintext: string | null
  readonly onStderrLine: (line: string) => Promise<void> | void
}

/**
 * `git fetch --depth=1 origin <branch>`. Explicit `--depth=1` matches
 * the original `git clone --depth=1`; without it, fetch on a shallow
 * clone may deepen history to bridge the shallow boundary.
 *
 * Network failures land here, BEFORE the destructive `git reset` step,
 * so a transient connectivity blip leaves the source tree in its
 * previous good state.
 */
async function runGitFetch(args: RunGitFetchArgs): Promise<void> {
  const { sourceDir, branch, patPlaintext, onStderrLine } = args
  const askpass = getGitAskpassPath()

  const gitArgs = [
    'fetch',
    '--depth=1',
    '--progress',
    'origin',
    branch,
  ]

  const child = spawnSandboxed('git', gitArgs, {
    sandbox: 'git',
    cwd: sourceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      AGENT_BRIDGE_GIT_PAT: patPlaintext ?? '',
    },
  })

  const streamLines = readLineByLine(child.stderr, onStderrLine)
  child.stdout?.resume()

  const [code] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    }),
    streamLines,
  ])

  if (code !== 0) {
    throw new GitCommandError(`git fetch exited with code ${code}`, code)
  }
}

interface RunGitResetArgs {
  readonly sourceDir: string
  readonly branch: string
  readonly onStderrLine: (line: string) => Promise<void> | void
}

/**
 * `git reset --hard origin/<branch>`. We pass `origin/<branch>` rather
 * than `FETCH_HEAD` because both refs point at the same commit after
 * fetch and the named form makes the intent obvious in worker logs.
 * `<branch>` alone (no `origin/`) would be wrong — that's the local
 * branch ref, which fetch does NOT update.
 *
 * `reset --hard` only touches tracked files; gitignored paths like
 * `<source>/.gitnexus/` survive intact, which is exactly the property
 * that makes pull cheaper than re-clone.
 */
async function runGitReset(args: RunGitResetArgs): Promise<void> {
  const { sourceDir, branch, onStderrLine } = args

  const gitArgs = ['reset', '--hard', `origin/${branch}`]

  const child = spawnSandboxed('git', gitArgs, {
    sandbox: 'git',
    cwd: sourceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const streamLines = readLineByLine(child.stderr, onStderrLine)
  child.stdout?.resume()

  const [code] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    }),
    streamLines,
  ])

  if (code !== 0) {
    throw new GitCommandError(`git reset exited with code ${code}`, code)
  }
}

/**
 * `git rev-parse HEAD`. Best-effort: a failure here doesn't roll back
 * the pull (the tree is already updated and the embeddings are about to
 * be refreshed), so we return `'unknown'` and let the UI render that
 * verbatim. Failures are rare in practice — only a missing/corrupt
 * `.git/HEAD` would trip this, and we'd already have failed the reset.
 */
async function readHeadSha(sourceDir: string): Promise<string> {
  const child = spawnSandboxed('git', ['rev-parse', 'HEAD'], {
    sandbox: 'git',
    cwd: sourceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let out = ''
  child.stdout?.on('data', (chunk: Buffer | string) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  child.stderr?.resume()

  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
  })

  if (code !== 0) return 'unknown'
  return out.trim() || 'unknown'
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

async function readLineByLine(
  stream: NodeJS.ReadableStream | null,
  sink: (line: string) => Promise<void> | void,
): Promise<void> {
  if (!stream) return
  let buffer = ''
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
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

async function finishAndPublish(args: {
  publish: (event: RunEvent) => Promise<number>
  db: ReturnType<typeof getDb>
  streamId: string
  repoId: string
  result: reposRepo.PullResult
  startedAt?: number
  jobId?: string | null
  okExtras?: {
    readonly localPath: string
    readonly headSha: string
  }
}): Promise<void> {
  const { publish, db, streamId, repoId, result, startedAt, jobId, okExtras } =
    args
  await reposRepo.finishPull(db, repoId, result)
  if (jobId) {
    try {
      await workerJobsRepo.markWorkerJobFinished(db, jobId, {
        status: result.status === 'cloned' ? 'completed' : 'error',
        errorMessage:
          result.status === 'error' ? result.lastError ?? null : null,
      })
    } catch (err) {
      console.warn(
        `[pull-repo] failed to finalise job ${jobId}: ${errMsg(err)}`,
      )
    }
  }

  if (result.status === 'cloned' && okExtras) {
    await publish({
      kind: 'repo.pull.ok',
      ts: Date.now(),
      streamId,
      data: {
        repoId,
        localPath: okExtras.localPath,
        durationMs: startedAt ? Date.now() - startedAt : 0,
        headSha: okExtras.headSha,
      } satisfies RepoPullOkPayload,
    })
  } else if (result.status === 'error') {
    await publish({
      kind: 'repo.pull.fail',
      ts: Date.now(),
      streamId,
      data: {
        repoId,
        message: result.lastError,
      } satisfies RepoPullFailPayload,
    })
  }
}

/**
 * Mirror of `clone-repo.ts:chainIntoIndex`. The pull just landed at
 * `status='cloned'` so we CAS into `indexing` and enqueue an analyze.
 * `mode='reindex'` so the UI banner says "Re-indexing…" rather than
 * "Initial index…"; `force: false` because we want the incremental
 * pass (the whole point of the pull path is to reuse `.gitnexus/`).
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
        `[pull-repo] chain-into-index CAS lost for repo ${repoId} ` +
          `(row transitioned before we got there); manual re-index still works`,
      )
      return
    }
    await enqueueIndexRepo({ repoId, mode: 'reindex', force: false })
  } catch (err) {
    console.error(
      `[pull-repo] failed to auto-chain index for repo ${repoId}: ${errMsg(err)}`,
    )
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
