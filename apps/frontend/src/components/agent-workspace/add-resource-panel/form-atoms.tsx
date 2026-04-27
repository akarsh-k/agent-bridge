export function AddFormActions({
  submitLabel,
  busy,
  disabled,
  onCancel,
}: {
  readonly submitLabel: string
  readonly busy: boolean
  readonly disabled: boolean
  readonly onCancel: () => void
}) {
  return (
    <div className="add-resource-actions">
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
