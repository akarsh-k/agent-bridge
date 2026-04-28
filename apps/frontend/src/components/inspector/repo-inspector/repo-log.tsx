/**
 * RepoLog — tails `/api/events/repo:<id>` and renders the live clone +
 * index progress as a compact terminal-ish pane. Also triggers a targeted
 * `workspace.refreshRepo(repoId)` when a terminal (`.ok` / `.fail`) event
 * arrives so the server's authoritative status + summary replaces any
 * optimistic "cloning" / "indexing" guess.
 *
 * Event model: only `repo.clone.*` and `repo.index.*` kinds render. The
 * generic `ping` / `run.*` events are silently ignored so the pane stays
 * scoped to this repo's pipeline even on a noisy Redis.
 *
 * Rendering:
 *   - started / ok / fail appear as full-width banner rows.
 *   - progress lines appear as monospace rows, auto-scrolling to the
 *     bottom so the latest output is always visible.
 *
 * This replaces the old clone-only `CloneLog`; behaviour is identical for
 * clone events, extended for index events on the same channel.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { RepoResponse, RunEvent } from '@agent-bridge/shared'
import { useSSE } from '../../../lib/use-sse'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

export interface RepoLogProps {
  repo: RepoResponse
  workspace: WorkspaceContextValue
}

export function RepoLog({ repo, workspace }: RepoLogProps) {
  const streamId = useMemo(() => `repo:${repo.id}`, [repo.id])
  const { connected, events } = useSSE(streamId, { cap: 400 })

  // Filter to just this repo's pipeline traffic. Arrive in chronological
  // order; we render newest at the bottom (like a terminal).
  const pipelineEvents = useMemo(
    () =>
      events.filter(
        (e) =>
          e.kind.startsWith('repo.clone.') || e.kind.startsWith('repo.index.'),
      ),
    [events],
  )

  // When a terminal event arrives, pull the canonical row (including the
  // updated indexSummary) so the inspector / canvas flip out of the
  // optimistic state. Guard against dup-fires — a stream reopen can
  // replay the last frame.
  const lastRefreshedTsRef = useRef<number>(0)
  useEffect(() => {
    const terminal =
      pipelineEvents.findLast?.((e) => isTerminal(e)) ??
      findLast(pipelineEvents, isTerminal)
    if (!terminal) return
    if (terminal.ts <= lastRefreshedTsRef.current) return
    lastRefreshedTsRef.current = terminal.ts
    void workspace.refreshRepo(repo.id)
  }, [pipelineEvents, repo.id, workspace])

  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [pipelineEvents.length])

  return (
    <div className="repo-log">
      <div className="repo-log-header">
        <span
          className={`repo-log-dot${connected ? ' live' : ''}`}
          aria-hidden="true"
        />
        <span className="repo-log-title">
          {connected ? 'Live' : 'Connecting…'}
          <span className="muted"> · {streamId}</span>
        </span>
      </div>

      <div className="repo-log-pane" ref={paneRef}>
        {pipelineEvents.length === 0 ? (
          <div className="repo-log-empty">{emptyHint(repo.status)}</div>
        ) : (
          pipelineEvents.map((event, i) => (
            <RepoLogRow key={`${event.ts}-${i}`} event={event} />
          ))
        )}
      </div>
    </div>
  )
}

function emptyHint(status: RepoResponse['status']): string {
  switch (status) {
    case 'cloning':
      return 'Waiting for the worker to pick up the clone job…'
    case 'indexing':
      return 'Waiting for the worker to pick up the index job…'
    case 'pending':
      return 'No output yet. Hit "Clone" to stream progress here.'
    default:
      return 'No output yet. Progress will stream here on the next run.'
  }
}

function RepoLogRow({ event }: { event: RunEvent }) {
  switch (event.kind) {
    case 'repo.clone.started':
      return (
        <div className="repo-log-row banner">
          <span className="repo-log-kind">clone</span>
          <span>{describeCloneStarted(event)}</span>
        </div>
      )
    case 'repo.clone.progress':
      return <ProgressRow event={event} />
    case 'repo.clone.ok':
      return (
        <div className="repo-log-row banner ok">
          <span className="repo-log-kind ok">cloned</span>
          <span>{describeCloneOk(event)}</span>
        </div>
      )
    case 'repo.clone.fail':
      return (
        <div className="repo-log-row banner err">
          <span className="repo-log-kind err">clone failed</span>
          <span>{describeFail(event)}</span>
        </div>
      )
    case 'repo.index.started':
      return (
        <div className="repo-log-row banner">
          <span className="repo-log-kind">index</span>
          <span>{describeIndexStarted(event)}</span>
        </div>
      )
    case 'repo.index.progress':
      return <ProgressRow event={event} />
    case 'repo.index.ok':
      return (
        <div className="repo-log-row banner ok">
          <span className="repo-log-kind ok">indexed</span>
          <span>{describeIndexOk(event)}</span>
        </div>
      )
    case 'repo.index.fail':
      return (
        <div className="repo-log-row banner err">
          <span className="repo-log-kind err">index failed</span>
          <span>{describeFail(event)}</span>
        </div>
      )
    default:
      return null
  }
}

function ProgressRow({ event }: { event: RunEvent }) {
  const line = describeProgress(event)
  if (!line) return null
  return (
    <div className="repo-log-row mono">
      <span className="repo-log-line">{line}</span>
    </div>
  )
}

function isTerminal(e: RunEvent): boolean {
  return (
    e.kind === 'repo.clone.ok' ||
    e.kind === 'repo.clone.fail' ||
    e.kind === 'repo.index.ok' ||
    e.kind === 'repo.index.fail'
  )
}

// `Array.prototype.findLast` is ES2023. Polyfill for older TS lib configs
// so we don't force a `lib` bump for one call site.
function findLast<T>(
  arr: readonly T[],
  pred: (v: T) => boolean,
): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]!
    if (pred(v)) return v
  }
  return undefined
}

// ─── payload renderers ────────────────────────────────────────────────────
// `event.data` arrives as `unknown` (the envelope doesn't carry a payload
// schema). Structural checks keep a stray shape from crashing the pane.

function describeCloneStarted(event: RunEvent): string {
  const d = event.data as
    | { remoteUrl?: string; branch?: string }
    | null
    | undefined
  if (d?.remoteUrl && d.branch) {
    return `git clone ${d.remoteUrl} (branch ${d.branch})`
  }
  return 'git clone'
}

function describeProgress(event: RunEvent): string | null {
  const d = event.data as { line?: string } | null | undefined
  if (typeof d?.line === 'string') {
    const line = stripTerminalControlCodes(d.line).trimEnd()
    return line.length ? line : null
  }
  return '(no output)'
}

function stripTerminalControlCodes(value: string): string {
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  const csiPattern = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const oscPattern = new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, 'g')

  return value
    .replace(csiPattern, '')
    .replace(oscPattern, '')
    .replace(/\r/g, '')
}

function describeCloneOk(event: RunEvent): string {
  const d = event.data as
    | { localPath?: string; durationMs?: number }
    | null
    | undefined
  const ms =
    typeof d?.durationMs === 'number' ? ` · ${formatMs(d.durationMs)}` : ''
  const path = typeof d?.localPath === 'string' ? ` · ${d.localPath}` : ''
  return `clone succeeded${ms}${path}`
}

function describeIndexStarted(event: RunEvent): string {
  const d = event.data as { mode?: string } | null | undefined
  return d?.mode === 'reindex'
    ? 'gitnexus analyze (re-index)'
    : 'gitnexus analyze'
}

function describeIndexOk(event: RunEvent): string {
  const d = event.data as
    | {
        durationMs?: number
        summary?: {
          files?: number | null
          nodes?: number | null
          edges?: number | null
        }
      }
    | null
    | undefined
  const ms =
    typeof d?.durationMs === 'number' ? ` · ${formatMs(d.durationMs)}` : ''
  const parts: string[] = []
  if (typeof d?.summary?.files === 'number')
    parts.push(`${d.summary.files} files`)
  if (typeof d?.summary?.nodes === 'number')
    parts.push(`${d.summary.nodes} nodes`)
  if (typeof d?.summary?.edges === 'number')
    parts.push(`${d.summary.edges} edges`)
  const stats = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  return `index succeeded${ms}${stats}`
}

function describeFail(event: RunEvent): string {
  const d = event.data as { message?: string } | null | undefined
  return typeof d?.message === 'string' ? d.message : 'operation failed'
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s}s`
}
