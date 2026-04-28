/**
 * Controlled editor for the key→secret maps behind `env_envelope` and
 * `headers_envelope` in `mcp_connections`.
 *
 * The editor owns two things:
 *   1. A list of `{ key, value }` pairs the user can add / edit / remove.
 *   2. A tri-state toggle between "set this map" / "leave unchanged" /
 *      "clear this map", matching the `SecretMapInput` DTO contract.
 *
 * Pure components only — state helpers live in `./secret-map-state.ts`
 * so this module plays nicely with React Fast Refresh.
 */

import { useCallback } from 'react'
import {
  makeRowId,
  type SecretMapAction,
  type SecretMapEditorMode,
  type SecretMapRow,
  type SecretMapState,
} from './secret-map-state'

export function SecretMapEditor({
  state,
  onChange,
  mode,
  hasStoredSecret,
  keyPlaceholder,
  valuePlaceholder,
  valueLabel = 'Value',
  disabled = false,
}: {
  readonly state: SecretMapState
  readonly onChange: (next: SecretMapState) => void
  readonly mode: SecretMapEditorMode
  readonly hasStoredSecret: boolean
  readonly keyPlaceholder: string
  readonly valuePlaceholder: string
  readonly valueLabel?: string
  readonly disabled?: boolean
}) {
  const isSet = state.action === 'set'

  const setAction = useCallback(
    (action: SecretMapAction) => {
      onChange({ action, rows: state.rows })
    },
    [onChange, state.rows],
  )

  const addRow = useCallback(() => {
    onChange({
      action: 'set',
      rows: [
        ...state.rows,
        { id: makeRowId(), key: '', value: '' },
      ],
    })
  }, [onChange, state.rows])

  const updateRow = useCallback(
    (id: string, patch: Partial<Pick<SecretMapRow, 'key' | 'value'>>) => {
      onChange({
        action: 'set',
        rows: state.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      })
    },
    [onChange, state.rows],
  )

  const removeRow = useCallback(
    (id: string) => {
      onChange({
        action: 'set',
        rows: state.rows.filter((r) => r.id !== id),
      })
    },
    [onChange, state.rows],
  )

  return (
    <div className="secret-map-editor">
      {mode === 'edit' && hasStoredSecret ? (
        <div className="secret-map-actions" role="radiogroup">
          <ActionRadio
            label="Keep current"
            active={state.action === 'unchanged'}
            disabled={disabled}
            onClick={() => setAction('unchanged')}
          />
          <ActionRadio
            label="Replace"
            active={state.action === 'set'}
            disabled={disabled}
            onClick={() => setAction('set')}
          />
          <ActionRadio
            label="Clear"
            active={state.action === 'clear'}
            disabled={disabled}
            onClick={() => setAction('clear')}
          />
        </div>
      ) : null}

      {isSet ? (
        <div className="secret-map-rows">
          {state.rows.length === 0 ? (
            <div className="secret-map-empty">No entries yet.</div>
          ) : (
            state.rows.map((row) => (
              <div key={row.id} className="secret-map-row">
                <input
                  className="field-mono secret-map-key"
                  value={row.key}
                  onChange={(e) => updateRow(row.id, { key: e.target.value })}
                  placeholder={keyPlaceholder}
                  maxLength={100}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  type="password"
                  className="field-mono secret-map-value"
                  value={row.value}
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  placeholder={valuePlaceholder}
                  aria-label={valueLabel}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="secret-map-remove"
                  onClick={() => removeRow(row.id)}
                  disabled={disabled}
                  aria-label={`Remove ${row.key || 'entry'}`}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm secret-map-add"
            onClick={addRow}
            disabled={disabled}
          >
            + Add entry
          </button>
        </div>
      ) : state.action === 'clear' ? (
        <div className="secret-map-clear-notice">
          Stored value will be cleared on save.
        </div>
      ) : (
        <div className="secret-map-unchanged-notice">
          Current value will be kept as-is.
        </div>
      )}
    </div>
  )
}

function ActionRadio({
  label,
  active,
  disabled,
  onClick,
}: {
  readonly label: string
  readonly active: boolean
  readonly disabled: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`secret-map-action${active ? ' active' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  )
}
