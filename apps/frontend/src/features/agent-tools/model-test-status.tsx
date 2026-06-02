/**
 * Inline status pill that surfaces the latest test result for a model
 * id. Used under model dropdowns (provider-edit page, agent build
 * tab) so the operator sees pass/fail right where they made the
 * choice, without having to scroll to a separate test surface.
 *
 * Idle state renders nothing — no noise on first load before any
 * test has actually fired.
 */

export type ModelTestState = 'pending' | 'ok' | 'error' | undefined

export function ModelTestStatus({
  model,
  state,
  message,
}: {
  model: string
  state: ModelTestState
  message: string | undefined
}) {
  if (!model || !state) return null

  if (state === 'pending') {
    return (
      <span className="ab-model-test-status ab-model-test-status--pending">
        Testing {model}…
      </span>
    )
  }
  if (state === 'ok') {
    return (
      <span
        className="ab-model-test-status ab-model-test-status--ok"
        title={message ?? undefined}
      >
        ✓ Passed{message ? ` · ${message}` : ''}
      </span>
    )
  }
  return (
    <span
      className="ab-model-test-status ab-model-test-status--error"
      title={message ?? undefined}
    >
      ✕ Failed
      {message
        ? ` · ${message.length > 60 ? message.slice(0, 60) + '…' : message}`
        : ''}
    </span>
  )
}
