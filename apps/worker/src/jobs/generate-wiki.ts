import { promises as fs } from 'node:fs'
import type { Job } from 'bullmq'

import { llmProvidersRepo, reposRepo } from '@agent-bridge/db'
import {
  generateWikiJobSchema,
  redactSecrets,
  repoStreamId,
  type LlmProviderKind,
  type RepoWikiFailPayload,
  type RepoWikiMode,
  type RepoWikiOkPayload,
  type RepoWikiProgressPayload,
  type RepoWikiStartedPayload,
  type RunEvent,
} from '@agent-bridge/shared'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import { runGitnexus } from '@agent-bridge/shared/gitnexus'
import {
  repoSourceDir,
  type RepoDirDescriptor,
} from '@agent-bridge/shared/paths'

import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'

/**
 * Sandboxed `gitnexus wiki` with live progress SSE. The wiki output lives
 * under `<source>/.gitnexus/wiki/` (gitnexus's default storagePath) — we
 * do NOT redirect it elsewhere. The original Plan.md said
 * `.agent-bridge-data/workspace/<agent>/<repo>/wiki/` but per-agent
 * doesn't make sense for a repo-derived artifact and fights gitnexus's
 * default; co-locating with `meta.json` keeps the on-disk layout simple.
 *
 * Flow per job:
 *   1. Validate the BullMQ payload (Zod).
 *   2. Re-fetch the repo row (need `localPath` + status='ready' + wiki_status='generating').
 *   3. Re-fetch the LLM provider row; decrypt the apiKey envelope into a local var.
 *   4. Spawn `gitnexus wiki <sourceDir> --provider <p> --base-url <u>
 *      --api-key <k> --model <m> --concurrency 3 --no-reasoning-model
 *      [--force]`. Sandbox 'default' with `allowHostHome: false` so the
 *      saved-config pollution lands in the isolated `gitnexus-home/`.
 *   5. Stream stdout+stderr → `repo.wiki.progress` events, one per line,
 *      redacted against the apiKey plaintext. While streaming, parse
 *      `Pages: N` and `Mode: X` lines for the success payload — gitnexus
 *      doesn't write these to a meta file, only to stdout, so we can't
 *      defer parsing to a post-success disk read.
 *   6. On exit=0: `finishWiki(ready)` with the stamped `wikiGeneratedAt`
 *      + parsed `pages`. The `up-to-date` no-op path leaves `pages` null
 *      (no fresh count emitted).
 *   7. On exit≠0: `finishWiki(error)` with the redacted message; the
 *      previous `wiki_generated_at` and `wiki_pages` columns are NOT
 *      touched (the prior wiki on disk is still readable, so its summary
 *      stays meaningful for the UI).
 *
 * Secret discipline mirrors `clone-repo.ts`'s PAT handling:
 *   - The apiKey envelope stays in the DB; the plaintext lives only in a
 *     local variable + the spawned child's argv (gitnexus accepts it as
 *     a CLI flag, which is unavoidable — no env-var fallback).
 *   - Every published `repo.wiki.progress` line is scrubbed against the
 *     plaintext before it reaches Redis or the SSE bus.
 *   - The thrown error message on failure is also scrubbed before BullMQ
 *     gets it (the admin UI exposes it).
 *
 * Caveat: passing `--api-key` to gitnexus persists the value in
 * `~/.gitnexus/config.json` — fine for us because the HOME clamp pins
 * that to `.agent-bridge-data/gitnexus-home/`, but worth flagging if
 * the sandbox posture ever changes.
 */

export async function handleGenerateWikiJob(
  job: Job<unknown, GenerateWikiJobResult>,
): Promise<GenerateWikiJobResult> {
  const input = generateWikiJobSchema.parse(job.data)
  const startedAt = Date.now()

  const streamId = repoStreamId(input.repoId)
  const bus = getEventBus()
  const db = getDb()

  const publish = (event: RunEvent): Promise<number> => bus.publish(event)
  const now = (): number => Date.now()

  // Re-fetch the row inside the worker. Backend already CAS-flipped
  // wiki_status to 'generating' — we still validate so a job that
  // somehow dequeued against a wrong state fails fast with a readable
  // error instead of running gitnexus against an unindexed source.
  const row = await reposRepo.getForWorker(db, input.repoId)
  if (!row) {
    const message = `Repo ${input.repoId} was deleted before the wiki job ran`
    await publish({
      kind: 'repo.wiki.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoWikiFailPayload,
    })
    throw new Error(message)
  }

  if (row.wikiStatus !== 'generating') {
    const message =
      `Repo ${input.repoId} wiki_status is '${row.wikiStatus}', expected ` +
      `'generating' (the backend should CAS the row before enqueue)`
    await publish({
      kind: 'repo.wiki.fail',
      ts: now(),
      streamId,
      data: {
        repoId: input.repoId,
        message,
      } satisfies RepoWikiFailPayload,
    })
    throw new Error(message)
  }

  if (row.status !== 'ready' || !row.localPath) {
    const message =
      `Repo ${input.repoId} is not ready for wiki generation ` +
      `(status='${row.status}', localPath=${row.localPath ? 'set' : 'null'})`
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      lastError: message,
    })
    throw new Error(message)
  }

  // Resolve the LLM provider row separately so the dispatcher route +
  // worker can both share the (apiKey, baseUrl, model, kind) tuple via
  // the same fetch shape. We don't go through `agents` because wiki gen
  // is a per-repo concern, not per-agent.
  const providerRow = await llmProvidersRepo.getForWorker(
    db,
    input.llmProviderId,
  )
  if (!providerRow) {
    const message = `LLM provider ${input.llmProviderId} was deleted before the wiki job ran`
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: input.repoId,
      lastError: message,
    })
    throw new Error(message)
  }

  // Decrypt only after we've confirmed the row exists; never persist the
  // plaintext beyond this scope. Local-no-auth providers may have a null
  // envelope — gitnexus refuses to start without an apiKey, so we send a
  // benign placeholder. Local servers that don't validate (ollama,
  // llama.cpp) accept any string; servers that DO validate will return a
  // 401 which surfaces cleanly via gitnexus's stderr.
  const apiKey = providerRow.apiKeyEnvelope
    ? decryptSecret(providerRow.apiKeyEnvelope)
    : 'no-auth-required'

  const redactList: readonly string[] = providerRow.apiKeyEnvelope
    ? [apiKey]
    : []

  const baseUrl = resolveBaseUrl(providerRow.kind, providerRow.baseUrl)
  // The backend resolved the effective model (override-or-default) and
  // wrote it onto the job payload, so the worker just trusts the value.
  // The Zod schema on `generateWikiJobSchema` requires a non-empty
  // string, so by this point we have a usable model id; defensive
  // re-check is dropped — empty would have failed `parse(job.data)`.
  const model = input.model

  const descriptor: RepoDirDescriptor = {
    id: row.id,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
  }
  const sourceDir = repoSourceDir(descriptor)

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
    kind: 'repo.wiki.started',
    ts: now(),
    streamId,
    data: {
      repoId: input.repoId,
      mode: input.mode,
      providerKind: providerRow.kind,
    } satisfies RepoWikiStartedPayload,
  })

  // Stdout-derived state — we parse `Pages: N` and `Mode: X` from the
  // tail summary as it streams by, so the success path doesn't need a
  // post-exit scan. Gitnexus prints these AFTER all progress lines, so
  // by the time exit=0 lands we always have whatever the run produced.
  let parsedPages: number | null = null
  let parsedResultMode: string | null = null

  try {
    await runWiki({
      sourceDir,
      mode: input.mode,
      provider: mapProvider(providerRow.kind),
      baseUrl,
      apiKey,
      model,
      onLine: async (line) => {
        const cleaned = redactSecrets(line, redactList)
        // Capture summary fields. Gitnexus emits them as the very last
        // few stdout lines; checking every line costs a regex per line
        // and keeps the parser local to the handler.
        const pagesMatch = /^\s*Pages:\s*(\d+)\s*$/i.exec(cleaned)
        if (pagesMatch && pagesMatch[1]) {
          const n = Number.parseInt(pagesMatch[1], 10)
          if (Number.isFinite(n)) parsedPages = n
        }
        const modeMatch = /^\s*Mode:\s*(\S+)\s*$/i.exec(cleaned)
        if (modeMatch && modeMatch[1]) {
          parsedResultMode = modeMatch[1]
        }
        await publish({
          kind: 'repo.wiki.progress',
          ts: now(),
          streamId,
          data: {
            repoId: input.repoId,
            line: cleaned,
          } satisfies RepoWikiProgressPayload,
        })
      },
    })

    // up-to-date short-circuit: gitnexus exits 0 without emitting fresh
    // counts. Leave `parsedPages` as null (the DB column nulls out for
    // this run) but stamp `wikiGeneratedAt` so the UI shows a fresh
    // verification time even when nothing was rebuilt.
    const generatedAt = new Date()
    await reposRepo.finishWiki(db, row.id, {
      status: 'ready',
      generatedAt,
      pages: parsedPages,
    })

    const durationMs = Date.now() - startedAt
    await publish({
      kind: 'repo.wiki.ok',
      ts: Date.now(),
      streamId,
      data: {
        repoId: row.id,
        durationMs,
        mode: input.mode,
        pages: parsedPages,
        resultMode: parsedResultMode,
      } satisfies RepoWikiOkPayload,
    })

    return {
      repoId: row.id,
      status: 'ready',
      durationMs,
      pages: parsedPages,
    }
  } catch (err) {
    const rawMessage = errMsg(err)
    const message = redactSecrets(rawMessage, redactList)
    await failAndPublish({
      publish,
      db,
      streamId,
      repoId: row.id,
      lastError: message,
    })
    // BullMQ admin UI shows the thrown error; keep it redacted too.
    throw new Error(message)
  }
}

export interface GenerateWikiJobResult {
  readonly repoId: string
  readonly status: 'ready' | 'error'
  readonly durationMs: number
  readonly pages?: number | null
  readonly lastError?: string
}

// ─── gitnexus wiki plumbing ───────────────────────────────────────────────

interface RunWikiArgs {
  readonly sourceDir: string
  readonly mode: RepoWikiMode
  readonly provider: GitnexusProvider
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly onLine: (line: string) => Promise<void> | void
}

async function runWiki(args: RunWikiArgs): Promise<void> {
  const { sourceDir, mode, provider, baseUrl, apiKey, model, onLine } = args

  const gitnexusArgs = [
    'wiki',
    sourceDir,
    '--provider',
    provider,
    '--base-url',
    baseUrl,
    '--api-key',
    apiKey,
    '--model',
    model,
    // Default 3 matches gitnexus's own default. Explicit so a future
    // bump in the CLI doesn't silently change our throughput.
    '--concurrency',
    '3',
    // Defensive: a stale `~/.gitnexus/config.json` may have flipped
    // reasoning-model on for a previous run. We never want it on for
    // the auto-generated wiki — strip-temperature semantics break our
    // default-tuned models.
    '--no-reasoning-model',
  ]
  if (mode === 'force') {
    gitnexusArgs.push('--force')
  }

  const child = runGitnexus(gitnexusArgs, {
    fromModuleUrl: import.meta.url,
    cwd: sourceDir,
    allowHostHome: false,
    stdio: 'pipe',
  })

  // Gitnexus wiki uses cli-progress on stdout (NOT stderr like analyze)
  // for its phase bar and emits the final summary lines on stdout too.
  // We tail both for safety.
  const streamStdout = readLineByLine(child.stdout, onLine)
  const streamStderr = readLineByLine(child.stderr, onLine)

  const [code] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    }),
    streamStdout,
    streamStderr,
  ])

  if (code !== 0) {
    throw new GitnexusWikiError(
      `gitnexus wiki exited with code ${code}`,
      code,
    )
  }
}

class GitnexusWikiError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'GitnexusWikiError'
  }
}

// ─── provider + baseUrl mapping ───────────────────────────────────────────

/**
 * Gitnexus's `LLMProvider` enum is `'openai' | 'openrouter' | 'azure' |
 * 'custom' | 'cursor'`. Our DB's `LlmProviderKind` is the OpenAI-compat
 * superset (`openai | llama_cpp | ollama | openai_compatible`). We only
 * need a 1:1 mapping for the OpenAI vendor case — every other kind
 * routes through gitnexus's `'custom'` path which is the generic
 * OpenAI-compat client and works for both vendor proxies (LiteLLM,
 * OpenRouter behind a `baseUrl`) and local servers (ollama, llama.cpp).
 */
type GitnexusProvider = 'openai' | 'custom'

function mapProvider(kind: LlmProviderKind): GitnexusProvider {
  return kind === 'openai' ? 'openai' : 'custom'
}

const VENDOR_DEFAULT_BASE_URL: Partial<Record<LlmProviderKind, string>> = {
  openai: 'https://api.openai.com',
}

/**
 * Mirrors `packages/agents/src/build-agent.ts`:`resolveBaseUrl`. Centralising
 * here would mean a circular dependency between `packages/agents` and
 * `apps/worker`; the duplication is two lines and the contract is stable.
 */
function resolveBaseUrl(
  kind: LlmProviderKind,
  storedBaseUrl: string | null,
): string {
  const raw = storedBaseUrl ?? VENDOR_DEFAULT_BASE_URL[kind] ?? null
  if (!raw) {
    throw new Error(
      `[generateWiki] Provider kind "${kind}" requires a base URL and none was stored.`,
    )
  }
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

// ─── stream + terminal helpers ────────────────────────────────────────────

/**
 * Line-buffer a stream, invoking `sink` once per logical line. Same
 * shape as the clone + index workers — gitnexus uses `cli-progress` which
 * ships `\r`-terminated phase updates, so we split on both `\r` and `\n`.
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
  await reposRepo.finishWiki(db, repoId, {
    status: 'error',
    lastError,
  })
  await publish({
    kind: 'repo.wiki.fail',
    ts: Date.now(),
    streamId,
    data: {
      repoId,
      message: lastError,
    } satisfies RepoWikiFailPayload,
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
