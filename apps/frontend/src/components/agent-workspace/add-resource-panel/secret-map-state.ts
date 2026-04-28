/**
 * Non-component module for `SecretMapEditor` helpers. Split out from
 * `secret-map-editor.tsx` so the `.tsx` file exports only components
 * (required by the `react-refresh/only-export-components` rule the
 * frontend's ESLint config enforces for HMR).
 */

import { useMemo, useState } from 'react'
import type { SecretMapInput } from '@agent-bridge/shared'

export type SecretMapEditorMode = 'create' | 'edit'

export interface SecretMapRow {
  readonly id: string
  readonly key: string
  readonly value: string
}

export type SecretMapAction = 'set' | 'unchanged' | 'clear'

export interface SecretMapState {
  readonly action: SecretMapAction
  readonly rows: readonly SecretMapRow[]
}

/**
 * Build the initial state. For `edit` mode the editor starts in
 * "unchanged" when there's a stored envelope — the backend never hands
 * back plaintext, so "set" would be misleading (we can't prefill). The
 * user explicitly opts into replacing the value.
 */
export function makeInitialMapState(
  mode: SecretMapEditorMode,
  hasStoredSecret: boolean,
): SecretMapState {
  if (mode === 'create') {
    return { action: 'set', rows: [] }
  }
  return {
    action: hasStoredSecret ? 'unchanged' : 'set',
    rows: [],
  }
}

export function useSecretMapState(
  mode: SecretMapEditorMode,
  hasStoredSecret: boolean,
): [SecretMapState, (next: SecretMapState) => void] {
  const initial = useMemo(
    () => makeInitialMapState(mode, hasStoredSecret),
    // Snapshot once per mount; prop flips mid-lifetime would be
    // meaningless (the form can't change mode without remounting).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  return useState<SecretMapState>(initial)
}

/**
 * Collapse editor state into the `SecretMapInput` DTO shape the backend
 * wants. Returns `undefined` when there's nothing to send (create-mode
 * with no rows), so the caller can spread it conditionally.
 */
export function secretMapStateToInput(
  state: SecretMapState,
  mode: SecretMapEditorMode,
): SecretMapInput | undefined {
  if (state.action === 'unchanged') {
    return mode === 'edit' ? { action: 'unchanged' } : undefined
  }
  if (state.action === 'clear') return { action: 'clear' }
  const plaintext = rowsToRecord(state.rows)
  if (Object.keys(plaintext).length === 0) {
    return mode === 'create' ? undefined : { action: 'clear' }
  }
  return { action: 'set', plaintext }
}

/**
 * Validate the visible rows. Returns the first issue as a string or
 * null if everything's shipshape. Matches the backend refine so the
 * user sees the error inline without a roundtrip.
 */
export function validateSecretMapState(
  state: SecretMapState,
): string | null {
  if (state.action !== 'set') return null
  const seenKeys = new Set<string>()
  for (const row of state.rows) {
    if (row.key.length === 0 && row.value.length === 0) continue
    if (row.key.length === 0) return 'every entry needs a key'
    if (!/^[A-Za-z0-9_.-]+$/.test(row.key)) {
      return `key "${row.key}" contains invalid characters`
    }
    if (seenKeys.has(row.key)) return `duplicate key "${row.key}"`
    seenKeys.add(row.key)
    if (row.value.length === 0) return `value for "${row.key}" is empty`
    if (/[\r\n]/.test(row.value)) {
      return `value for "${row.key}" cannot contain newlines`
    }
  }
  return null
}

export function makeRowId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function rowsToRecord(
  rows: readonly SecretMapRow[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (row.key.length === 0 && row.value.length === 0) continue
    if (row.key.length === 0) continue
    out[row.key] = row.value
  }
  return out
}
