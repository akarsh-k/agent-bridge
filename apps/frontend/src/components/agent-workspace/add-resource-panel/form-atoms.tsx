import type { ReactNode } from 'react'

export function AddFormActions({
  submitLabel,
  busy,
  disabled,
  onCancel,
  leading,
}: {
  readonly submitLabel: string
  readonly busy: boolean
  readonly disabled: boolean
  readonly onCancel: () => void
  /** When set (e.g. destructive edit actions), lays out leading | Cancel + Submit */
  readonly leading?: ReactNode
}) {
  const split = leading != null
  return (
    <div
      className={`add-resource-actions${split ? ' add-resource-actions--split' : ''}`}
    >
      {split ? (
        <div className="add-resource-actions-leading">{leading}</div>
      ) : null}
      <div className="add-resource-actions-end">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || disabled}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

export function ErrorText({ message }: { readonly message: string | null }) {
  if (!message) return null
  return (
    <div className="status-strip error" role="alert">
      {message}
    </div>
  )
}
