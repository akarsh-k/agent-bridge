/**
 * Bridge tool side-sheet — handles both create and edit. Submits
 * directly via the bridge-tool RPC (these aren't in the workspace
 * cache).
 */

import { useState } from 'react'
import {
  bridgeToolCreateInputSchema,
  bridgeToolUpdateInputSchema,
  type BridgeToolResponse,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { ApiError, createBridgeTool, patchBridgeTool } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'

const DEFAULT_INPUT_SCHEMA = JSON.stringify(
  {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What the IDE wants to know',
      },
    },
    required: ['query'],
  },
  null,
  2,
)

const DEFAULT_PROMPT_TEMPLATE = `Answer the following question concisely:

{{query}}`

interface FormProps {
  agentId: string
  toolId: string | null
  existingTool: BridgeToolResponse | null
  onClose: () => void
  onSaved: () => void
}

function BridgeToolForm({
  agentId,
  toolId,
  existingTool,
  onClose,
  onSaved,
}: FormProps) {
  const [name, setName] = useState(existingTool?.name ?? '')
  const [description, setDescription] = useState(
    existingTool?.description ?? '',
  )
  const [inputSchemaRaw, setInputSchemaRaw] = useState(
    existingTool
      ? JSON.stringify(existingTool.inputSchema, null, 2)
      : DEFAULT_INPUT_SCHEMA,
  )
  const [promptTemplate, setPromptTemplate] = useState(
    existingTool?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE,
  )
  const [enabled, setEnabled] = useState(existingTool?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isEdit = toolId !== null

  // Dirty if any field diverges from the seeded baseline.
  const seededInputSchema = existingTool
    ? JSON.stringify(existingTool.inputSchema, null, 2)
    : DEFAULT_INPUT_SCHEMA
  const seededTemplate =
    existingTool?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE
  const dirty =
    name !== (existingTool?.name ?? '') ||
    description !== (existingTool?.description ?? '') ||
    inputSchemaRaw !== seededInputSchema ||
    promptTemplate !== seededTemplate ||
    enabled !== (existingTool?.enabled ?? true)
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
    setErr(null)
    let inputSchema: Record<string, unknown> | undefined
    if (inputSchemaRaw.trim()) {
      try {
        const parsed = JSON.parse(inputSchemaRaw) as unknown
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          setErr('Input schema must be a JSON object.')
          return
        }
        inputSchema = parsed as Record<string, unknown>
      } catch {
        setErr('Invalid JSON in input schema.')
        return
      }
    }

    if (isEdit) {
      const parsed = bridgeToolUpdateInputSchema.safeParse({
        name: name.trim(),
        description: description.trim() || undefined,
        inputSchema,
        promptTemplate: promptTemplate || undefined,
        enabled,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid bridge tool')
        return
      }
      setBusy(true)
      try {
        await patchBridgeTool(agentId, toolId!, parsed.data)
        toast.success('Bridge tool updated')
        onSaved()
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
      const parsed = bridgeToolCreateInputSchema.safeParse({
        name: name.trim(),
        description: description.trim() || undefined,
        inputSchema,
        promptTemplate: promptTemplate || undefined,
        enabled,
      })
      if (!parsed.success) {
        setErr(parsed.error.issues[0]?.message ?? 'Invalid bridge tool')
        return
      }
      setBusy(true)
      try {
        await createBridgeTool(agentId, parsed.data)
        toast.success(`Bridge tool “${name.trim()}” added`)
        onSaved()
      } catch (e) {
        setErr(
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to add bridge tool',
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
      title={isEdit ? 'Edit bridge tool' : 'Add bridge tool'}
      subtitle={
        isEdit
          ? 'Tweak the function the IDE sees.'
          : "A bridge tool is a typed function your IDE calls into the agent."
      }
      primaryLabel={isEdit ? 'Save changes' : 'Add bridge tool'}
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!name.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bbt-name">
          Name
        </label>
        <input
          id="bbt-name"
          className="ab-input ab-mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="summarise_pr"
          autoFocus
        />
        <span className="ab-field-help">
          Letters / digits / underscores. Becomes the IDE-side function name
          as <code className="ab-mono">query_&lt;slug&gt;__{name || '<name>'}</code>.
          The reserved <code className="ab-mono">query_</code> prefix is
          rejected — the bridge owns it.
        </span>
      </div>

      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bbt-desc">
          Description
        </label>
        <textarea
          id="bbt-desc"
          className="ab-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this tool does — the IDE shows this to the user when picking from the list."
        />
      </div>

      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bbt-schema">
          Input schema (JSON Schema)
        </label>
        <textarea
          id="bbt-schema"
          className="ab-textarea ab-mono"
          value={inputSchemaRaw}
          onChange={(e) => setInputSchemaRaw(e.target.value)}
          rows={10}
          spellCheck={false}
        />
        <span className="ab-field-help">
          JSON-Schema-shaped object describing the args the IDE passes.
          Required: <code className="ab-mono">type: 'object'</code>.
        </span>
      </div>

      <div className="ab-field">
        <label className="ab-field-label" htmlFor="bbt-template">
          Prompt template
        </label>
        <textarea
          id="bbt-template"
          className="ab-textarea ab-mono"
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={6}
          spellCheck={false}
        />
        <span className="ab-field-help">
          The agent fills <code className="ab-mono">{`{{field}}`}</code>{' '}
          placeholders with values from the IDE call before passing the
          rendered prompt to the LLM.
        </span>
      </div>

      <div className="ab-field">
        <label
          className="ab-field-label"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
        <span className="ab-field-help">
          Disabled tools stay defined but the bridge stops advertising them
          on the next IDE handshake.
        </span>
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

export function BridgeToolSheet({
  open,
  agentId,
  toolId,
  existingTool,
  onClose,
  onSaved,
}: {
  open: boolean
  agentId: string
  toolId: string | null
  existingTool: BridgeToolResponse | null
  onClose: () => void
  onSaved: () => void
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
    <BridgeToolForm
      key={`${openCount}:${toolId ?? 'new'}`}
      agentId={agentId}
      toolId={toolId}
      existingTool={existingTool}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}
