/**
 * Repo detail page. Surfaces clone + index status, lets the
 * operator clone, re-index, edit the PAT, and
 * delete. Live progress comes through SSE on the repo's stream id.
 */

import { lazy, Suspense, useMemo, useState } from 'react'
import { useWorkspace } from '../../../../lib/workspace-context'
import { Link } from '../../../../lib/link'
import { navigate } from '../../../../lib/router'
import { Button } from '../../../../ui/button'
import { Pill, type PillKind } from '../../../../ui/pill'
import { BrandGlyph } from '../../../../ui/brand-glyph'
import {
  ApiError,
  cloneRepo,
  indexRepo,
  pullRepo,
} from '../../../../lib/rpc'
import { toast } from '../../../../ui/toast-store'
import { confirmDialog } from '../../../../ui/dialog-store'
import { RepoLogTail } from '../../../../features/library/repo-log-tail'

// Code-split: React Flow + dagre only ship when the modal opens.
const GraphModal = lazy(() =>
  import('../../../../features/repo-graph/graph-modal').then((m) => ({
    default: m.GraphModal,
  })),
)

/** `dot` is reserved for in-flight/live states so the pulsing dot
 *  reads as "something is actively happening". Steady-state pills
 *  (Cloned / Indexed / Error / Pending) render flat. */
const STATUS_PILL: Record<
  string,
  { kind: PillKind; label: string; dot?: boolean }
> = {
  pending: { kind: 'neutral', label: 'Pending' },
  cloning: { kind: 'warn', label: 'Cloning', dot: true },
  cloned: { kind: 'neutral', label: 'Cloned' },
  pulling: { kind: 'warn', label: 'Pulling', dot: true },
  indexing: { kind: 'warn', label: 'Indexing', dot: true },
  ready: { kind: 'success', label: 'Indexed' },
  error: { kind: 'danger', label: 'Error' },
}

export function RepoDetailPage({ id }: { id: string }) {
  const { repos, patchRepo, removeRepo, agentResources } = useWorkspace()
  const repo = repos.find((r) => r.id === id)
  const dependentAgentIds = useMemo(() => {
    const ids: string[] = []
    for (const [agentId, bundle] of Object.entries(agentResources)) {
      if (bundle.attachedRepos.some((a) => a.repo.id === id)) ids.push(agentId)
    }
    return ids
  }, [agentResources, id])

  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)

  if (!repo) {
    return (
      <div className="ab-page">
        <div className="ab-card ab-card-pad">
          <div className="ab-section-title">Repository not found</div>
          <div style={{ marginTop: 12 }}>
            <Link to="/library/repos" className="ab-btn ab-btn-secondary">
              Back to repos
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const sp = STATUS_PILL[repo.status] ?? STATUS_PILL.pending!

  const setKey = async () => {
    setBusy(true)
    try {
      await patchRepo(repo.id, {
        gitPat: pat.trim()
          ? ({ action: 'set', plaintext: pat.trim() } as const)
          : ({ action: 'clear' } as const),
      })
      setPat('')
      toast.success('PAT updated')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed',
      )
    } finally {
      setBusy(false)
    }
  }

  const runJob = async (label: string, fn: () => Promise<unknown>) => {
    setRunning(label)
    try {
      await fn()
      toast.success(`${label} kicked off`)
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : `${label} failed`,
      )
    } finally {
      setRunning(null)
    }
  }

  const clone = () => runJob('Clone', () => cloneRepo(repo.id))
  const pull = () => runJob('Pull', () => pullRepo(repo.id))
  const reindex = () => runJob('Re-index', () => indexRepo(repo.id))

  // Re-clone is destructive: it wipes `<source>/.gitnexus/` along with
  // the source tree, forcing a full re-embed. `Pull` is the cheap path
  // for "update from remote"; this button stays as the explicit
  // "rebuild from scratch" gesture for when the source tree is broken.
  const reclone = async () => {
    const confirmed = await confirmDialog({
      title: `Re-clone “${shortRepoName(repo.remoteUrl)}”?`,
      body:
        'Re-clone wipes the local source tree and the embedding cache, ' +
        'then re-clones from scratch. Use Pull if you just want to fetch ' +
        'the latest commits — it preserves embeddings.',
      confirmLabel: 'Re-clone',
      destructive: true,
    })
    if (!confirmed) return
    await runJob('Clone', () => cloneRepo(repo.id))
  }

  // First-time clones don't have a source/ tree yet, so Pull isn't an
  // option until the initial clone lands. After that, Pull is the
  // primary refresh action and Re-clone is the destructive escape hatch.
  const hasBeenCloned = repo.status !== 'pending'

  const remove = async () => {
    const body =
      dependentAgentIds.length === 0
        ? 'No agents have this repo attached. The local clone is removed too.'
        : `${dependentAgentIds.length} agent${
            dependentAgentIds.length === 1 ? '' : 's'
          } have this repo attached — they'll lose access. The local clone is removed too.`
    if (
      !(await confirmDialog({
        title: `Delete repo “${shortRepoName(repo.remoteUrl)}”?`,
        body,
        confirmLabel: 'Delete repository',
        destructive: true,
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await removeRepo(repo.id)
      toast.success('Repository deleted')
      navigate('/library/repos')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ab-page">
      <Link to="/library/repos" className="ab-back-link">
        Back to repositories
      </Link>
      <div className="ab-detail-header">
        <BrandGlyph kind="github" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ab-page-title" style={{ marginBottom: 0 }}>
            {shortRepoName(repo.remoteUrl)}
          </h1>
          <div className="ab-detail-meta">
            <span className="ab-mono">{repo.remoteUrl}</span>
            <span className="ab-mono">{repo.branch}</span>
            <Pill kind={sp.kind} dot={sp.dot}>
              {sp.label}
            </Pill>
          </div>
        </div>
        <div className="ab-page-actions">
          {hasBeenCloned ? (
            <Button
              variant="secondary"
              onClick={pull}
              disabled={running !== null}
            >
              {running === 'Pull' ? 'Pulling…' : 'Pull'}
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={clone}
              disabled={running !== null}
            >
              {running === 'Clone' ? 'Cloning…' : 'Clone'}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={reindex}
            disabled={running !== null}
          >
            {running === 'Re-index' ? 'Indexing…' : 'Re-index'}
          </Button>
          {hasBeenCloned && (
            <Button
              variant="secondary"
              onClick={reclone}
              disabled={running !== null}
            >
              {running === 'Clone' ? 'Cloning…' : 'Re-clone'}
            </Button>
          )}
          {repo.indexSummary && (
            <Button
              variant="secondary"
              onClick={() => setGraphOpen(true)}
            >
              View graph
            </Button>
          )}
          {/*
            Wiki generation UI (Open wiki / Generate wiki buttons) is
            parked. The agent runtime doesn't currently consume the
            generated wiki — see `understand_module.ts:11` for the
            deferred wrapper integration. Backend routes + queue +
            `repos.wiki_*` columns stay intact so re-enabling is one
            UI change. See WikiGenerateSheet import note below.
          */}
        </div>
      </div>

      {repo.lastError && (
        // role="status" — persistent advisory tied to a steady-state
        // failure mode; not a transient just-happened notification, so
        // we don't want a screen reader interrupting on every parent
        // re-render of the page.
        <div
          role="status"
          className="ab-alert ab-alert-danger"
          style={{ alignItems: 'flex-start' }}
        >
          <span className="ab-alert-dot" aria-hidden="true" />
          <div className="ab-alert-body">
            <div className="ab-alert-title">Last error</div>
            <div
              className="ab-mono"
              style={{
                marginTop: 4,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                color: 'var(--text)',
              }}
            >
              {repo.lastError}
            </div>
          </div>
        </div>
      )}

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Index summary</div>
          <div className="ab-section-sub">
            Counts from the most recent successful{' '}
            <code className="ab-mono">gitnexus analyze</code> run.
          </div>
        </div>
        {repo.indexSummary ? (
          <div className="ab-field-grid">
            <Stat label="Indexed at" value={formatTs(repo.indexSummary.indexedAt)} />
            <Stat
              label="Commit"
              value={
                repo.indexSummary.indexedCommitSha?.slice(0, 7) ?? '—'
              }
              mono
            />
            <Stat
              label="Files"
              value={repo.indexSummary.files?.toLocaleString() ?? '—'}
            />
            <Stat
              label="Nodes"
              value={repo.indexSummary.nodes?.toLocaleString() ?? '—'}
            />
            <Stat
              label="Edges"
              value={repo.indexSummary.edges?.toLocaleString() ?? '—'}
            />
            <Stat
              label="Embeddings"
              value={repo.indexSummary.embeddings?.toLocaleString() ?? '—'}
            />
          </div>
        ) : (
          <div className="ab-field-help">
            Not indexed yet. Hit <strong>Re-index</strong> after the clone
            finishes.
          </div>
        )}
      </div>

      <RepoLogTail repoId={repo.id} />

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Auth</div>
          <div className="ab-section-sub">
            Git PAT used to clone private repositories. Encrypted at rest.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field ab-field-col">
            <label className="ab-field-label" htmlFor="rd-pat">
              Git PAT {repo.gitPat.set && '· (already set)'}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="rd-pat"
                className="ab-input ab-mono"
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder={repo.gitPat.set ? '••••••••' : 'ghp_…'}
                style={{ flex: 1 }}
              />
              <Button variant="primary" onClick={setKey} disabled={busy}>
                {repo.gitPat.set && !pat ? 'Clear' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Button variant="danger" onClick={remove} disabled={busy}>
          Delete repository
        </Button>
        <Link to="/library/repos" className="ab-btn ab-btn-ghost">
          Back to repos
        </Link>
      </div>

      {graphOpen && (
        <Suspense fallback={null}>
          <GraphModal repo={repo} onClose={() => setGraphOpen(false)} />
        </Suspense>
      )}
      {/* WikiGenerateSheet hidden — see note in the action bar above. */}
    </div>
  )
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="ab-field">
      <span className="ab-field-label">{label}</span>
      <div className={mono ? 'ab-mono' : undefined} style={{ fontSize: 14 }}>
        {value}
      </div>
    </div>
  )
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}
