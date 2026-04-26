import { promises as fs } from 'node:fs'
import type { Job } from 'bullmq'

import { reposRepo } from '@agent-bridge/db'
import {
  indexRepoJobSchema,
  repoStreamId,
  type RepoIndexFailPayload,
  type RepoIndexMode,
  type RepoIndexOkPayload,
  type RepoIndexProgressPayload,
  type RepoIndexStartedPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { readIndexSummary, runGitnexus } from '@agent-bridge/shared/gitnexus'
import {
  repoDirName,
  repoSourceDir,
  type RepoDirDescriptor,
} from '@agent-bridge/shared/paths'

import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'

/**
 * Sandboxed `gitnexus analyze` with live progress SSE. Summary counts
 * live in `<source>/.gitnexus/meta.json` (written by gitnexus itself) —
 * we do NOT duplicate them into Postgres. The backend's repo-read path
 * calls `readIndexSummary(sourceDir)` lazily when assembling responses.
 *
 * Flow per job:
 *   1. Validate the BullMQ payload (Zod).
 *   2. Re-fetch the repo row; verify it has `localPath` and status 'indexing'.
 *      The clone worker (for `mode='initial'`) or the backend route (for
 *      `mode='reindex'`) owns the `… → indexing` CAS flip; we just check it
 *      landed and short-circuit with a clear error otherwise.
 *   3. Spawn `gitnexus analyze <sourceDir> --skip-agents-md --no-stats
 *      --name <slug>` (add `-f` for reindex). Sandbox mode 'default' with
 *      `allowHostHome: false` keeps the global registry writes inside our
 *      isolated `gitnexus-home/` dir.
 *   4. Stream stdout+stderr → `repo.index.progress` events, one per line.
 *      Gitnexus uses `cli-progress` which ships `\r`-terminated updates; we
 *      split on both `\r` and `\n` (same buffer as the clone worker).
 *   5. On exit=0: read `meta.json` via the shared helper, call
 *      `finishIndex(ready)`, and publish `ok` with the summary payload so
 *      the UI can render counts without a second fetch.
 *   6. On exit≠0 or meta.json missing: `finishIndex(error)` with the
 *      redacted message; the previous meta.json (if any) stays put.
 *
 * No PAT handling in this path — indexing is a local-only operation
 * against `source/`. We still wire up an empty redact list so future
 * embedding/auth flows can add secrets without a refactor.
 */

export async function handleIndexRepoJob(
  job: Job<unknown, IndexRepoJobResult>,
): Promise<IndexRepoJobResult> {
  const input = indexRepoJobSchema.parse(job.data)
  const startedAt = Date.now()

  const streamId = repoStreamId(input.repoId)
  const bus = getEventBus()
  const db = getDb()

  const publish = (event: RunEvent): Promise<number> => bus.publish(event)
  const now = (): number => Date.now()

  const row = await reposRepo.getForWorker(db, input.repoId)
  if (!row) {
    const message = `Repo ${input.repoId} was deleted before the index job ran`
    await publish({
      kind: 'repo.index.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoIndexFailPayload,
    })
    throw new Error(message)
  }

  // Defensive: the backend route / clone worker are supposed to flip to
  // 'indexing' before enqueueing. If somehow we dequeued a job against a
  // row that's still 'cloning' (or 'pending'), fail fast — analyzing a
  // partial clone would give bogus counts.
  if (row.status !== 'indexing') {
    const message =
      `Repo ${input.repoId} is ${row.status}, expected 'indexing' ` +
      `(the backend/clone-worker should CAS the row before enqueue)`
    await publish({
      kind: 'repo.index.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoIndexFailPayload,
    })
    throw new Error(message)
  }

  if (!row.localPath) {
    const message = `Repo ${input.repoId} has no localPath — clone must land before index`
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      lastError: message,
    })
    throw new Error(message)
  }

  const descriptor: RepoDirDescriptor = {
    id: row.id,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
  }
  const sourceDir = repoSourceDir(descriptor)

  // Sanity-check the source tree exists. The canonical check is
  // `<localPath>` from the row, but `repoSourceDir(descriptor)` is
  // recomputable from scratch — we prefer the latter so a slug-renaming
  // bug can't silently operate on a stale path.
  try {
    const stat = await fs.stat(sourceDir)
    if (!stat.isDirectory()) {
      throw new Error(`${sourceDir} is not a directory`)
    }
  } catch (err) {
    const message = `Source tree not readable at ${sourceDir}: ${errMsg(err)}`
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      lastError: message,
    })
    throw new Error(message)
  }

  await publish({
    kind: 'repo.index.started',
    ts: now(),
    streamId,
    data: {
      repoId: input.repoId,
      mode: input.mode,
    } satisfies RepoIndexStartedPayload,
  })

  try {
    await runAnalyze({
      descriptor,
      sourceDir,
      mode: input.mode,
      onLine: async (line) => {
        await publish({
          kind: 'repo.index.progress',
          ts: now(),
          streamId,
          data: {
            repoId: input.repoId,
            line,
          } satisfies RepoIndexProgressPayload,
        })
      },
    })

    const summary = await readIndexSummary(sourceDir)
    if (!summary) {
      // exit=0 from gitnexus analyze should always leave a parseable
      // meta.json. If it doesn't, treat the run as a failure — the
      // UI has nothing useful to show otherwise.
      throw new Error(
        `gitnexus analyze exited 0 but meta.json is missing or malformed at ${sourceDir}`,
      )
    }

    await reposRepo.finishIndex(db, row.id, {
      status: 'ready',
      indexedAt: new Date(summary.indexedAt),
    })

    const durationMs = Date.now() - startedAt
    await publish({
      kind: 'repo.index.ok',
      ts: Date.now(),
      streamId,
      data: {
        repoId: row.id,
        durationMs,
        summary,
      } satisfies RepoIndexOkPayload,
    })

    return {
      repoId: row.id,
      status: 'ready',
      durationMs,
    }
  } catch (err) {
    const message = errMsg(err)
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: row.id,
      lastError: message,
    })
    throw new Error(message)
  }
}

export interface IndexRepoJobResult {
  readonly repoId: string
  readonly status: 'ready' | 'error'
  readonly durationMs: number
  readonly lastError?: string
}

// ─── gitnexus analyze plumbing ────────────────────────────────────────────

interface RunAnalyzeArgs {
  readonly descriptor: RepoDirDescriptor
  readonly sourceDir: string
  readonly mode: RepoIndexMode
  readonly onLine: (line: string) => Promise<void> | void
}

/**
 * Build the `gitnexus analyze` argv and spawn it. Defaults are hostile to
 * pollution:
 *   - `--skip-agents-md` so gitnexus doesn't mutate `AGENTS.md`/`CLAUDE.md`
 *     inside the cloned source tree. A future re-clone would overwrite
 *     them anyway, but the noise is annoying.
 *   - `--no-stats` belts-and-braces: even if someone drops `--skip-agents-md`,
 *     no volatile counts land in those files.
 *   - `--name <repoDirName>` anchors the registry entry to our slug-keyed
 *     directory name. Two repos that share a basename (e.g. two agents both
 *     attaching `monorepo/app`) get distinct registry aliases.
 *   - `-f` on reindex so stale KuzuDB migration paths fully rebuild.
 */
async function runAnalyze(args: RunAnalyzeArgs): Promise<void> {
  const { descriptor, sourceDir, mode, onLine } = args

  const gitnexusArgs = [
    'analyze',
    sourceDir,
    '--skip-agents-md',
    '--no-stats',
    '--name',
    repoDirName(descriptor),
  ]
  if (mode === 'reindex') {
    gitnexusArgs.push('-f')
  }

  const child = runGitnexus(gitnexusArgs, {
    fromModuleUrl: import.meta.url,
    cwd: sourceDir,
    allowHostHome: false,
    stdio: 'pipe',
  })

  // Gitnexus writes its cli-progress bar and most log messages to stderr;
  // stdout is usually empty for `analyze` but we tail both so nothing falls
  // on the floor.
  const streamStderr = readLineByLine(child.stderr, onLine)
  const streamStdout = readLineByLine(child.stdout, onLine)

  const [code] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    }),
    streamStderr,
    streamStdout,
  ])

  if (code !== 0) {
    throw new GitnexusAnalyzeError(
      `gitnexus analyze exited with code ${code}`,
      code,
    )
  }
}

class GitnexusAnalyzeError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'GitnexusAnalyzeError'
  }
}

// ─── stream + terminal helpers ────────────────────────────────────────────

/**
 * Line-buffer a stream, invoking `sink` once per logical line. Shared
 * shape with the clone worker — gitnexus uses the same `\r`-based
 * progress bar approach as git, so the same split pattern applies.
 */
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

async function failAndPublish(args: {
  publish: (event: RunEvent) => Promise<number>
  db: ReturnType<typeof getDb>
  streamId: string
  repoId: string
  lastError: string
}): Promise<void> {
  const { publish, db, streamId, repoId, lastError } = args
  await reposRepo.finishIndex(db, repoId, {
    status: 'error',
    lastError,
  })
  await publish({
    kind: 'repo.index.fail',
    ts: Date.now(),
    streamId,
    data: {
      repoId,
      message: lastError,
    } satisfies RepoIndexFailPayload,
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
