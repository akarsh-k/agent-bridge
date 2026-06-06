/**
 * A single Retrieval Scorecard question row: the read-only card at rest and
 * the inline edit form, each with its own actions.
 */

import type { ReactElement } from 'react'

import { Button } from '../../ui/button'
import { type QRow, type QVals, snippetList } from './scorecard-model'

/** A saved question at rest: query + a one-line summary, with Edit / Remove. */
export function QuestionCard({
  row,
  index,
  busy,
  removing,
  error,
  onEdit,
  onRemove,
}: {
  row: QRow
  index: number
  busy: boolean
  removing: boolean
  error?: string
  onEdit: () => void
  onRemove: () => void
}) {
  const v = row.committed ?? row.draft
  const snippets = snippetList(v)
  const meta: ReactElement[] = []
  if (snippets.length > 0) {
    meta.push(
      <span className="ab-sc-q-expects" key="exp">
        <span className="ab-sc-q-expects-snippet">“{snippets[0]}”</span>
        {snippets.length > 1 && (
          <span className="ab-sc-q-expects-more">
            +{snippets.length - 1} more
          </span>
        )}
      </span>,
    )
  } else if (v.expectedPage) {
    meta.push(<span key="exp">Expects page {v.expectedPage}</span>)
  } else {
    meta.push(
      <span className="ab-sc-q-muted" key="exp">
        No expected answer
      </span>,
    )
  }
  if (snippets.length > 0 && v.expectedPage) {
    meta.push(<span key="pg">p.{v.expectedPage}</span>)
  }
  if (v.note) {
    meta.push(
      <span className="ab-sc-q-muted ab-sc-q-clip" key="note">
        {v.note}
      </span>,
    )
  }

  return (
    <div className="ab-sc-q ab-sc-q-view">
      <div className="ab-sc-q-view-head">
        <p className="ab-sc-q-view-q">{v.query}</p>
        <div className="ab-sc-q-view-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={busy}
            aria-label={`Edit question ${index + 1}`}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove question ${index + 1}`}
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </div>
      <div className="ab-sc-q-view-meta">{meta}</div>
      {error && <p className="ab-sc-q-error">{error}</p>}
    </div>
  )
}

/** A question open for editing: the form plus its own Save / Cancel. */
export function QuestionEditor({
  row,
  index,
  error,
  saving,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  row: QRow
  index: number
  error?: string
  saving: boolean
  busy: boolean
  onChange: (patch: Partial<QVals>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const d = row.draft
  return (
    <div className="ab-sc-q ab-sc-q-edit">
      <input
        className="ab-input"
        placeholder="Question, e.g. What is the refund window?"
        aria-label={`Question ${index + 1}`}
        value={d.query}
        onChange={(e) => onChange({ query: e.target.value })}
      />
      <textarea
        className="ab-textarea"
        rows={2}
        placeholder="Expected answer text. One acceptable snippet per line (substring match)."
        aria-label={`Expected answer for question ${index + 1}`}
        value={d.expected}
        onChange={(e) => onChange({ expected: e.target.value })}
      />
      <div className="ab-sc-q-meta">
        <input
          className="ab-input ab-sc-page"
          placeholder="Page (opt.)"
          inputMode="numeric"
          aria-label={`Expected page for question ${index + 1}`}
          value={d.expectedPage}
          onChange={(e) => onChange({ expectedPage: e.target.value })}
        />
        <input
          className="ab-input ab-sc-note"
          placeholder="Note (optional): what this question probes"
          aria-label={`Note for question ${index + 1}`}
          value={d.note}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </div>
      {error && <p className="ab-sc-q-error">{error}</p>}
      <div className="ab-sc-q-actions">
        <Button variant="primary" size="sm" onClick={onSave} disabled={busy}>
          {saving ? 'Saving…' : 'Save question'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
