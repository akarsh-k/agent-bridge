/**
 * Retrieval Scorecard tab.
 *
 * Author test questions (query + the answer text the right chunk should
 * contain), pick which retrieval strategies to compare, hit Run, and
 * read a side-by-side scorecard: per-strategy hit-rate / MRR / nDCG /
 * precision, plus a per-question drill-down of what each strategy
 * actually returned.
 *
 * "Run" scores the CURRENT (possibly unsaved) edits; "Save" persists the
 * set so it's reusable across sessions. Relevance is judged by substring
 * match against the expected snippets (one per line).
 *
 * Styling: colocated scorecard.css (imported via styles/index.css).
 */

import { useEffect, useState } from 'react'

import {
  scorecardStrategyIds,
  scorecardStrategyMeta,
  type ScorecardQueryInput,
  type ScorecardQueryRow,
  type ScorecardRunResult,
  type ScorecardStrategyId,
} from '@agent-bridge/shared'

import {
  ApiError,
  getScorecardQueries,
  runScorecard,
  saveScorecardQueries,
} from '../../lib/rpc'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'

interface DraftQuery {
  /** Stable client id for React keys (the saved row's uuid, or a fresh
   *  one for unsaved rows) so removing a row doesn't reuse inputs by
   *  position. */
  id: string
  query: string
  /** One expected-answer snippet per line. */
  expected: string
  expectedPage: string
  note: string
}

function newDraft(): DraftQuery {
  return {
    id: crypto.randomUUID(),
    query: '',
    expected: '',
    expectedPage: '',
    note: '',
  }
}

function toDraft(r: ScorecardQueryRow): DraftQuery {
  return {
    id: r.id,
    query: r.query,
    expected: (r.expectedSnippets ?? []).join('\n'),
    expectedPage: r.expectedPage != null ? String(r.expectedPage) : '',
    note: r.note ?? '',
  }
}

function toInput(d: DraftQuery): ScorecardQueryInput {
  const expectedSnippets = d.expected
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const pageNum = d.expectedPage.trim()
    ? Number.parseInt(d.expectedPage, 10)
    : null
  return {
    query: d.query.trim(),
    expectedSnippets,
    expectedPage:
      pageNum != null && Number.isFinite(pageNum) && pageNum > 0
        ? pageNum
        : null,
    note: d.note.trim(),
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const dec = (x: number) => x.toFixed(3)

function CheckGlyph() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2 5 8.6 9.6 3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ScorecardTab({ agentId }: { agentId: string }) {
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [drafts, setDrafts] = useState<DraftQuery[]>([])
  const [selected, setSelected] = useState<Set<ScorecardStrategyId>>(
    () => new Set(scorecardStrategyIds),
  )
  const [topK, setTopK] = useState(5)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [result, setResult] = useState<ScorecardRunResult | null>(null)

  // Reset per-agent state when the agent prop changes (adjust-state-on-
  // prop-change, the same pattern the agent detail page uses for tabs).
  // Keeps setState out of the effect body, so no cascading renders.
  const [activeAgent, setActiveAgent] = useState(agentId)
  if (activeAgent !== agentId) {
    setActiveAgent(agentId)
    setLoad('loading')
    setResult(null)
    setRunError('')
    setSaveMsg('')
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const rows = await getScorecardQueries(agentId)
        if (!alive) return
        setDrafts(rows.length > 0 ? rows.map(toDraft) : [newDraft()])
        setLoad('ready')
      } catch (err) {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load')
        setLoad('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId])

  const update = (i: number, patch: Partial<DraftQuery>) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)))
  const addRow = () => setDrafts((ds) => [...ds, newDraft()])
  const removeRow = (i: number) =>
    setDrafts((ds) => (ds.length <= 1 ? ds : ds.filter((_, idx) => idx !== i)))

  const validInputs = (): ScorecardQueryInput[] =>
    drafts.map(toInput).filter((q) => q.query.length > 0)

  const toggleStrategy = (id: ScorecardStrategyId) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function onSave() {
    setSaving(true)
    setSaveMsg('')
    try {
      const saved = await saveScorecardQueries(agentId, validInputs())
      setDrafts(saved.length > 0 ? saved.map(toDraft) : [newDraft()])
      setSaveMsg(
        `Saved ${saved.length} question${saved.length === 1 ? '' : 's'}.`,
      )
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function onRun() {
    const queries = validInputs()
    if (queries.length === 0) {
      setRunError('Add at least one question with text before running.')
      return
    }
    if (selected.size === 0) {
      setRunError('Select at least one strategy to compare.')
      return
    }
    setRunning(true)
    setRunError('')
    try {
      const res = await runScorecard(agentId, {
        strategyIds: scorecardStrategyIds.filter((id) => selected.has(id)),
        topK,
        queries,
      })
      setResult(res)
    } catch (err) {
      setRunError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Run failed',
      )
    } finally {
      setRunning(false)
    }
  }

  if (load === 'loading') {
    return (
      <div className="ab-tab-skeleton">
        <div className="ab-card ab-card-pad">
          <span className="ab-sc-loading">Loading test questions…</span>
        </div>
      </div>
    )
  }
  if (load === 'error') {
    return (
      <div className="ab-card ab-card-pad">
        <span className="ab-sc-run-error">{loadError}</span>
      </div>
    )
  }

  return (
    <div>
      {/* Intro */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-title">Retrieval scorecard</div>
        <div className="ab-section-sub">
          Measure how well retrieval finds the right passages in this agent's
          attached files. Write questions and the answer text the right chunk
          should contain, then compare strategies against your expected answers.
        </div>
      </div>

      {/* Question editor */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-sc-head">
          <div className="ab-section-title">Test questions</div>
          <span className="ab-sc-count">
            {drafts.length} question{drafts.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="ab-sc-questions">
          {drafts.map((d, i) => (
            <div className="ab-sc-q" key={d.id}>
              <div className="ab-sc-q-top">
                <input
                  className="ab-input"
                  placeholder="Question, e.g. What is the refund window?"
                  aria-label={`Question ${i + 1}`}
                  value={d.query}
                  onChange={(e) => update(i, { query: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(i)}
                  disabled={drafts.length <= 1}
                  aria-label={`Remove question ${i + 1}`}
                >
                  Remove
                </Button>
              </div>
              <textarea
                className="ab-textarea"
                rows={2}
                placeholder="Expected answer text. One acceptable snippet per line (substring match)"
                aria-label={`Expected answer for question ${i + 1}`}
                value={d.expected}
                onChange={(e) => update(i, { expected: e.target.value })}
              />
              <div className="ab-sc-q-meta">
                <input
                  className="ab-input ab-sc-page"
                  placeholder="Page (opt.)"
                  inputMode="numeric"
                  aria-label={`Expected page for question ${i + 1}`}
                  value={d.expectedPage}
                  onChange={(e) => update(i, { expectedPage: e.target.value })}
                />
                <input
                  className="ab-input ab-sc-note"
                  placeholder="Note (optional): what this question probes"
                  aria-label={`Note for question ${i + 1}`}
                  value={d.note}
                  onChange={(e) => update(i, { note: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="ab-sc-editor-actions">
          <Button variant="secondary" size="sm" onClick={addRow}>
            Add question
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save set'}
          </Button>
          {saveMsg && <span className="ab-sc-editor-msg">{saveMsg}</span>}
        </div>
      </div>

      {/* Strategy picker + run */}
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Strategies to compare</div>
          <div className="ab-section-sub">
            Each strategy runs the same questions; the scorecard shows where
            each finds the answer.
          </div>
        </div>

        <div className="ab-sc-strats">
          {scorecardStrategyIds.map((id) => {
            const on = selected.has(id)
            return (
              <button
                key={id}
                type="button"
                className={`ab-sc-strat${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleStrategy(id)}
              >
                <span className="ab-sc-strat-label">
                  <span className="ab-sc-strat-check">
                    <CheckGlyph />
                  </span>
                  {scorecardStrategyMeta[id].label}
                </span>
                <span className="ab-sc-strat-blurb">
                  {scorecardStrategyMeta[id].blurb}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ab-sc-run">
          <label className="ab-sc-topk">
            Results per question
            <input
              className="ab-input"
              inputMode="numeric"
              aria-label="Results per question (top-K)"
              value={String(topK)}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                setTopK(Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5)
              }}
            />
          </label>
          <Button variant="primary" onClick={onRun} disabled={running}>
            {running ? 'Running…' : 'Run scorecard'}
          </Button>
          {runError && <span className="ab-sc-run-error">{runError}</span>}
        </div>
      </div>

      {/* Results */}
      {result && <ScorecardResults result={result} />}
    </div>
  )
}

function ScorecardResults({ result }: { result: ScorecardRunResult }) {
  const best = {
    hitRate: Math.max(...result.aggregates.map((a) => a.hitRate), 0),
    mrr: Math.max(...result.aggregates.map((a) => a.mrr), 0),
    ndcg: Math.max(...result.aggregates.map((a) => a.ndcg), 0),
    precision: Math.max(...result.aggregates.map((a) => a.precision), 0),
  }
  const cell = (value: number, top: number, text: string) => (
    <td className={value > 0 && value === top ? 'ab-sc-cell-best' : undefined}>
      {text}
    </td>
  )

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-title">Results</div>
      <div className="ab-sc-summary">
        {result.judgedCount}/{result.queryCount} questions scored ·{' '}
        {result.fileCount} file{result.fileCount === 1 ? '' : 's'} · top-
        {result.topK} · <code>{result.embeddingModel}</code> ·{' '}
        {result.durationMs}ms
      </div>

      <div className="ab-sc-table-wrap">
        <table className="ab-sc-table">
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Hit-rate</th>
              <th scope="col">MRR</th>
              <th scope="col">nDCG</th>
              <th scope="col">Precision</th>
            </tr>
          </thead>
          <tbody>
            {result.aggregates.map((a) => (
              <tr key={a.strategyId}>
                <td className="ab-sc-strategy-name">{a.label}</td>
                {cell(a.hitRate, best.hitRate, pct(a.hitRate))}
                {cell(a.mrr, best.mrr, dec(a.mrr))}
                {cell(a.ndcg, best.ndcg, dec(a.ndcg))}
                {cell(a.precision, best.precision, pct(a.precision))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ab-sc-perq">
        {result.perQuery.map((q, i) => (
          <details className="ab-sc-qr" key={i}>
            <summary className="ab-sc-qr-summary">
              <span className="ab-sc-qr-q">{q.query}</span>
              <span className="ab-sc-qr-badges">
                {!q.judged && <Pill kind="neutral">not scored</Pill>}
                {q.judged &&
                  q.byStrategy.map((s) => (
                    <Pill
                      key={s.strategyId}
                      kind={s.hit ? 'success' : 'danger'}
                      dot
                    >
                      {scorecardStrategyMeta[s.strategyId].label.split(' ')[0]}
                      {s.firstRelevantRank ? ` #${s.firstRelevantRank}` : ''}
                    </Pill>
                  ))}
              </span>
            </summary>

            <div className="ab-sc-qr-body">
              {!q.judged && (
                <div className="ab-sc-unjudged">
                  No expected answer set. Shown for inspection, excluded from
                  scores.
                </div>
              )}
              {q.byStrategy.map((s) => (
                <div key={s.strategyId}>
                  <div className="ab-sc-strat-block-label">
                    {scorecardStrategyMeta[s.strategyId].label}
                  </div>
                  <div className="ab-sc-hits">
                    {s.hits.length === 0 && (
                      <div className="ab-sc-empty">No results.</div>
                    )}
                    {s.hits.map((h, hi) => (
                      <div
                        className={`ab-sc-hit${h.relevant ? ' is-relevant' : ''}`}
                        key={hi}
                      >
                        <div className="ab-sc-hit-head">
                          <span className="ab-sc-hit-rank">{hi + 1}.</span>
                          <span className="ab-sc-hit-loc">
                            {h.fileName}
                            {h.page != null ? ` · p.${h.page}` : ''}
                            {h.section ? ` · ${h.section}` : ''}
                          </span>
                          {h.relevant && (
                            <span className="ab-sc-hit-match">
                              <CheckGlyph /> match
                            </span>
                          )}
                        </div>
                        <div className="ab-sc-hit-snippet">{h.snippet}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
