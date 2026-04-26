/**
 * IndexSummary — horizontal strip of count chips rendered under the repo
 * section once an index run has landed. Reads straight from the
 * authoritative `repo.indexSummary` field on the store (populated by
 * `toRepoResponse`, which reads `<source>/.gitnexus/meta.json` lazily on
 * the backend via `@agent-bridge/shared/gitnexus`:`readIndexSummary`).
 *
 * When the row is null we render nothing — the caller decides whether to
 * show a "not indexed yet" placeholder; that decision belongs upstream
 * with the status badge.
 *
 * Chips show the primary stats (files/nodes/edges/communities). Rarer
 * fields (processes/embeddings) render only when present so the strip
 * stays compact. `indexedAt` is rendered in small muted text alongside
 * the chips.
 */

import type { RepoIndexSummary } from '@agent-bridge/shared'

export interface IndexSummaryProps {
  summary: RepoIndexSummary
}

interface Chip {
  readonly label: string
  readonly value: number
}

export function IndexSummary({ summary }: IndexSummaryProps) {
  const chips: Chip[] = []
  pushChip(chips, 'files', summary.files)
  pushChip(chips, 'nodes', summary.nodes)
  pushChip(chips, 'edges', summary.edges)
  pushChip(chips, 'communities', summary.communities)
  pushChip(chips, 'processes', summary.processes)
  pushChip(chips, 'embeddings', summary.embeddings)

  return (
    <div className="index-summary">
      <div className="index-summary-meta">
        <span className="index-summary-ago">
          indexed {formatRelative(summary.indexedAt)}
        </span>
        {summary.indexedCommitSha ? (
          <span className="index-summary-sha mono">
            {summary.indexedCommitSha.slice(0, 7)}
          </span>
        ) : null}
      </div>
      {chips.length === 0 ? (
        <div className="index-summary-empty">
          Index ran but reported no counts.
        </div>
      ) : (
        <ul className="index-summary-chips" aria-label="Index statistics">
          {chips.map((chip) => (
            <li key={chip.label} className="index-summary-chip">
              <span className="index-summary-chip-value">
                {formatCount(chip.value)}
              </span>
              <span className="index-summary-chip-label">{chip.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function pushChip(chips: Chip[], label: string, value: number | null): void {
  if (value === null || value === undefined) return
  chips.push({ label, value })
}

function formatCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
