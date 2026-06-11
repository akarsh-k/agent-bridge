/**
 * Retrieval Scorecard tab.
 *
 * Author test questions (query + the answer text the right chunk should
 * contain), pick which retrieval strategies to compare, hit Run, and
 * read a side-by-side scorecard: per-strategy hit-rate / MRR / nDCG /
 * precision, plus a per-question drill-down of what each strategy
 * actually returned.
 *
 * Each question saves on its own: the form collapses to a compact
 * read-only card, and Edit reopens it. "Run" scores the current state,
 * including any open edits. Relevance is judged by substring match against
 * the expected snippets (one per line).
 *
 * Styling: colocated scorecard.css (imported via styles/index.css).
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  scorecardStrategyIds,
  scorecardStrategyMeta,
  scorecardStreamId,
  type ScorecardQueryInput,
  type ScorecardRunProgressPayload,
  type ScorecardRunResponse,
  type ScorecardStrategyId,
} from '@agent-bridge/shared'

import {
  ApiError,
  getScorecardQueries,
  runScorecard,
  saveScorecardQueries,
  setScorecardBaseline,
} from '../../lib/rpc'
import { useSSE } from '../../lib/use-sse'
import { formatEta } from '../../lib/format-eta'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { Tooltip } from '../../ui/tooltip'

import { QuestionCard, QuestionEditor } from './question-card'
import {
  effectiveVals,
  newRow,
  normalizeVals,
  rowFromSaved,
  valsToInput,
  type QRow,
  type QVals,
} from './scorecard-model'

const dropKey = (obj: Record<string, string>, key: string) => {
  if (!(key in obj)) return obj
  const next = { ...obj }
  delete next[key]
  return next
}

// Tolerate a missing metric (e.g. a run from before the metric existed, or a
// backend still serving the old engine) — render "–" instead of "NaN".
const pct = (x: number) =>
  Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–'
const dec = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '–')

/** Raw "180627ms" reads poorly; show "3m 1s" / "4.2s" / "850ms". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  // Round to whole seconds first, then split, so the remainder is never 60.
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Compact run timestamp, e.g. "Jun 6, 11:00 PM". */
function fmtRunDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

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

function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
      <path
        d="M8 7.2v4.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Metric columns + a one-line plain-English tooltip for each. Order matches
 *  the per-row cells in ScorecardResults. */
const METRIC_HEADERS: ReadonlyArray<readonly [label: string, info: string]> = [
  ['Hit-rate', 'Questions where a relevant chunk reached the top-K'],
  ['Coverage', "Avg fraction of a question's answer pieces retrieved"],
  ['MRR', '1 / rank of the first relevant chunk, averaged'],
  ['nDCG', 'Rewards ranking the relevant chunks higher in the list'],
  ['Precision', 'Fraction of the returned chunks that were relevant'],
]

export function ScorecardTab({ agentId }: { agentId: string }) {
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [rows, setRows] = useState<QRow[]>([])
  const [selected, setSelected] = useState<Set<ScorecardStrategyId>>(
    () => new Set(scorecardStrategyIds),
  )
  const [topK, setTopK] = useState(5)
  // Row id with a save/remove in flight; locks the other Saves (each save
  // rewrites the whole set, so concurrent ones could clobber).
  const [pendingId, setPendingId] = useState<string | null>(null)
  // Per-row validation / save errors, keyed by row id.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // "Saved." / "Removed." text for the aria-live status region.
  const [statusMsg, setStatusMsg] = useState('')
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [result, setResult] = useState<ScorecardRunResponse | null>(null)
  // Run id the operator pinned as baseline this session (so the button flips
  // to "baseline" without a refetch).
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null)
  const [pinMsg, setPinMsg] = useState('')

  // ── Live run progress over SSE. Subscribed only while a run is in
  //    flight; the backend publishes one event per finished question,
  //    so the bar and estimate track the rerank model's real pace.
  const { events: runEvents } = useSSE(
    running ? scorecardStreamId(agentId) : null,
    { cap: 16 },
  )
  const runProgress = useMemo(() => {
    let first: { ts: number; done: number } | null = null
    let last: { ts: number; done: number; total: number } | null = null
    for (let i = runEvents.length - 1; i >= 0; i--) {
      const ev = runEvents[i]
      if (!ev || ev.kind !== 'scorecard.run.progress') continue
      const p = ev.data as Partial<ScorecardRunProgressPayload> | null
      if (
        typeof p?.queriesDone !== 'number' ||
        typeof p.queriesTotal !== 'number'
      ) {
        continue
      }
      if (!last) {
        last = { ts: ev.ts, done: p.queriesDone, total: p.queriesTotal }
      }
      first = { ts: ev.ts, done: p.queriesDone }
    }
    if (!last || !first) return null
    const dDone = last.done - first.done
    const dMs = last.ts - first.ts
    const etaSeconds =
      dDone > 0 && dMs > 0
        ? ((last.total - last.done) * dMs) / dDone / 1000
        : null
    return { done: last.done, total: last.total, etaSeconds }
  }, [runEvents])

  // Run token for async guards: `onRun` captures the token it started
  // with and applies nothing once a newer run (or an agent switch)
  // bumps it. Comparing agent ids is not enough: switching A → B → A
  // would re-arm a stale closure.
  const runSeqRef = useRef(0)

  // Reset per-agent state when the agent prop changes (adjust-state-on-
  // prop-change, the same pattern the agent detail page uses for tabs).
  const [activeAgent, setActiveAgent] = useState(agentId)
  if (activeAgent !== agentId) {
    setActiveAgent(agentId)
    setLoad('loading')
    setResult(null)
    setRunError('')
    setStatusMsg('')
    setRowErrors({})
    setPendingId(null)
    setPinnedRunId(null)
    setPinMsg('')
    // Also drop `running`: it gates the progress SSE subscription, and
    // carrying it across agents would subscribe to the NEW agent's
    // stream for a run this tab never started. Bumping the run token
    // orphans the in-flight request (see `onRun`).
    setRunning(false)
    runSeqRef.current += 1
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const saved = await getScorecardQueries(agentId)
        if (!alive) return
        setRows(saved.map(rowFromSaved))
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

  const busy = pendingId !== null

  const patchRow = (id: string, fn: (r: QRow) => QRow) =>
    setRows((rs) => rs.map((r) => (r.id === id ? fn(r) : r)))

  const setDraft = (id: string, patch: Partial<QVals>) =>
    patchRow(id, (r) => ({ ...r, draft: { ...r.draft, ...patch } }))

  const beginEdit = (id: string) => {
    setStatusMsg('')
    setRowErrors((e) => dropKey(e, id))
    patchRow(id, (r) => ({
      ...r,
      editing: true,
      draft: r.committed ?? r.draft,
    }))
  }

  // Cancel discards edits; a never-saved row is dropped entirely.
  const cancelEdit = (id: string) => {
    setRowErrors((e) => dropKey(e, id))
    setRows((rs) =>
      rs.flatMap((r) => {
        if (r.id !== id) return [r]
        if (r.committed == null) return []
        return [{ ...r, editing: false, draft: r.committed }]
      }),
    )
  }

  const addRow = () => {
    setStatusMsg('')
    setRows((rs) => [...rs, newRow()])
  }

  // Persist the whole committed set (the API is replace-all): override one
  // row (null drops it); other saved rows ride along, unsaved drafts don't.
  const persistSet = (rowsNow: QRow[], id: string, override: QVals | null) =>
    saveScorecardQueries(
      agentId,
      rowsNow
        .map((r) => (r.id === id ? override : r.committed))
        .filter((v): v is QVals => v != null && v.query.trim() !== '')
        .map(valsToInput),
    )

  async function saveRow(id: string) {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (row.draft.query.trim() === '') {
      setRowErrors((e) => ({ ...e, [id]: 'Enter a question before saving.' }))
      return
    }
    const next = normalizeVals(row.draft)
    setRowErrors((e) => dropKey(e, id))
    setPendingId(id)
    try {
      await persistSet(rows, id, next)
      patchRow(id, (r) => ({
        ...r,
        committed: next,
        draft: next,
        editing: false,
      }))
      setStatusMsg('Saved.')
    } catch (err) {
      setRowErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : 'Save failed',
      }))
    } finally {
      setPendingId(null)
    }
  }

  async function removeRow(id: string) {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (row.committed == null) {
      setRows((rs) => rs.filter((r) => r.id !== id))
      setStatusMsg('Removed.')
      return
    }
    setRowErrors((e) => dropKey(e, id))
    setPendingId(id)
    try {
      await persistSet(rows, id, null)
      setRows((rs) => rs.filter((r) => r.id !== id))
      setStatusMsg('Removed.')
    } catch (err) {
      setRowErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : 'Remove failed',
      }))
    } finally {
      setPendingId(null)
    }
  }

  const toggleStrategy = (id: ScorecardStrategyId) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Queries to score: each row's effective values, open edits included.
  const runQueries = (): ScorecardQueryInput[] =>
    rows
      .map(effectiveVals)
      .map(valsToInput)
      .filter((q) => q.query.length > 0)

  async function onRun() {
    const queries = runQueries()
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
    setPinnedRunId(null)
    setPinMsg('')
    const runSeq = ++runSeqRef.current
    try {
      const res = await runScorecard(agentId, {
        strategyIds: scorecardStrategyIds.filter((id) => selected.has(id)),
        topK,
        queries,
      })
      if (runSeqRef.current !== runSeq) return
      setResult(res)
    } catch (err) {
      if (runSeqRef.current !== runSeq) return
      setRunError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Run failed',
      )
    } finally {
      if (runSeqRef.current === runSeq) setRunning(false)
    }
  }

  async function onSetBaseline(runId: string) {
    setPinMsg('')
    try {
      await setScorecardBaseline(agentId, runId)
      setPinnedRunId(runId)
      setPinMsg('Saved as baseline. Future runs compare against this one.')
    } catch (err) {
      setPinMsg(err instanceof Error ? err.message : 'Failed to set baseline')
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
          {rows.length > 0 && (
            <span className="ab-sc-count">
              {rows.length} question{rows.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="ab-sc-empty-state">
            <p className="ab-sc-empty-title">No test questions yet.</p>
            <p className="ab-sc-empty-sub">
              Add a question and the answer text the right chunk should contain.
            </p>
            <Button variant="primary" size="sm" onClick={addRow}>
              Add question
            </Button>
          </div>
        ) : (
          <>
            <div className="ab-sc-questions">
              {rows.map((r, i) =>
                r.editing ? (
                  <QuestionEditor
                    key={r.id}
                    row={r}
                    index={i}
                    error={rowErrors[r.id]}
                    saving={pendingId === r.id}
                    busy={busy}
                    onChange={(patch) => setDraft(r.id, patch)}
                    onSave={() => saveRow(r.id)}
                    onCancel={() => cancelEdit(r.id)}
                  />
                ) : (
                  <QuestionCard
                    key={r.id}
                    row={r}
                    index={i}
                    busy={busy}
                    removing={pendingId === r.id}
                    error={rowErrors[r.id]}
                    onEdit={() => beginEdit(r.id)}
                    onRemove={() => removeRow(r.id)}
                  />
                ),
              )}
            </div>

            <div className="ab-sc-editor-actions">
              <Button variant="secondary" size="sm" onClick={addRow}>
                Add question
              </Button>
            </div>
            {/* Card collapse (save) / removal is the visible cue; this just
                announces it to screen readers. */}
            <span className="sr-only" role="status" aria-live="polite">
              {statusMsg}
            </span>
          </>
        )}
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
          {running && runProgress && (
            <span className="ab-sc-run-progress">
              <span className="ab-sc-run-progress-track" aria-hidden="true">
                <span
                  className="ab-sc-run-progress-fill"
                  style={{
                    width: `${(runProgress.done / Math.max(runProgress.total, 1)) * 100}%`,
                  }}
                />
              </span>
              {runProgress.done} / {runProgress.total} questions
              {runProgress.etaSeconds != null
                ? ` · ${formatEta(runProgress.etaSeconds)}`
                : ''}
            </span>
          )}
          {runError && <span className="ab-sc-run-error">{runError}</span>}
        </div>
      </div>

      {/* Results */}
      {result && (
        <ScorecardResults
          result={result}
          onSetBaseline={onSetBaseline}
          pinnedRunId={pinnedRunId}
          pinMsg={pinMsg}
        />
      )}
    </div>
  )
}

function ScorecardResults({
  result,
  onSetBaseline,
  pinnedRunId,
  pinMsg,
}: {
  result: ScorecardRunResponse
  onSetBaseline: (runId: string) => void
  pinnedRunId: string | null
  pinMsg: string
}) {
  const best = {
    hitRate: Math.max(...result.aggregates.map((a) => a.hitRate), 0),
    coverage: Math.max(...result.aggregates.map((a) => a.coverage), 0),
    mrr: Math.max(...result.aggregates.map((a) => a.mrr), 0),
    ndcg: Math.max(...result.aggregates.map((a) => a.ndcg), 0),
    precision: Math.max(...result.aggregates.map((a) => a.precision), 0),
  }
  // Baseline scores keyed by strategy, for the per-cell delta.
  const baseMap = new Map(
    (result.baseline?.aggregates ?? []).map((a) => [a.strategyId, a] as const),
  )
  const isPinned = pinnedRunId === result.runId

  // A metric cell: the value plus a small ▲/▼ delta vs the baseline. All
  // four metrics are higher-is-better, so ▲ (green) means improvement.
  const metricCell = (
    cur: number,
    top: number,
    text: string,
    baseVal: number | undefined,
    kind: 'pct' | 'dec',
  ) => {
    let delta = null
    if (baseVal != null) {
      const d = cur - baseVal
      const up = d > 0.0005
      const down = d < -0.0005
      const mag =
        kind === 'pct'
          ? `${Math.abs(Math.round(d * 100))}`
          : Math.abs(d).toFixed(3)
      delta = (
        <span className={`ab-sc-delta${up ? ' up' : down ? ' down' : ''}`}>
          {up ? `▲ ${mag}` : down ? `▼ ${mag}` : '·'}
        </span>
      )
    }
    return (
      <td className={cur > 0 && cur === top ? 'ab-sc-cell-best' : undefined}>
        {text}
        {delta}
      </td>
    )
  }

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-sc-results-head">
        <div className="ab-section-title">Results</div>
        {isPinned ? (
          <Pill kind="accent" dot>
            baseline
          </Pill>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSetBaseline(result.runId)}
          >
            Set as baseline
          </Button>
        )}
      </div>

      <div className="ab-sc-meta">
        <div className="ab-sc-summary">
          {result.judgedCount}/{result.queryCount} questions scored
          {' · '}
          {result.fileCount} file{result.fileCount === 1 ? '' : 's'}
          {' · '}top-{result.topK}
          {' · '}
          {fmtDuration(result.durationMs)}
          {' · '}
          <code>{result.embeddingModel}</code>
        </div>
        {result.baseline ? (
          <p className="ab-sc-compare-label">
            Compared against{' '}
            {result.baseline.isBaseline ? 'baseline' : 'previous run'} from{' '}
            {fmtRunDate(result.baseline.createdAt)}.{' '}
            <span className="up">▲</span> improved{' · '}
            <span className="down">▼</span> worse.
          </p>
        ) : (
          <p className="ab-sc-compare-label">
            First run. Run again after a change, or pin this as the baseline to
            compare against.
          </p>
        )}
      </div>

      {/* Pin confirmation: the button becoming a "baseline" pill is the
          visible cue; this announces it to screen readers. */}
      <span className="sr-only" role="status" aria-live="polite">
        {pinMsg}
      </span>

      <div className="ab-sc-table-wrap">
        <table className="ab-sc-table">
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              {METRIC_HEADERS.map(([label, info]) => (
                <th scope="col" key={label}>
                  <span className="ab-sc-th">
                    {label}
                    <Tooltip label={info} side="top">
                      <button
                        type="button"
                        className="ab-sc-info"
                        aria-label={`What ${label} measures`}
                      >
                        <InfoGlyph />
                      </button>
                    </Tooltip>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.aggregates.map((a) => {
              const b = baseMap.get(a.strategyId)
              return (
                <tr key={a.strategyId}>
                  <td className="ab-sc-strategy-name">{a.label}</td>
                  {metricCell(
                    a.hitRate,
                    best.hitRate,
                    pct(a.hitRate),
                    b?.hitRate,
                    'pct',
                  )}
                  {metricCell(
                    a.coverage,
                    best.coverage,
                    pct(a.coverage),
                    b?.coverage,
                    'pct',
                  )}
                  {metricCell(a.mrr, best.mrr, dec(a.mrr), b?.mrr, 'dec')}
                  {metricCell(a.ndcg, best.ndcg, dec(a.ndcg), b?.ndcg, 'dec')}
                  {metricCell(
                    a.precision,
                    best.precision,
                    pct(a.precision),
                    b?.precision,
                    'pct',
                  )}
                </tr>
              )
            })}
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
