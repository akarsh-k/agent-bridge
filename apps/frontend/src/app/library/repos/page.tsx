import { useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { Link } from '../../../lib/link'
import { PageHeader } from '../../_chrome/page-header'
import { Button } from '../../../ui/button'
import { Pill, type PillKind } from '../../../ui/pill'
import { EmptyState } from '../../../ui/empty'
import { BrandGlyph } from '../../../ui/brand-glyph'
import { RowMenu } from '../../../ui/row-menu'
import {
  ChevronRightIcon,
  PlusIcon,
  ReposIcon,
} from '../../../ui/icons'
import { RepoCreateSheet } from '../../../features/library/repo-create-sheet'
import { confirmDialog } from '../../../ui/dialog-store'
import { LibraryAttachNote } from '../../../ui/library-attach-note'
import { toast } from '../../../ui/toast-store'
import { ApiError } from '../../../lib/rpc'

// Dot only on truly live, in-flight states (`cloning`, `pulling`,
// `indexing`); the terminal labels (`pending`, `cloned`, `ready`,
// `error`) stay static so the row reads as resolved at a glance.
const STATUS_PILL: Record<string, { kind: PillKind; label: string; dot?: boolean }> = {
  pending: { kind: 'neutral', label: 'Pending' },
  cloning: { kind: 'warn', label: 'Cloning', dot: true },
  cloned: { kind: 'neutral', label: 'Cloned' },
  pulling: { kind: 'warn', label: 'Pulling', dot: true },
  indexing: { kind: 'warn', label: 'Indexing', dot: true },
  ready: { kind: 'success', label: 'Indexed' },
  error: { kind: 'danger', label: 'Error' },
}

export function ReposPage() {
  const { repos, removeRepo } = useWorkspace()
  const [sheetOpen, setSheetOpen] = useState(false)

  const remove = async (id: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Delete repo “${label}”?`,
        body: 'Agents using it lose the attachment. The local clone is removed too.',
        confirmLabel: 'Delete repository',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeRepo(id)
      toast.success('Repository deleted')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    }
  }

  return (
    <div className="ab-page">
      <PageHeader
        title="Repositories"
        subtitle="Repos you've cloned + indexed locally so agents can read them. Each repo can be attached to one or more agents."
        actions={
          <Button
            variant="primary"
            leading={<PlusIcon strokeWidth={2.4} />}
            onClick={() => setSheetOpen(true)}
          >
            Add repository
          </Button>
        }
      />

      <LibraryAttachNote subject="repo" />

      {repos.length === 0 ? (
        <EmptyState
          glyph={<ReposIcon />}
          title="No repositories yet"
          body="Clone a repo to give your agent something to read. We index files + generate a wiki + a knowledge graph for each one."
          action={
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => setSheetOpen(true)}
            >
              Add your first repo
            </Button>
          }
        />
      ) : (
        <div className="ab-card ab-list-card">
          {repos.map((r) => {
            const sp = STATUS_PILL[r.status] ?? STATUS_PILL.pending!
            return (
              <Link
                className="ab-list-row is-link"
                to={`/library/repos/${r.id}`}
                key={r.id}
              >
                <BrandGlyph kind="github" />
                <div className="ab-list-row-head">
                  <div className="ab-list-row-title">{shortRepoName(r.remoteUrl)}</div>
                  <div className="ab-list-row-sub ab-mono">
                    {r.remoteUrl} · {r.branch}
                  </div>
                </div>
                <div className="ab-list-row-meta">
                  <Pill kind={sp.kind} dot={sp.dot}>
                    {sp.label}
                  </Pill>
                  <RowMenu
                    items={[
                      {
                        label: 'Delete repository',
                        destructive: true,
                        onClick: () =>
                          void remove(r.id, shortRepoName(r.remoteUrl)),
                      },
                    ]}
                  />
                  <span className="ab-row-affordance" aria-hidden="true">
                    <ChevronRightIcon />
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
      <RepoCreateSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  )
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}
