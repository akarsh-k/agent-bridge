import { useCallback, useEffect, useRef, useState } from 'react'
import { skillCreateInputSchema } from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { AddFormActions, ErrorText } from './form-atoms'

export function SkillForm({
  agentId,
  onCancel,
  onDone,
}: {
  readonly agentId: string
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const { createSkill } = useWorkspace()
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const parsed = skillCreateInputSchema.safeParse({
      name: name.trim(),
      markdownBody: body.length ? body : undefined,
    })
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid skill')
      return
    }
    setBusy(true)
    try {
      await createSkill(agentId, parsed.data)
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create skill',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, body, createSkill, name, onDone])

  return (
    <form
      className="add-resource-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="code-review"
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Markdown body (optional)</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="You are a meticulous code reviewer..."
          disabled={busy}
        />
      </label>
      <ErrorText message={err} />
      <AddFormActions
        submitLabel={busy ? 'Adding...' : 'Add skill'}
        busy={busy}
        disabled={name.trim().length === 0}
        onCancel={onCancel}
      />
    </form>
  )
}
