/**
 * Retrieval Scorecard question-row model: pure helpers shared by the tab and
 * the question-card components.
 */

import type {
  ScorecardQueryInput,
  ScorecardQueryRow,
} from '@agent-bridge/shared'

/** A question's editable values, as strings the form binds to. */
export interface QVals {
  query: string
  /** One expected-answer snippet per line. */
  expected: string
  expectedPage: string
  note: string
}

/**
 * One question row. `committed` is the last-saved snapshot (null until the
 * row is first saved); `draft` is the live edit buffer. `id` is a stable
 * client key, independent of the server uuid (saves rewrite the whole set,
 * so server ids churn).
 */
export interface QRow {
  id: string
  committed: QVals | null
  draft: QVals
  editing: boolean
}

export const emptyVals = (): QVals => ({
  query: '',
  expected: '',
  expectedPage: '',
  note: '',
})

/** Expected-answer snippets: one per non-blank line, trimmed. */
export function snippetList(v: QVals): string[] {
  return v.expected
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function valsFromRow(r: ScorecardQueryRow): QVals {
  return {
    query: r.query,
    expected: (r.expectedSnippets ?? []).join('\n'),
    expectedPage: r.expectedPage != null ? String(r.expectedPage) : '',
    note: r.note ?? '',
  }
}

/** Trim + canonicalize so the saved card mirrors what was persisted. */
export function normalizeVals(v: QVals): QVals {
  const page = v.expectedPage.trim()
    ? Number.parseInt(v.expectedPage, 10)
    : null
  const validPage = page != null && Number.isFinite(page) && page > 0
  return {
    query: v.query.trim(),
    expected: snippetList(v).join('\n'),
    expectedPage: validPage ? String(page) : '',
    note: v.note.trim(),
  }
}

export function valsToInput(v: QVals): ScorecardQueryInput {
  const n = normalizeVals(v)
  return {
    query: n.query,
    expectedSnippets: snippetList(n),
    expectedPage: n.expectedPage ? Number.parseInt(n.expectedPage, 10) : null,
    note: n.note,
  }
}

export const newRow = (): QRow => ({
  id: crypto.randomUUID(),
  committed: null,
  draft: emptyVals(),
  editing: true,
})

export function rowFromSaved(r: ScorecardQueryRow): QRow {
  const v = valsFromRow(r)
  return { id: r.id, committed: v, draft: v, editing: false }
}

/** Values to score: the live draft while editing, else the saved snapshot. */
export const effectiveVals = (r: QRow): QVals =>
  r.editing ? r.draft : (r.committed ?? r.draft)
