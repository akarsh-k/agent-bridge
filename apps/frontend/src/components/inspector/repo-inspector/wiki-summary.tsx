/**
 * WikiSummary — compact strip rendered when a wiki has ever been
 * generated. Shows pages count, generated-at relative timestamp, and
 * a "Open wiki" link to the bundled `index.html` (served by the backend's
 * `repo-wiki-static` router).
 *
 * No-op when `wikiStatus === 'none'` — the parent decides whether to
 * render anything in that case.
 */

import type { RepoResponse } from '@agent-bridge/shared'
import { repoWikiViewerUrl } from '../../../lib/rpc'

export interface WikiSummaryProps {
  repo: RepoResponse
}

export function WikiSummary({ repo }: WikiSummaryProps) {
  // The wiki on disk is only meaningfully linkable on `ready` (or `error`
  // following a prior `ready` run, where the previous artefacts survive).
  // `generating` and `none` should not surface a link.
  const hasArtefact =
    (repo.wikiStatus === 'ready' || repo.wikiStatus === 'error') &&
    repo.wikiGeneratedAt !== null

  return (
    <div className="wiki-summary">
      <div className="wiki-summary-meta">
        {repo.wikiGeneratedAt ? (
          <span className="wiki-summary-ago">
            generated {formatRelative(repo.wikiGeneratedAt)}
          </span>
        ) : (
          <span className="wiki-summary-ago muted">never generated</span>
        )}
        {repo.wikiPages !== null && repo.wikiPages !== undefined ? (
          <span className="wiki-summary-pages">
            {repo.wikiPages} {repo.wikiPages === 1 ? 'page' : 'pages'}
          </span>
        ) : null}
      </div>
      {hasArtefact ? (
        <a
          className="btn btn-ghost btn-sm wiki-open-button"
          href={repoWikiViewerUrl(repo.id)}
          target="_blank"
          rel="noreferrer"
        >
          Open wiki
        </a>
      ) : null}
      {repo.wikiLastError ? (
        <div className="status-strip error wiki-summary-error" role="alert">
          {repo.wikiLastError}
        </div>
      ) : null}
    </div>
  )
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
