/**
 * Repo edges editor — directed relationships between attached repos.
 * Each edge: from → connector → to + optional description. Used by
 * the agent's prompt to describe how the repos relate (e.g. "owns",
 * "depends on", "deploys to").
 */

import { useMemo, useState } from 'react'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { RowMenu } from '../../ui/row-menu'
import { Sheet } from '../../ui/sheet'
import { ApiError } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { confirmDialog } from '../../ui/dialog-store'
import { PlusIcon } from '../../ui/icons'
import { ArrowRightIcon } from '../../ui/icons'

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

export function EdgesSection({ agentId }: { agentId: string }) {
  const { agentResources, createRepoEdge, removeRepoEdge } = useWorkspace()
  const resources = agentResources[agentId]
  const attached = resources?.attachedRepos ?? []
  const edges = resources?.repoEdges ?? []
  const [sheetOpen, setSheetOpen] = useState(false)

  const repoLabel = (id: string): string => {
    const a = attached.find((r) => r.repo.id === id)
    return a ? shortRepoName(a.repo.remoteUrl) : id.slice(0, 8) + '…'
  }

  const removeEdge = async (edgeId: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Delete edge ${label}?`,
        confirmLabel: 'Delete',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeRepoEdge(agentId, edgeId)
      toast.success('Edge removed')
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
    <div className="ab-resource-section">
      <div className="ab-resource-head">
        <div>
          <span className="ab-resource-title">Repo relationships</span>
          <span className="ab-resource-count">
            {edges.length} {edges.length === 1 ? 'edge' : 'edges'}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leading={<PlusIcon strokeWidth={2.4} />}
          onClick={() => setSheetOpen(true)}
          disabled={attached.length < 2}
          title={
            attached.length < 2
              ? 'Attach at least two repos to draw edges between them'
              : undefined
          }
        >
          Add edge
        </Button>
      </div>
      {edges.length === 0 ? (
        <div className="ab-field-help">
          Edges describe how attached repos relate ("frontend depends on
          shared", "backend deploys to infra"). Optional but useful for
          retrieval-heavy agents.
        </div>
      ) : (
        <div className="ab-card ab-list-card">
          {edges.map((e) => (
            <div className="ab-list-row is-static" key={e.id}>
              <span className="ab-mono" style={{ flex: '0 0 auto' }}>
                {repoLabel(e.fromRepoId)}
              </span>
              <ArrowRightIcon
                style={{ width: 14, height: 14, color: 'var(--text-muted)' }}
              />
              <span
                className="ab-pill ab-pill-accent"
                style={{ flex: '0 0 auto' }}
              >
                {e.connector}
              </span>
              <ArrowRightIcon
                style={{ width: 14, height: 14, color: 'var(--text-muted)' }}
              />
              <span className="ab-mono" style={{ flex: 1 }}>
                {repoLabel(e.toRepoId)}
              </span>
              <div className="ab-list-row-meta">
                {e.description && (
                  <span className="ab-field-help">{e.description}</span>
                )}
                <RowMenu
                  items={[
                    {
                      label: 'Delete edge',
                      destructive: true,
                      onClick: () =>
                        void removeEdge(
                          e.id,
                          `${repoLabel(e.fromRepoId)} → ${repoLabel(e.toRepoId)}`,
                        ),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <EdgeSheet
        open={sheetOpen}
        agentId={agentId}
        onClose={() => setSheetOpen(false)}
        attached={attached}
        createEdge={createRepoEdge}
      />
    </div>
  )
}

interface EdgeSheetProps {
  open: boolean
  agentId: string
  onClose: () => void
  attached: ReadonlyArray<{ repo: { id: string; remoteUrl: string } }>
  createEdge: ReturnType<
    typeof useWorkspace
  >['createRepoEdge']
}

function EdgeForm({
  agentId,
  onClose,
  attached,
  createEdge,
}: Omit<EdgeSheetProps, 'open'>) {
  const opts: DropdownOption[] = useMemo(
    () =>
      attached.map((a) => ({
        value: a.repo.id,
        label: shortRepoName(a.repo.remoteUrl),
      })),
    [attached],
  )

  const [from, setFrom] = useState<string | null>(opts[0]?.value ?? null)
  const [to, setTo] = useState<string | null>(opts[1]?.value ?? null)
  const [connector, setConnector] = useState('uses')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!from || !to) {
      setErr('Pick both repos')
      return
    }
    if (from === to) {
      setErr('Pick two different repos')
      return
    }
    setBusy(true)
    try {
      await createEdge(agentId, {
        fromRepoId: from,
        toRepoId: to,
        connector: connector.trim() || 'uses',
        description: description.trim() || null,
      })
      toast.success('Edge added')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Add repo edge"
      subtitle="A directed relationship between two attached repos."
      primaryLabel="Add edge"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!from || !to || from === to}
    >
      <div className="ab-field-grid">
        <div className="ab-field">
          <span className="ab-field-label">From</span>
          <Dropdown
            value={from}
            onChange={setFrom}
            options={opts}
            placeholder="Source repo"
          />
        </div>
        <div className="ab-field">
          <span className="ab-field-label">To</span>
          <Dropdown
            value={to}
            onChange={setTo}
            options={opts}
            placeholder="Target repo"
          />
        </div>
        <div className="ab-field ab-field-col">
          <label className="ab-field-label" htmlFor="ed-connector">
            Connector
          </label>
          <input
            id="ed-connector"
            className="ab-input ab-mono"
            value={connector}
            onChange={(e) => setConnector(e.target.value)}
            placeholder="uses, depends on, deploys to…"
          />
        </div>
        <div className="ab-field ab-field-col">
          <label className="ab-field-label" htmlFor="ed-desc">
            Description (optional)
          </label>
          <textarea
            id="ed-desc"
            className="ab-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Plain-language note for the agent's prompt."
          />
        </div>
      </div>
      {err && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)' }}
          role="alert"
        >
          {err}
        </div>
      )}
    </Sheet>
  )
}

function EdgeSheet({
  open,
  onClose,
  agentId,
  attached,
  createEdge,
}: EdgeSheetProps) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Add repo edge">
        <></>
      </Sheet>
    )
  }
  return (
    <EdgeForm
      key={openCount}
      agentId={agentId}
      onClose={onClose}
      attached={attached}
      createEdge={createEdge}
    />
  )
}
