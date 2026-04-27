import { useCallback, useEffect, useRef, useState } from 'react'
import { toolCreateInputSchema, toolKinds, type ToolKind } from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { AddFormActions, ErrorText } from './form-atoms'

export function ToolForm({
  agentId,
  onCancel,
  onDone,
}: {
  readonly agentId: string
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const { createTool } = useWorkspace()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ToolKind>('mastra_builtin')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const parsed = toolCreateInputSchema.safeParse({
      name: name.trim(),
      kind,
      description: description.trim().length ? description.trim() : null,
    })
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid tool')
      return
    }
    setBusy(true)
    try {
      await createTool(agentId, parsed.data)
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create tool',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, createTool, description, kind, name, onDone])

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
          placeholder="lookup-customer"
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ToolKind)}
          disabled={busy}
        >
          {toolKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2_000}
          rows={4}
          placeholder="Short summary shown to the LLM"
          disabled={busy}
        />
      </label>
      <ErrorText message={err} />
      <AddFormActions
        submitLabel={busy ? 'Adding...' : 'Add tool'}
        busy={busy}
        disabled={name.trim().length === 0}
        onCancel={onCancel}
      />
    </form>
  )
}
