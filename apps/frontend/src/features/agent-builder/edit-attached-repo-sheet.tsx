/**
 * Edit-attached-repo side-sheet — tweaks role + description for a
 * repo already attached to this agent. The repo entry itself is
 * managed in Library; this only touches the per-agent attachment.
 */

import { useState } from 'react'
import type { AttachedRepoResponse } from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { useWorkspace } from '../../lib/workspace-context'
import { ApiError } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

function EditForm({
  agentId,
  attachment,
  onClose,
}: {
  agentId: string
  attachment: AttachedRepoResponse
  onClose: () => void
}) {
  const { patchAttachedRepo } = useWorkspace()
  const [role, setRole] = useState(attachment.role ?? '')
  const [description, setDescription] = useState(attachment.description ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const dirty =
    role !== (attachment.role ?? '') ||
    description !== (attachment.description ?? '')
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await patchAttachedRepo(agentId, attachment.repo.id, {
        role: role.trim() || null,
        description: description.trim() || null,
      })
      toast.success('Attachment updated')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Save failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="Edit role"
      subtitle={`Role + description for ${shortRepoName(attachment.repo.remoteUrl)} on this agent.`}
      primaryLabel="Save changes"
      onPrimary={submit}
      primaryBusy={busy}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ear-role">
          Role
        </label>
        <input
          id="ear-role"
          className="ab-input"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. backend, docs, infra"
          autoFocus
        />
        <span className="ab-field-help">
          Hint that helps the agent reason about which repo to consult.
        </span>
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ear-desc">
          Description
        </label>
        <textarea
          id="ear-desc"
          className="ab-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this repo gives the agent visibility into."
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
    </Sheet>
  )
}

export function EditAttachedRepoSheet({
  open,
  agentId,
  attachment,
  onClose,
}: {
  open: boolean
  agentId: string
  attachment: AttachedRepoResponse | null
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open || !attachment) {
    return (
      <Sheet open={false} onClose={onClose} title="Edit role">
        <></>
      </Sheet>
    )
  }
  return (
    <EditForm
      key={`${openCount}:${attachment.repo.id}`}
      agentId={agentId}
      attachment={attachment}
      onClose={onClose}
    />
  )
}
