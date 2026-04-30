/**
 * Agent tool side-sheet — handles both create and edit. These are the
 * agent's INTERNAL tools (HTTP/shell/Mastra-builtin/custom). For
 * outbound IDE tools see `agent-bridge-tools/`.
 */

import { useMemo, useState } from 'react'
import {
  toolCreateInputSchema,
  toolKinds,
  toolUpdateInputSchema,
  type ToolKind,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { useDirtyClose } from '../../lib/use-dirty-close'

const KIND_LABEL: Record<ToolKind, string> = {
  http: 'HTTP request',
  shell: 'Shell command',
  mastra_builtin: 'Mastra built-in',
  custom: 'Custom (advanced)',
}

const KIND_TEMPLATE: Record<ToolKind, string> = {
  http: JSON.stringify(
    {
      url: 'https://api.example.com/v1/things',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"q": "{{input}}"}',
    },
    null,
    2,
  ),
  shell: JSON.stringify(
    {
      command: 'sh',
      args: ['-c', 'echo "$INPUT"'],
      env: { INPUT: '{{input}}' },
    },
    null,
    2,
  ),
  mastra_builtin: JSON.stringify(
    { id: 'web-search', options: {} },
    null,
    2,
  ),
  custom: '{}',
}

const KIND_HINT: Record<ToolKind, string> = {
  http: 'Required: url, method. Optional: headers, body. Use {{input}} placeholders to inject the call args.',
  shell: 'Required: command, args. Optional: env. INPUT is exposed as a string.',
  mastra_builtin: 'Required: id (the Mastra built-in name). Optional: options.',
  custom: 'Free-form JSON — your own runner reads this.',
}

function ToolForm({
  agentId,
  toolId,
  onClose,
}: {
  agentId: string
  toolId: string | null
  onClose: () => void
}) {
  const { agentResources, createTool, patchTool } = useWorkspace()
  const initial = useMemo(
    () =>
      toolId
        ? agentResources[agentId]?.tools.find((t) => t.id === toolId)
        : null,
    [agentResources, agentId, toolId],
  )

  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [kind, setKind] = useState<ToolKind>(initial?.kind ?? 'http')
  const [configRaw, setConfigRaw] = useState(
    initial
      ? JSON.stringify(initial.configJson, null, 2)
      : KIND_TEMPLATE.http,
  )

  // When the user changes kind on a NEW tool, swap in the matching
  // template — but only if they haven't started editing the JSON.
  const [seededKind, setSeededKind] = useState(kind)
  if (!toolId && seededKind !== kind) {
    setSeededKind(kind)
    if (
      configRaw === KIND_TEMPLATE[seededKind] ||
      configRaw.trim() === '' ||
      configRaw.trim() === '{}'
    ) {
      setConfigRaw(KIND_TEMPLATE[kind])
    }
  }
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isEdit = toolId !== null

  const baselineName = initial?.name ?? ''
  const baselineDesc = initial?.description ?? ''
  const baselineKind = initial?.kind ?? 'http'
  const baselineConfig = initial
    ? JSON.stringify(initial.configJson, null, 2)
    : KIND_TEMPLATE.http
  const dirty =
    name !== baselineName ||
    (description ?? '') !== baselineDesc ||
    kind !== baselineKind ||
    configRaw !== baselineConfig
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const opts: DropdownOption<ToolKind>[] = useMemo(
    () => toolKinds.map((k) => ({ value: k, label: KIND_LABEL[k] })),
    [],
  )

  const submit = async () => {
    setErr(null)
    let configJson: Record<string, unknown> | undefined
    if (configRaw.trim() && configRaw.trim() !== '{}') {
      try {
        const parsed = JSON.parse(configRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          configJson = parsed as Record<string, unknown>
        } else {
          setErr('Config must be a JSON object.')
          return
        }
      } catch {
        setErr('Invalid JSON in config.')
        return
      }
    }

    if (isEdit) {
      const parsed = toolUpdateInputSchema.safeParse({
        name: name.trim(),
        description: description.trim() || undefined,
        configJson,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid tool')
        return
      }
      setBusy(true)
      try {
        await patchTool(agentId, toolId!, parsed.data)
        toast.success('Tool updated')
        onClose()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Update failed',
        )
      } finally {
        setBusy(false)
      }
    } else {
      const parsed = toolCreateInputSchema.safeParse({
        kind,
        name: name.trim(),
        description: description.trim() || undefined,
        configJson,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid tool')
        return
      }
      setBusy(true)
      try {
        await createTool(agentId, parsed.data)
        toast.success(`Tool “${name.trim()}” added`)
        onClose()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to add tool',
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
      title={isEdit ? 'Edit tool' : 'Add tool'}
      subtitle={
        isEdit
          ? 'Tweak the tool definition the agent calls during a run.'
          : "A tool becomes a callable function the LLM can pick mid-run."
      }
      primaryLabel={isEdit ? 'Save changes' : 'Add tool'}
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!name.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bt-name">
          Name
        </label>
        <input
          id="bt-name"
          className="ab-input ab-mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="summarise_pr"
          autoFocus
        />
        <span className="ab-field-help">
          snake_case. Becomes the function name your IDE calls.
        </span>
      </div>
      <div className="ab-field">
        <span className="ab-field-label">Kind</span>
        {isEdit ? (
          <input
            className="ab-input ab-mono"
            value={kind}
            disabled
            title="Tool kind is fixed after creation."
          />
        ) : (
          <Dropdown<ToolKind> value={kind} onChange={setKind} options={opts} />
        )}
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bt-desc">
          Description
        </label>
        <textarea
          id="bt-desc"
          className="ab-textarea"
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this tool does — the IDE shows this to the user."
        />
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bt-config">
          Config (JSON)
        </label>
        <textarea
          id="bt-config"
          className="ab-textarea ab-mono"
          value={configRaw}
          onChange={(e) => setConfigRaw(e.target.value)}
          rows={6}
          spellCheck={false}
        />
        <span className="ab-field-help">{KIND_HINT[kind]}</span>
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

export function ToolSheet({
  open,
  agentId,
  toolId,
  onClose,
}: {
  open: boolean
  agentId: string
  toolId?: string | null
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
      <Sheet open={false} onClose={onClose} title="Add bridge tool">
        <></>
      </Sheet>
    )
  }
  return (
    <ToolForm
      key={`${openCount}:${toolId ?? 'new'}`}
      agentId={agentId}
      toolId={toolId ?? null}
      onClose={onClose}
    />
  )
}
