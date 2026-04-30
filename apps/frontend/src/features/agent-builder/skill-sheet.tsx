/**
 * Skill side-sheet — handles both create and edit. When `skillId` is
 * provided we patch in place, otherwise we create new.
 */

import { useMemo, useState } from 'react'
import {
  skillCreateInputSchema,
  skillUpdateInputSchema,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { Markdown } from '../../ui/markdown'
import { Tabs } from '../../ui/tabs'
import { useDirtyClose } from '../../lib/use-dirty-close'

function SkillForm({
  agentId,
  skillId,
  onClose,
}: {
  agentId: string
  skillId: string | null
  onClose: () => void
}) {
  const { agentResources, createSkill, patchSkill } = useWorkspace()
  const initial = useMemo(
    () =>
      skillId
        ? agentResources[agentId]?.skills.find((s) => s.id === skillId)
        : null,
    [agentResources, agentId, skillId],
  )

  const [name, setName] = useState(initial?.name ?? '')
  const [body, setBody] = useState(initial?.markdownBody ?? '')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'edit' | 'preview'>('edit')

  const isEdit = skillId !== null

  const baselineName = initial?.name ?? ''
  const baselineBody = initial?.markdownBody ?? ''
  const dirty = name !== baselineName || body !== baselineBody
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    setErr(null)
    if (isEdit) {
      const parsed = skillUpdateInputSchema.safeParse({
        name: name.trim(),
        markdownBody: body.trim() || undefined,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid skill')
        return
      }
      setBusy(true)
      try {
        await patchSkill(agentId, skillId!, parsed.data)
        toast.success('Skill updated')
        onClose()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to update skill',
        )
      } finally {
        setBusy(false)
      }
    } else {
      const parsed = skillCreateInputSchema.safeParse({
        name: name.trim(),
        markdownBody: body.trim() || undefined,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid skill')
        return
      }
      setBusy(true)
      try {
        await createSkill(agentId, parsed.data)
        toast.success(`Skill “${name.trim()}” added`)
        onClose()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to add skill',
        )
      } finally {
        setBusy(false)
      }
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title={isEdit ? 'Edit skill' : 'Add skill'}
      subtitle={
        isEdit
          ? 'Tweak the prompt fragment used by this agent.'
          : "A skill is a focused instruction pack — a system-prompt fragment loaded alongside this agent's own prompt."
      }
      primaryLabel={isEdit ? 'Save changes' : 'Add skill'}
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!name.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="sk-name">
          Name
        </label>
        <input
          id="sk-name"
          className="ab-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. PR reviewer, migration writer"
          autoFocus
        />
      </div>
      <div className="ab-field">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <label className="ab-field-label" htmlFor="sk-body">
            Markdown body
          </label>
          <Tabs<'edit' | 'preview'>
            value={view}
            onChange={setView}
            tabs={[
              { value: 'edit', label: 'Edit' },
              { value: 'preview', label: 'Preview' },
            ]}
            className="ab-tabs-inline"
          />
        </div>
        {view === 'edit' ? (
          <textarea
            id="sk-body"
            className="ab-textarea ab-mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="# When asked to review a PR…&#10;1. Pull the diff&#10;2. Comment on …"
            rows={10}
          />
        ) : (
          <div
            style={{
              minHeight: 200,
              maxHeight: 360,
              overflowY: 'auto',
              padding: '12px 14px',
              background: 'var(--surface-hi)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
            }}
          >
            {body.trim() ? (
              <Markdown source={body} />
            ) : (
              <span className="ab-field-help">Nothing to preview yet.</span>
            )}
          </div>
        )}
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

export function SkillSheet({
  open,
  agentId,
  skillId,
  onClose,
}: {
  open: boolean
  agentId: string
  skillId?: string | null
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
      <Sheet open={false} onClose={onClose} title="Add skill">
        <></>
      </Sheet>
    )
  }
  return (
    <SkillForm
      key={`${openCount}:${skillId ?? 'new'}`}
      agentId={agentId}
      skillId={skillId ?? null}
      onClose={onClose}
    />
  )
}
