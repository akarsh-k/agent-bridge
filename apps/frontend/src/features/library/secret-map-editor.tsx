/**
 * Inline key/value editor for an MCP connection's encrypted secret map
 * — env vars (stdio) or HTTP headers (http/sse). Replaces the previous
 * read-only "Set / None" pill which left operators with no way to
 * actually input the values when they picked `auth: 'headers'` or when
 * a stdio MCP needed `NOTION_TOKEN=…` style env-var auth.
 *
 * UX:
 *   - Collapsed by default — shows the existing-presence pill ("Set"
 *     in green vs "None" neutral) plus a "Set" / "Replace" button.
 *   - Expanded — repeating rows of [KEY] [value] [×]. Add row, save,
 *     cancel. "Clear all" is shown when the secret is currently set.
 *
 * Replace-only semantics — values are encrypted at rest with a
 * sentinel response, so the API can't return current values to seed
 * the editor. The help line calls this out so operators don't think
 * they're appending; they're replacing.
 *
 * Save flows through `patchMcpConnection` with ONLY the relevant
 * field (`env` or `headers`), independent of the page's main "Save
 * changes" button — credential edits shouldn't get bundled with a
 * connection rename.
 */

import { useState } from 'react'
import { Pill } from '../../ui/pill'
import { Button } from '../../ui/button'

export interface SecretMapEditorProps {
  /** Display label, e.g. "Env vars" or "Headers". */
  label: string
  /** Whether the connection currently has any value persisted (sentinel
   *  from the response — we never see the plaintext). */
  present: boolean
  /** Placeholder for the key column (e.g. `NOTION_TOKEN`,
   *  `Authorization`). */
  keyPlaceholder: string
  /** Placeholder for the value column. */
  valuePlaceholder: string
  /** Optional one-line hint shown above the editor when expanded. */
  helpText?: string
  /** Called when the operator clicks Save with at least one non-empty
   *  key. Map is the full replacement. */
  onSave: (map: Record<string, string>) => Promise<void>
  /** Called when the operator clicks Clear (only shown when present). */
  onClear: () => Promise<void>
  /** Disabled while a parent save is in flight. */
  busy?: boolean
}

export function SecretMapEditor(props: SecretMapEditorProps) {
  const {
    label,
    present,
    keyPlaceholder,
    valuePlaceholder,
    helpText,
    onSave,
    onClear,
    busy,
  } = props
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([
    { key: '', value: '' },
  ])
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setRows([{ key: '', value: '' }])
    setOpen(false)
  }

  const addRow = () => setRows((r) => [...r, { key: '', value: '' }])

  const removeRow = (idx: number) => {
    setRows((r) => {
      if (r.length === 1) return [{ key: '', value: '' }]
      return r.filter((_, i) => i !== idx)
    })
  }

  const updateRow = (
    idx: number,
    patch: Partial<{ key: string; value: string }>,
  ) => {
    setRows((r) => {
      const next = [...r]
      const current = next[idx]
      if (!current) return r
      next[idx] = {
        key: patch.key ?? current.key,
        value: patch.value ?? current.value,
      }
      return next
    })
  }

  const save = async () => {
    const map: Record<string, string> = {}
    for (const row of rows) {
      const k = row.key.trim()
      if (k.length === 0) continue
      map[k] = row.value
    }
    if (Object.keys(map).length === 0) return
    setSaving(true)
    try {
      await onSave(map)
      reset()
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    try {
      await onClear()
      reset()
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <div className="ab-secret-map-collapsed">
        <Pill kind={present ? 'success' : 'neutral'} dot>
          {present ? 'Set' : 'None'}
        </Pill>
        <button
          type="button"
          className="ab-inline-action"
          onClick={() => setOpen(true)}
          disabled={busy || saving}
        >
          {present ? 'Replace' : 'Set'}
        </button>
        {present && (
          <button
            type="button"
            className="ab-inline-action"
            onClick={() => void clear()}
            disabled={busy || saving}
          >
            Clear
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="ab-secret-map-editor">
      <span className="ab-field-help">
        {helpText ? `${helpText} ` : ''}Saving will <strong>replace</strong> all
        existing {label.toLowerCase()}. Values are encrypted at rest; we can't
        show you what's currently stored.
      </span>
      {rows.map((row, idx) => (
        <div key={idx} className="ab-secret-map-row">
          <input
            className="ab-input ab-mono ab-secret-map-key"
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => updateRow(idx, { key: e.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
          <input
            className="ab-input ab-mono ab-secret-map-value"
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(e) => updateRow(idx, { value: e.target.value })}
            type="password"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="ab-inline-action"
            onClick={() => removeRow(idx)}
            title="Remove this row"
            aria-label="Remove row"
          >
            ×
          </button>
        </div>
      ))}
      <div className="ab-secret-map-footer">
        <button
          type="button"
          className="ab-inline-action"
          onClick={addRow}
          disabled={saving}
        >
          + add row
        </button>
        <span className="ab-secret-map-spacer" />
        <button
          type="button"
          className="ab-inline-action"
          onClick={reset}
          disabled={saving}
        >
          Cancel
        </button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
