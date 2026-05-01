/**
 * Inline status pill that surfaces the latest test result for a model
 * id. Used under model dropdowns (provider-edit page, agent build
 * tab) so the operator sees pass/fail right where they made the
 * choice, without having to scroll to a separate test surface.
 *
 * Idle state renders nothing — no noise on first load before any
 * test has actually fired.
 */

import type { CSSProperties } from 'react'

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
  const baseStyle: CSSProperties = {
    marginTop: 6,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    alignSelf: 'flex-start',
  }
  if (state === 'pending') {
    return (
      <span
        style={{
          ...baseStyle,
          color: 'var(--text-muted)',
          background: 'var(--surface-hi)',
        }}
      >
        Testing {model}…
      </span>
    )
  }
  if (state === 'ok') {
    return (
      <span
        style={{
          ...baseStyle,
          color: 'var(--success)',
          background: 'var(--success-bg)',
          borderColor: 'rgba(52, 211, 153, 0.28)',
        }}
        title={message ?? undefined}
      >
        ✓ Passed{message ? ` · ${message}` : ''}
      </span>
    )
  }
  return (
    <span
      style={{
        ...baseStyle,
        color: 'var(--danger)',
        background: 'var(--danger-bg)',
        borderColor: 'rgba(251, 113, 133, 0.3)',
      }}
      title={message ?? undefined}
    >
      ✕ Failed
      {message
        ? ` · ${message.length > 60 ? message.slice(0, 60) + '…' : message}`
        : ''}
    </span>
  )
}
