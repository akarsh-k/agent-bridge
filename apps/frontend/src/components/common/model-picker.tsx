/**
 * ModelPicker — autocomplete input backed by `<datalist>`.
 *
 * Why this shape (vs a custom combobox):
 *   - Plain HTML controls; no popover / focus-trap state to manage.
 *   - The native browser dropdown handles keyboard navigation, filtering,
 *     and "click outside to close" without extra code.
 *   - The user can always type a custom model id (the `<datalist>` is a
 *     suggestion list, not a constraint), so a model added upstream
 *     between refreshes is still usable.
 *
 * Used in three places: agent inspector's `model` field, llm-new-form's
 * `defaultModel` field, and the wiki button's `model` field. Same
 * `models` source (`provider.models?.models ?? []` from the response
 * cache populated by the refresh endpoint), same UX everywhere.
 */

import { useId } from 'react'

export interface ModelPickerProps {
  readonly value: string
  readonly onChange: (next: string) => void
  /**
   * The dropdown choices. Empty array = no autocomplete shown; the
   * input still accepts free text. Pass
   * `provider.models?.models ?? []` from the workspace context.
   */
  readonly models: readonly string[]
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly className?: string
  readonly ariaLabel?: string
  readonly inputId?: string
}

export function ModelPicker({
  value,
  onChange,
  models,
  placeholder,
  disabled,
  className,
  ariaLabel,
  inputId,
}: ModelPickerProps) {
  // `useId()` keeps the datalist id unique across multiple pickers on
  // one page — important because the agent inspector and the wiki
  // button can render side-by-side. A static id would let one
  // datalist's options bleed into another's input.
  const generatedId = useId()
  const listId = `model-picker-list-${generatedId}`

  return (
    <>
      <input
        id={inputId}
        list={models.length > 0 ? listId : undefined}
        type="text"
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {models.length > 0 ? (
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}
