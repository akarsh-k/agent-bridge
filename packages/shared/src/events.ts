import { z } from 'zod'
import type { RepoIndexSummary } from './domain.js'

/**
 * Shared SSE event envelope. Backend emits these on `/api/events/:streamId`;
 * frontend consumes them verbatim.
 *
 * Browser-safe.
 */

export const runEventKinds = [
  'run.started',
  'run.token',
  'run.step.started',
  'run.step.finished',
  'run.tool.called',
  'run.tool.result',
  'run.error',
  'run.finished',
  'worker.progress',
  'worker.log',
  'worker.finished',
  'worker.error',
  'repo.clone.started',
  'repo.clone.progress',
  'repo.clone.ok',
  'repo.clone.fail',
  'repo.index.started',
  'repo.index.progress',
  'repo.index.ok',
  'repo.index.fail',
  'ping',
] as const

export type RunEventKind = (typeof runEventKinds)[number]

export const runEventSchema = z.object({
  kind: z.enum(runEventKinds),
  ts: z.number().int(),
  streamId: z.string().min(1),
  data: z.unknown().optional(),
})

export type RunEvent = z.infer<typeof runEventSchema>

/** Format an event object as a single SSE frame. */
export function formatSseFrame(event: RunEvent): string {
  const payload = JSON.stringify(event)
  return `event: ${event.kind}\ndata: ${payload}\n\n`
}

// ─── `repo.clone.*` payload shapes ────────────────────────────────────────
//
// Typed payloads for the four new clone events. Not part of the SSE envelope
// validation (`runEventSchema.data` is `unknown`); used by producers +
// consumers that want compile-time safety on the payload.

export interface RepoCloneStartedPayload {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
}

/**
 * One git progress line, forwarded verbatim (after secret redaction).
 * Git emits these to stderr — e.g. "Receiving objects: 42% (210/500)".
 */
export interface RepoCloneProgressPayload {
  readonly repoId: string
  readonly line: string
}

export interface RepoCloneOkPayload {
  readonly repoId: string
  readonly localPath: string
  readonly durationMs: number
}

export interface RepoCloneFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

// ─── `repo.index.*` payload shapes ────────────────────────────────────────
//
// The index pipeline publishes on the same `repo:<id>` stream as the clone
// pipeline — the frontend can render a continuous timeline from "cloning"
// through "indexing" in a single log component. `mode` lets the UI choose
// between "Indexing…" (initial) and "Re-indexing…" banners without the
// worker caring about copy.

/**
 * `mode` mirrors the `IndexRepoJob.mode` discriminant:
 *   - `initial`  — first analyze pass, auto-enqueued by the clone worker
 *   - `reindex`  — manual re-run from the UI (force-refresh or retry-after-error)
 */
export type RepoIndexMode = 'initial' | 'reindex'

export interface RepoIndexStartedPayload {
  readonly repoId: string
  readonly mode: RepoIndexMode
}

/**
 * One line of gitnexus stdout/stderr, forwarded verbatim after redaction.
 * gitnexus uses `cli-progress` which emits `\r`-terminated updates — the
 * worker splits on both `\r` and `\n` so the log stays readable.
 */
export interface RepoIndexProgressPayload {
  readonly repoId: string
  readonly line: string
}

export interface RepoIndexOkPayload {
  readonly repoId: string
  readonly durationMs: number
  readonly summary: RepoIndexSummary
}

export interface RepoIndexFailPayload {
  readonly repoId: string
  readonly message: string
  readonly exitCode?: number
}

/** Build the SSE `streamId` for per-repo clone + index progress. */
export function repoStreamId(repoId: string): string {
  return `repo:${repoId}`
}
