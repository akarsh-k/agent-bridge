/**
 * Read-only repo inspector. Edit support arrives in Phase 1F when we add
 * the repo attach / edit flows. Today: show what the row contains so the
 * user can verify the graph matches their expectations.
 */

import type { AttachedRepoResponse, RepoResponse } from '@agent-bridge/shared'
import type { WorkspaceContextValue } from '../../../lib/workspace-context'

export function RepoInspector({
  repo,
  workspace,
}: {
  repo: RepoResponse
  workspace: WorkspaceContextValue
}) {
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

  return (
    <div className="inspector">
      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Repository</span>
        </div>
        <div className="read-row">
          <span className="read-label">Remote</span>
          <span className="read-value mono">{repo.remoteUrl}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Branch</span>
          <span className="read-value mono">{repo.branch}</span>
        </div>
        <div className="read-row">
          <span className="read-label">Status</span>
          <span className="read-value">{repo.status}</span>
        </div>
        <div className="read-row">
          <span className="read-label">PAT</span>
          <span className="read-value">
            {repo.gitPat.set ? 'configured' : '—'}
          </span>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">
          <span>Attached to {attachments.length} agent(s)</span>
        </div>
        {attachments.length === 0 ? (
          <div className="rail-empty">
            <div className="rail-empty-title">No attachments yet</div>
            <div className="rail-empty-hint">
              Connect this repo to an agent from the Inspector (Phase 1F).
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

      <p className="muted" style={{ fontSize: 12 }}>
        Editing moves to this inspector in Phase 1F.
      </p>
    </div>
  )
}
