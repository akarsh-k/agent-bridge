import { promises as fs } from 'node:fs'
import type { Job } from 'bullmq'

import { llmProvidersRepo, reposRepo, workerJobsRepo } from '@agent-bridge/db'
import type { LlmProviderRow } from '@agent-bridge/db/schema'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  EmbedderProbeError,
  buildEmbedderProbeArgs,
  probeEmbedder,
} from '@agent-bridge/shared/embedder-probe'
import {
  indexRepoJobSchema,
  redactSecrets,
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
import { makeProgressThrottle } from './progress-throttle.js'

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

  // `jobId` is set after the repo-existence + state checks pass.
  // Until then `publish` is publish-only (no FK target). After,
  // every event ALSO appends to `worker_events` so the /logs page
  // can replay this attempt's full timeline. See clone-repo.ts for
  // the same pattern with the same fail-soft policy.
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
          `[index-repo] failed to audit ${event.kind} for job ${jobId}: ${errMsg(err)}`,
        )
      }
    }
    return subscribers
  }
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

  // Repo + status checks passed — create the lifecycle row so all
  // subsequent events are auditable.
  try {
    const jobRow = await workerJobsRepo.createWorkerJob(db, {
      repoId: input.repoId,
      jobKind: 'index',
    })
    jobId = jobRow.id
  } catch (err) {
    console.warn(
      `[index-repo] failed to create worker_jobs row for repo ${input.repoId}: ${errMsg(err)}`,
    )
  }

  if (!row.localPath) {
    const message = `Repo ${input.repoId} has no localPath — clone must land before index`
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      lastError: message,
      jobId,
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
      jobId,
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

  // Resolve the workspace embedding provider so gitnexus's
  // `--embeddings` pipeline routes to the configured embedder. Missing
  // provider is non-fatal here — gitnexus falls back to its own local
  // embedder. The agent-side build is what enforces "must have an
  // embedding provider when repos are attached"; the worker's indexing
  // is a workspace-level operation that can run before any agent owns
  // the repo.
  const embeddingProvider = await llmProvidersRepo.getEmbeddingProvider(db)
  const embeddingApiKey = embeddingProvider?.apiKeyEnvelope
    ? decryptSecret(embeddingProvider.apiKeyEnvelope)
    : null
  const embeddingEnv = buildEmbeddingEnv(embeddingProvider, embeddingApiKey)
  const redactList: readonly string[] = embeddingApiKey ? [embeddingApiKey] : []

  if (embeddingProvider) {
    // Defence-in-depth probe. The HTTP routes already probe at clone /
    // pull / index start, but the embedder could have gone down between
    // enqueue and dequeue. Catching it here gives the operator a clear
    // "Embedding server is unreachable" message + remediation instead
    // of a cryptic gitnexus stderr line minutes into the analyze pass.
    const probeArgs = buildEmbedderProbeArgs({
      kind: embeddingProvider.kind,
      baseUrl: embeddingProvider.baseUrl,
      defaultModel: embeddingProvider.defaultModel,
      apiKey: embeddingApiKey,
    })
    if (probeArgs) {
      try {
        await probeEmbedder(probeArgs)
      } catch (err) {
        if (!(err instanceof EmbedderProbeError)) throw err
        const lastError =
          `Embedding server is unreachable at ${probeArgs.baseUrl}/embeddings: ` +
          `${err.message}. ` +
          (err.kind === 'auth'
            ? 'Check the API key in Settings → Providers.'
            : err.kind === 'bad_model'
              ? `Model "${probeArgs.model}" not recognised by the server.`
              : err.kind === 'timeout'
                ? "Embedder didn't respond in time."
                : 'Start the embedding server or update the provider URL.')
        await publish({
          kind: 'repo.embed.fail',
          ts: now(),
          streamId,
          data: {
            repoId: input.repoId,
            message: lastError,
          },
        })
        await failAndPublish({
          publish,
          db,
          streamId,
          repoId: input.repoId,
          lastError,
          jobId,
        })
        throw new Error(lastError)
      }
    }

    await publish({
      kind: 'repo.embed.started',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        providerKind: embeddingProvider.kind,
        model: embeddingProvider.defaultModel ?? '(unset)',
      },
    })
  }

  // Capture the most recent meaningful error line gitnexus prints. When
  // `analyze` exits non-zero, the bare `"exited with code N"` message
  // we surface as `lastError` is useless on the UI; the actionable
  // diagnosis (e.g. "Embedding dimension mismatch: endpoint returned
  // 1024d, expected 384d. Set GITNEXUS_EMBEDDING_DIMS=1024") is in
  // the line buffer that just scrolled past. We pattern-match for
  // gitnexus's known error markers and keep the latest. The catch
  // block below uses this when present.
  let capturedError: string | null = null
  // Coalesce progress events to ~1/sec. On a sqlalchemy-scale embed
  // gitnexus emits thousands of stderr lines; persisting + streaming
  // all of them is what made the repo-detail page laggy. Error
  // detection runs BEFORE the throttle check so the final error
  // message is captured even when the line itself is dropped.
  const progressThrottle = makeProgressThrottle()

  try {
    await runAnalyze({
      descriptor,
      sourceDir,
      mode: input.mode,
      force: input.force,
      embeddings: true,
      env: embeddingEnv,
      onLine: async (line) => {
        const cleaned = redactSecrets(line, redactList)
        if (looksLikeFatalLine(cleaned)) capturedError = cleaned
        if (!progressThrottle.shouldEmit()) return
        await publish({
          kind: 'repo.index.progress',
          ts: now(),
          streamId,
          data: {
            repoId: input.repoId,
            line: cleaned,
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
    if (embeddingProvider) {
      // Index + embed run in one process (`gitnexus analyze --embeddings`)
      // so a clean index exit also implies embeddings completed. We don't
      // get a separate file count from gitnexus, so leave `files: null`.
      await publish({
        kind: 'repo.embed.ok',
        ts: Date.now(),
        streamId,
        data: {
          repoId: row.id,
          durationMs,
          files: null,
        },
      })
    }

    if (jobId) {
      try {
        await workerJobsRepo.markWorkerJobFinished(db, jobId, {
          status: 'completed',
        })
      } catch (err) {
        console.warn(
          `[index-repo] failed to finalise job ${jobId}: ${errMsg(err)}`,
        )
      }
    }

    return {
      repoId: row.id,
      status: 'ready',
      durationMs,
    }
  } catch (err) {
    const rawMessage = errMsg(err)
    const message = redactSecrets(rawMessage, redactList)
    // Prefer the captured stderr line — it carries the actionable
    // diagnosis. Fall back to the bare exit-code message when no
    // recognisable error line scrolled past (genuine crash, OOM, etc.).
    const lastError = capturedError
      ? `${capturedError}\n\n(Exit: ${message})`
      : message
    if (embeddingProvider) {
      await publish({
        kind: 'repo.embed.fail',
        ts: Date.now(),
        streamId,
        data: {
          repoId: row.id,
          message: lastError,
          ...(err instanceof GitnexusAnalyzeError ? { exitCode: err.exitCode } : {}),
        },
      })
    }
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: row.id,
      lastError,
      jobId,
    })
    throw new Error(message)
  }
}

/**
 * Heuristic. is this stderr line gitnexus telling us something fatal
 * we want to surface to the operator? Patterns derived from gitnexus
 * 1.6.3 stderr conventions:
 *   - `❌ <category>: ...`   — gitnexus's own error marker
 *   - `Error: ...`            — generic Node error throw
 *   - `Embedding pipeline error` / `Embedding dimension mismatch` etc.
 *   - `failed:` / `unable to` — common failure phrasings
 *
 * False positives (a non-fatal line that matches) are mostly harmless —
 * the captured value is only consumed when the process EXITED non-zero,
 * so we'd surface a slightly stale-looking line. False negatives leave
 * the bare "exit code N" — same as before.
 */
function looksLikeFatalLine(line: string): boolean {
  if (line.length === 0) return false
  if (line.includes('❌')) return true
  if (/^\s*(Error|TypeError|RangeError|ReferenceError):/i.test(line)) return true
  if (/Embedding (pipeline error|dimension mismatch)/i.test(line)) return true
  if (/(failed|unable to|cannot)\b/i.test(line) && line.length < 400) return true
  return false
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
  /**
   * `true` → pass `-f / --force` to gitnexus, blowing away the existing
   * graph + embeddings store and rebuilding from scratch. `false` (default)
   * → rely on gitnexus's incremental analyze (only re-parses files whose
   * content/mtime changed). See `docs/ARCHITECTURE.md §10` D16/A5 — incremental is
   * the right default for "Update index"; force is the explicit "Rebuild
   * from scratch" gesture.
   */
  readonly force: boolean
  /**
   * `true` → pass `--embeddings` so gitnexus generates semantic vectors
   * alongside the graph (`docs/ARCHITECTURE.md §10`). The
   * `inspector/find_in_codebase` wrapper relies on `gitnexus_query`'s
   * hybrid BM25 + semantic + RRF retrieval, which only does the semantic
   * arm when embeddings are populated. Combined with `env` below, this
   * routes embedding generation through the workspace's chosen provider.
   */
  readonly embeddings: boolean
  /**
   * Extra env vars layered on top of the sandbox baseline. Used to pass
   * `GITNEXUS_EMBEDDING_*` so gitnexus's embedder calls the workspace
   * embedding provider's `/v1/embeddings` endpoint instead of the
   * default local embedder. Empty when no provider is configured.
   */
  readonly env: Record<string, string>
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
 *   - `-f` ONLY when the caller explicitly passes `force: true`. Gitnexus's
 *     `analyze` is already incremental ("indexes the codebase, OR updates
 *     stale index" per gitnexus 1.6.3 README) — every re-index click should
 *     re-use the existing index unless the operator explicitly asks to
 *     rebuild from scratch (`docs/ARCHITECTURE.md §10` D16/A5).
 */
async function runAnalyze(args: RunAnalyzeArgs): Promise<void> {
  const { descriptor, sourceDir, force, embeddings, env, onLine } = args

  const gitnexusArgs = [
    'analyze',
    sourceDir,
    '--skip-agents-md',
    '--no-stats',
    '--name',
    repoDirName(descriptor),
  ]
  if (force) {
    gitnexusArgs.push('-f')
  }
  if (embeddings) {
    gitnexusArgs.push('--embeddings')
  }

  const child = runGitnexus(gitnexusArgs, {
    fromModuleUrl: import.meta.url,
    cwd: sourceDir,
    allowHostHome: false,
    stdio: 'pipe',
    env,
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
  /** When set, marks the matching `worker_jobs` row as errored
   *  before the terminal event publishes. Best-effort. */
  jobId?: string | null
}): Promise<void> {
  const { publish, db, streamId, repoId, lastError, jobId } = args
  await reposRepo.finishIndex(db, repoId, {
    status: 'error',
    lastError,
  })
  if (jobId) {
    try {
      await workerJobsRepo.markWorkerJobFinished(db, jobId, {
        status: 'error',
        errorMessage: lastError,
      })
    } catch (err) {
      console.warn(
        `[index-repo] failed to finalise job ${jobId}: ${errMsg(err)}`,
      )
    }
  }
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

// ─── Embedding env builder ───────────────────────────────────────────────

/**
 * Vendor base URL fallbacks for `role='embedding'` providers. Same
 * approach as `generate-wiki.ts`: keep a small map here rather than
 * import across workspaces. New vendor kinds get added in lockstep
 * across the worker's index/wiki jobs and `packages/agents/build-agent.ts`.
 */
const EMBEDDING_VENDOR_BASE_URL: Partial<
  Record<NonNullable<LlmProviderRow['kind']>, string>
> = {
  openai: 'https://api.openai.com',
}

/**
 * Build the env dict to forward to `gitnexus analyze --embeddings`. Maps
 * the workspace embedding provider's `(baseUrl, defaultModel, apiKey,
 * embeddingDims)` tuple to the env vars gitnexus reads
 * (`GITNEXUS_EMBEDDING_*`, see gitnexus 1.6.3 README "Remote Embeddings").
 *
 * Empty dict when no provider is configured — gitnexus then uses its
 * built-in local embedder. Empty dict when the provider lacks a
 * `defaultModel` — telling gitnexus to use a model id we don't have
 * would just make the spawn fail with a confusing 400 from the upstream.
 *
 * The plaintext `apiKey` is the caller's responsibility to bind into a
 * redactor before logging anything; this function does not log.
 */
function buildEmbeddingEnv(
  provider: LlmProviderRow | null,
  apiKey: string | null,
): Record<string, string> {
  if (!provider || !provider.defaultModel) return {}

  const raw =
    provider.baseUrl ?? EMBEDDING_VENDOR_BASE_URL[provider.kind] ?? null
  if (!raw) return {}
  const trimmed = raw.replace(/\/+$/, '')
  const url = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`

  const env: Record<string, string> = {
    GITNEXUS_EMBEDDING_URL: url,
    GITNEXUS_EMBEDDING_MODEL: provider.defaultModel,
  }
  if (provider.embeddingDims != null) {
    env['GITNEXUS_EMBEDDING_DIMS'] = String(provider.embeddingDims)
  }
  if (apiKey) {
    env['GITNEXUS_EMBEDDING_API_KEY'] = apiKey
  }
  return env
}
