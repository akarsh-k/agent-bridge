/**
 * "Attach file" side-sheet — pick from the workspace Library.
 *
 * Files attached here become available to the agent via the
 * `search_knowledge` tool and show up in the system-prompt catalog
 * (see `docs/knowledge-files.md`).
 */

import { useMemo, useState } from 'react'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Link } from '../../lib/link'

function AttachFileForm({
  agentId,
  onClose,
}: {
  agentId: string
  onClose: () => void
}) {
  const { files, agentResources, attachFile } = useWorkspace()
  const alreadyAttached = useMemo(
    () =>
      new Set(
        (agentResources[agentId]?.attachedFiles ?? []).map((a) => a.file.id),
      ),
    [agentResources, agentId],
  )
  // Only `ready` files are useful — attaching a still-ingesting file
  // would land it in the catalog but `search_knowledge` couldn't
  // return anything for it until the pipeline completes.
  const eligible = useMemo(
    () =>
      files.filter(
        (f) => !alreadyAttached.has(f.id) && f.ingestStatus === 'ready',
      ),
    [files, alreadyAttached],
  )
  const opts: DropdownOption[] = useMemo(
    () =>
      eligible.map((f) => ({
        value: f.id,
        label: f.name,
        sub: f.description.trim() || `${f.kind.toUpperCase()} · ${(f.bytes / 1024).toFixed(1)} KB`,
      })),
    [eligible],
  )

  const [fileId, setFileId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!fileId) return
    setBusy(true)
    setErr(null)
    try {
      await attachFile(agentId, fileId)
      toast.success('File attached')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to attach',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Attach file"
      subtitle="Pick a file from your Library. The agent gets read access via search_knowledge."
      primaryLabel="Attach"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!fileId}
    >
      {files.length === 0 ? (
        <div className="ab-field">
          <div className="ab-field-help">
            You haven't uploaded any files yet.{' '}
            <Link to="/library/files" style={{ color: 'var(--accent-300)' }}>
              Upload one in Library →
            </Link>
          </div>
        </div>
      ) : eligible.length === 0 ? (
        <div className="ab-field">
          <div className="ab-field-help">
            All your ready files are already attached to this agent.
            Still-ingesting files (pending, embedding, etc.) can't be
            attached until they finish.
          </div>
        </div>
      ) : (
        <>
          <div className="ab-field">
            <span className="ab-field-label">File</span>
            <Dropdown
              value={fileId}
              onChange={setFileId}
              options={opts}
              placeholder="Pick a file"
            />
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
        </>
      )}
    </Sheet>
  )
}

export function AttachFileSheet({
  open,
  agentId,
  onClose,
}: {
  open: boolean
  agentId: string
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Attach file">
        <></>
      </Sheet>
    )
  }
  return <AttachFileForm key={openCount} agentId={agentId} onClose={onClose} />
}
