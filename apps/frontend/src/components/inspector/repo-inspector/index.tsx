/**
 * Repo inspector — read-only row summary + per-repo clone/index controls.
 *
 * Optimistic overlay: clicking Clone or Index flips the locally-rendered
 * status to `'cloning'` or `'indexing'` while the POST is in flight. The
 * overlay is tagged with the `updatedAt` of the row it was derived from;
 * any worker transition bumps `updated_at` (via `set_updated_at` trigger
 * on `repos`), so as soon as the canonical row moves at all we compare
 * unequal and drop the overlay. Tagging with `basedOnStatus` instead —
 * an earlier approach — missed the very common case where a fast
 * clone+auto-index round-trips `ready → cloning → cloned → indexing →
 * ready` before the first refreshRepo() lands; the new canonical status
 * matched the old one and the overlay (and the disabled button) stuck.
 *
 * Log pane + summary:
 *   - `RepoLog` tails `repo:<id>` and covers both clone and index events.
 *   - `IndexSummary` shows the count chips once the repo has ever been
 *     indexed. It reads the `indexSummary` field baked into the canonical
 *     RepoResponse, so a successful `refreshRepo` auto-updates it too.
 */

import { useState } from 'react'
import type {
  AttachedRepoResponse,
  RepoResponse,
  RepoStatus,
} from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'
import { CloneButton } from './clone-button'
import { IndexButton } from './index-button'
import { IndexSummary } from './index-summary'
import { RepoLog } from './repo-log'

import './index.css'

export function RepoInspector({
  repo,
  workspace,
}: {
  repo: RepoResponse
  workspace: WorkspaceContextValue
}) {
  const [statusOverlay, setStatusOverlay] = useState<{
    status: RepoStatus
    basedOnUpdatedAt: string
  } | null>(null)

  const overlayLive =
    statusOverlay !== null && statusOverlay.basedOnUpdatedAt === repo.updatedAt
  const effective: RepoResponse =
    overlayLive && statusOverlay
      ? { ...repo, status: statusOverlay.status }
      : repo

  const attachments: Array<{
    agentName: string
    agentSlug: string
    attached: AttachedRepoResponse
  }> = []
  for (const agent of workspace.agents) {
    const bundle = workspace.agentResources[agent.id]
    if (!bundle) continue
    for (const a of bundle.attachedRepos) {
      if (a.repo.id === repo.id) {
        attachments.push({
          agentName: agent.name,
          agentSlug: agent.slug,
          attached: a,
        })
      }
    }
  }

  // Show the log pane once a clone/index has been requested or finished;
  // `pending` is the only state with nothing to show.
  const showLog = effective.status !== 'pending'

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Repository</span>
          <span className={`badge ${statusBadgeClass(effective.status)}`}>
            <span className="badge-dot" />
            {effective.status}
          </span>
        </div>
        <div className="read-row">
          <span className="read-label">Remote</span>
          <span className="read-value mono">{effective.remoteUrl}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Branch</span>
          <span className="read-value mono">{effective.branch}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Local path</span>
          <span className="read-value mono">
            {effective.localPath ?? '—'}
          </span>
        </div>
        <div className="read-row">
          <span className="read-label">PAT</span>
          <span className="read-value">
            {effective.gitPat.set ? 'configured' : '—'}
          </span>
        </div>
        {effective.lastError ? (
          <div className="read-row">
            <span className="read-label">Last error</span>
            <span className="read-value" style={{ color: 'var(--danger)' }}>
              {effective.lastError}
            </span>
          </div>
        ) : null}
      </section>

      {effective.indexSummary ? (
        <section className="inspector-section">
          <div className="inspector-section-title">
            <span>Index summary</span>
          </div>
          <IndexSummary summary={effective.indexSummary} />
        </section>
      ) : null}

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Pipeline</span>
        </div>
        <div className="inspector-action-row">
          <CloneButton
            repo={effective}
            onOptimistic={() =>
              setStatusOverlay({
                status: 'cloning',
                basedOnUpdatedAt: repo.updatedAt,
              })
            }
            onRevert={() => setStatusOverlay(null)}
          />
          <IndexButton
            repo={effective}
            onOptimistic={() =>
              setStatusOverlay({
                status: 'indexing',
                basedOnUpdatedAt: repo.updatedAt,
              })
            }
            onRevert={() => setStatusOverlay(null)}
          />
        </div>
        {showLog ? <RepoLog repo={repo} workspace={workspace} /> : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Attached to {attachments.length} agent(s)</span>
        </div>
        {attachments.length === 0 ? (
          <div className="rail-empty">
            <div className="rail-empty-title">No attachments yet</div>
            <div className="rail-empty-hint">
              Connect this repo to an agent from the Inspector.
            </div>
          </div>
        ) : (
          <ul className="read-list">
            {attachments.map((a) => (
              <li key={a.attached.attachedAt + a.agentSlug}>
                <div className="read-list-primary">{a.agentName}</div>
                <div className="read-list-secondary">
                  <code>{a.agentSlug}</code>
                  {a.attached.role ? (
                    <span className="badge badge-accent">
                      {a.attached.role}
                    </span>
                  ) : null}
                </div>
                {a.attached.description ? (
                  <div className="read-list-desc">
                    {a.attached.description}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function statusBadgeClass(status: RepoStatus): string {
  switch (status) {
    case 'cloned':
    case 'ready':
      return 'badge-success'
    case 'cloning':
    case 'indexing':
      return 'badge-accent'
    case 'error':
      return 'badge-error'
    case 'pending':
    default:
      return ''
  }
}
