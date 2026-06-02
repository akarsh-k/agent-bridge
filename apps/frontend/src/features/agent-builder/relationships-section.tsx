/**
 * Repo relationships editor — directed relationships between attached repos.
 * Each relationship: from → connector → to + optional description. Used by
 * the agent's prompt to describe how the repos relate (e.g. "owns",
 * "depends on", "deploys to").
 */

import { useMemo, useState } from 'react'
import type { RepoRelationshipResponse } from '@agent-bridge/shared'
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

export function RelationshipsSection({ agentId }: { agentId: string }) {
  const {
    agentResources,
    createRepoRelationship,
    patchRepoRelationship,
    removeRepoRelationship,
  } = useWorkspace()
  const resources = agentResources[agentId]
  const attached = resources?.attachedRepos ?? []
  const relationships = resources?.repoRelationships ?? []
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingRelationshipId, setEditingRelationshipId] = useState<
    string | null
  >(null)
  const editingRelationship = editingRelationshipId
    ? (relationships.find((e) => e.id === editingRelationshipId) ?? null)
    : null

  const openCreate = () => {
    setEditingRelationshipId(null)
    setSheetOpen(true)
  }
  const openEdit = (relationshipId: string) => {
    setEditingRelationshipId(relationshipId)
    setSheetOpen(true)
  }
  const closeSheet = () => {
    setSheetOpen(false)
    setEditingRelationshipId(null)
  }

  const repoLabel = (id: string): string => {
    const a = attached.find((r) => r.repo.id === id)
    return a ? shortRepoName(a.repo.remoteUrl) : id.slice(0, 8) + '…'
  }

  const removeRelationship = async (relationshipId: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Delete relationship ${label}?`,
        confirmLabel: 'Delete',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeRepoRelationship(agentId, relationshipId)
      toast.success('Relationship removed')
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
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        className="ab-section-head"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="ab-section-title">Repo relations</div>
          <div className="ab-section-sub">
            {relationships.length}{' '}
            {relationships.length === 1 ? 'relationship' : 'relationships'} ·
            how attached repos relate (uses, deploys to, depends on …)
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leading={<PlusIcon strokeWidth={2.4} />}
          onClick={openCreate}
          disabled={attached.length < 2}
          title={
            attached.length < 2
              ? 'Attach at least two repos to draw relationships between them'
              : undefined
          }
        >
          Add relationship
        </Button>
      </div>
      {relationships.length === 0 ? (
        <div className="ab-field-help">
          {attached.length < 2
            ? 'Attach at least two repositories above before drawing relationships between them.'
            : 'No relationships yet. Add one to describe how repos relate — useful for retrieval-heavy agents.'}
        </div>
      ) : (
        <div className="ab-card ab-list-card">
          {relationships.map((e) => (
            <div
              className="ab-list-row is-edit"
              key={e.id}
              role="button"
              tabIndex={0}
              onClick={() => openEdit(e.id)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  openEdit(e.id)
                }
              }}
            >
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
              <div
                className="ab-list-row-meta"
                onClick={(ev) => ev.stopPropagation()}
              >
                {e.description && (
                  <span className="ab-field-help">{e.description}</span>
                )}
                <RowMenu
                  items={[
                    {
                      label: 'Edit relationship',
                      onClick: () => openEdit(e.id),
                    },
                    {
                      label: 'Delete relationship',
                      destructive: true,
                      onClick: () =>
                        void removeRelationship(
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
      <RelationshipSheet
        open={sheetOpen}
        agentId={agentId}
        onClose={closeSheet}
        attached={attached}
        createRelationship={createRepoRelationship}
        patchRelationship={patchRepoRelationship}
        editingRelationship={editingRelationship}
      />
    </div>
  )
}

interface RelationshipSheetProps {
  open: boolean
  agentId: string
  onClose: () => void
  attached: ReadonlyArray<{ repo: { id: string; remoteUrl: string } }>
  createRelationship: ReturnType<typeof useWorkspace>['createRepoRelationship']
  patchRelationship: ReturnType<typeof useWorkspace>['patchRepoRelationship']
  editingRelationship: RepoRelationshipResponse | null
}

function RelationshipForm({
  agentId,
  onClose,
  attached,
  createRelationship,
  patchRelationship,
  editingRelationship,
}: Omit<RelationshipSheetProps, 'open'>) {
  const opts: DropdownOption[] = useMemo(
    () =>
      attached.map((a) => ({
        value: a.repo.id,
        label: shortRepoName(a.repo.remoteUrl),
      })),
    [attached],
  )
  const isEdit = editingRelationship !== null

  const [from, setFrom] = useState<string | null>(
    editingRelationship?.fromRepoId ?? opts[0]?.value ?? null,
  )
  const [to, setTo] = useState<string | null>(
    editingRelationship?.toRepoId ?? opts[1]?.value ?? null,
  )
  const [connector, setConnector] = useState(
    editingRelationship?.connector ?? 'uses',
  )
  const [description, setDescription] = useState(
    editingRelationship?.description ?? '',
  )
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
      if (isEdit && editingRelationship) {
        // Endpoints are immutable post-create — only connector + description
        // can be patched. The from/to dropdowns are disabled in edit mode.
        await patchRelationship(agentId, editingRelationship.id, {
          connector: connector.trim() || 'uses',
          description: description.trim() || null,
        })
        toast.success('Relationship updated')
      } else {
        await createRelationship(agentId, {
          fromRepoId: from,
          toRepoId: to,
          connector: connector.trim() || 'uses',
          description: description.trim() || null,
        })
        toast.success('Relationship added')
      }
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : isEdit
              ? 'Failed to update'
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
      title={isEdit ? 'Edit repo relationship' : 'Add repo relationship'}
      subtitle={
        isEdit
          ? 'Endpoints are fixed once created — change the connector or description.'
          : 'A directed relationship between two attached repos.'
      }
      primaryLabel={isEdit ? 'Save changes' : 'Add relationship'}
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
            disabled={isEdit}
          />
        </div>
        <div className="ab-field">
          <span className="ab-field-label">To</span>
          <Dropdown
            value={to}
            onChange={setTo}
            options={opts}
            placeholder="Target repo"
            disabled={isEdit}
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

function RelationshipSheet({
  open,
  onClose,
  agentId,
  attached,
  createRelationship,
  patchRelationship,
  editingRelationship,
}: RelationshipSheetProps) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Add repo relationship">
        <></>
      </Sheet>
    )
  }
  return (
    <RelationshipForm
      key={`${openCount}:${editingRelationship?.id ?? 'new'}`}
      agentId={agentId}
      onClose={onClose}
      attached={attached}
      createRelationship={createRelationship}
      patchRelationship={patchRelationship}
      editingRelationship={editingRelationship}
    />
  )
}
