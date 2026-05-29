/**
 * Run / worker event timeline.
 *
 * Renders an ordered list of `run_events` (or `worker_events`) rows so an
 * operator can see what happened, in what order, and what each step
 * carried. Three responsibilities live here:
 *
 *  - **Pairing.** A `run.tool.called` and the matching `run.tool.result`
 *    (or any `inspector.*.called` / `inspector.*.result` pair) collapse
 *    into ONE row showing input + output + duration. While the result is
 *    still in-flight the row stays open with a pulsing dot.
 *  - **Step grouping.** When the agent loops (model → tool → model → tool
 *    → …), `run.step.started` / `run.step.finished` brackets become quiet
 *    section headers ("Step 2 · stop · 1.4s · 845 tok"). Events outside
 *    any step (lifecycle, config, worker telemetry) flow at top level.
 *  - **Live tail.** When `liveStreamId` is non-null (running run), the
 *    timeline subscribes to its SSE channel and appends new events with
 *    `ts > lastRestEventTs`. Connection state is surfaced as a small
 *    "Live" indicator in the header.
 *
 * Visual language: flat. Steps are labelled sections (not nested cards),
 * events are hairline-separated rows with a leading tone dot (no
 * side-stripe), and expansion insets one level. Sentence case throughout;
 * mono is reserved for clocks and payloads.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { RunEvent } from '@agent-bridge/shared'
import { Pill, type PillKind } from '../../ui/pill'
import { useSSE } from '../../lib/use-sse'
import {
  formatDurationMs,
  summarizeEvent,
  type EventGroup,
} from './event-labels'
import {
  CopyJsonButton,
  EventPayloadBody,
  ViewJsonButton,
} from './event-payload-viewer'

/** Shape both `RunDetailEvent` and `WorkerJobDetailEvent` satisfy. */
export type TimelineEvent = {
  id: string
  ts: string
  kind: string
  payload: unknown
}

/** Filter chip values for the in-timeline filter strip. */
export type TimelineFilter = 'all' | 'tool' | 'model' | 'inspector' | 'errors'

export interface EventTimelineProps {
  events: ReadonlyArray<TimelineEvent>
  /** Table of origin (for the section's sub-line — purely cosmetic). */
  source: 'run_events' | 'worker_events'
  /**
   * When non-null, the timeline subscribes to this SSE stream and appends
   * any new events with `ts` past the last REST-fetched event. Used so a
   * sheet opened on a running run keeps updating without a manual refresh.
   * Pass null to disable (terminal status, worker job, etc.).
   */
  liveStreamId: string | null
}

/**
 * Earliest event timestamp (ms) for the open run, so every row can show a
 * `+Δ` offset from run start instead of a near-identical wall clock. The
 * absolute time stays available on hover. 0 means "no anchor yet" — the
 * formatter falls back to the absolute clock.
 */
const TimelineAnchorContext = createContext<number>(0)

export function EventTimeline({
  events,
  source,
  liveStreamId,
}: EventTimelineProps) {
  const [filter, setFilter] = useState<TimelineFilter>('all')

  // SSE tail. We only care about events past `lastRestTs` to avoid
  // double-rendering the buffer the SSE backend may replay on connect.
  const lastRestTs = useMemo(() => {
    let max = 0
    for (const e of events) {
      const t = Date.parse(e.ts)
      if (Number.isFinite(t) && t > max) max = t
    }
    return max
  }, [events])
  const sse = useSSE(liveStreamId, { cap: 500 })
  const liveEvents = useMemo<ReadonlyArray<TimelineEvent>>(
    () => sseToTimelineEvents(sse.events, lastRestTs),
    [sse.events, lastRestTs],
  )

  const allEvents = useMemo<ReadonlyArray<TimelineEvent>>(
    () => [...events, ...liveEvents],
    [events, liveEvents],
  )

  // Anchor for relative clocks: the earliest event in the run.
  const runStart = useMemo(() => {
    let min = Infinity
    for (const e of allEvents) {
      const t = Date.parse(e.ts)
      if (Number.isFinite(t) && t < min) min = t
    }
    return Number.isFinite(min) ? min : 0
  }, [allEvents])

  const sections = useMemo(
    () => buildSections(allEvents, filter),
    [allEvents, filter],
  )

  const totalShown = sections.reduce((n, s) => n + countItems(s.items), 0)
  const tailing = liveStreamId !== null

  return (
    <TimelineAnchorContext.Provider value={runStart}>
      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">
            Event timeline{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
              ({allEvents.length} event{allEvents.length === 1 ? '' : 's'}
              {liveEvents.length > 0 ? ` · +${liveEvents.length} live` : ''})
            </span>
          </div>
          <div className="ab-section-sub">
            From <code className="ab-mono">{source}</code>, oldest first; clocks
            are offsets from run start.
            {tailing && (
              <>
                {' '}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: sse.connected
                      ? 'var(--success)'
                      : 'var(--text-muted)',
                  }}
                >
                  {sse.connected && <span className="ab-pulse-dot" />}
                  {sse.connected ? 'Live' : 'Connecting…'}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="ab-tl-filter">
          <TimelineFilterChips
            value={filter}
            onChange={setFilter}
            events={allEvents}
          />
        </div>

        {sections.length === 0 ? (
          <div className="ab-field-help">
            {totalShown === 0 && allEvents.length > 0
              ? 'No events match this filter.'
              : 'No events recorded.'}
          </div>
        ) : (
          <div className="ab-tl">
            {sections.map((s, i) => (
              <SectionBlock key={`${s.kind}-${i}`} section={s} />
            ))}
          </div>
        )}
      </div>
    </TimelineAnchorContext.Provider>
  )
}

/**
 * A row/step/block clock. Shows `+Δ` from run start (the scannable signal:
 * how far into the run, where the gaps are) with the absolute wall-clock
 * time on hover for cross-referencing other logs.
 */
function RelTime({ iso, className }: { iso: string; className: string }) {
  const t0 = useContext(TimelineAnchorContext)
  return (
    <span className={className} title={formatClock(iso)}>
      {formatOffset(iso, t0)}
    </span>
  )
}

// ─── Filter chips ──────────────────────────────────────────────────────

function TimelineFilterChips({
  value,
  onChange,
  events,
}: {
  value: TimelineFilter
  onChange: (f: TimelineFilter) => void
  events: ReadonlyArray<TimelineEvent>
}) {
  // Counts so the operator can see "5 errors" before clicking the chip.
  const counts = useMemo(() => {
    let tool = 0
    let model = 0
    let inspector = 0
    let errors = 0
    for (const e of events) {
      const s = summarizeEvent(e.kind, e.payload)
      if (s.group === 'tool') tool += 1
      if (s.group === 'model') model += 1
      if (s.group === 'inspector') inspector += 1
      if (s.isError) errors += 1
    }
    return { tool, model, inspector, errors }
  }, [events])

  const chips: Array<{ key: TimelineFilter; label: string; count?: number }> = [
    { key: 'all', label: 'All', count: events.length },
    { key: 'tool', label: 'Tool', count: counts.tool },
    { key: 'model', label: 'Model', count: counts.model },
    { key: 'inspector', label: 'Inspector', count: counts.inspector },
    { key: 'errors', label: 'Errors', count: counts.errors },
  ]
  return (
    <div className="ab-seg">
      {chips.map((c) => {
        const active = c.key === value
        const empty = c.count === 0 && c.key !== 'all'
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(c.key)}
            disabled={empty}
            aria-pressed={active}
            className={`ab-seg-item${active ? ' is-active' : ''}`}
          >
            {c.label}
            {c.count !== undefined && (
              <span
                style={{
                  marginLeft: 5,
                  opacity: 0.6,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {c.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Pairing + section building ────────────────────────────────────────

interface PairItem {
  readonly kind: 'pair'
  readonly id: string
  readonly called: TimelineEvent
  /** Result event when matched; null while in-flight. */
  result: TimelineEvent | null
}
interface SingleItem {
  readonly kind: 'single'
  readonly id: string
  readonly event: TimelineEvent
}
interface TokenRollItem {
  readonly kind: 'token-roll'
  readonly id: string
  /** First event in the run for the timestamp anchor. */
  readonly firstTs: string
  /** Combined raw count of `run.token` + `run.token.batch` events. */
  count: number
}
/** Folded `run.model.waiting` heartbeats — the "model is thinking" gap
 *  before a step streams. Consecutive heartbeats collapse into one row that
 *  shows the latest elapsed, so the gap reads as one ticking marker. */
interface WaitingRollItem {
  readonly kind: 'waiting-roll'
  readonly id: string
  /** When the wait began (the heartbeat's `sinceTs`), for the row clock. */
  readonly firstTs: string
  /** Latest reported wait duration, ms. */
  elapsedMs: number
}
type TimelineItem = PairItem | SingleItem | TokenRollItem | WaitingRollItem

interface StepSection {
  readonly kind: 'step'
  /** 1-based sequence number used for display. Always contiguous so the
   *  operator sees "Step 1, Step 2, Step 3" regardless of any gaps in
   *  the producer's raw `stepIndex` payload. Assigned after sectioning. */
  displayNumber: number
  /** Raw `stepIndex` from the payload — surfaced as a tooltip for debug.
   *  Older runs (pre run-dispatcher fix) may show non-contiguous values
   *  here while `displayNumber` stays sequential. */
  readonly rawStepIndex: number | null
  readonly startedTs: string
  finishedTs: string | null
  finishReason: string | null
  totalTokens: number | null
  items: TimelineItem[]
}
interface FreeSection {
  readonly kind: 'free'
  items: TimelineItem[]
}
type Section = StepSection | FreeSection

function buildSections(
  events: ReadonlyArray<TimelineEvent>,
  filter: TimelineFilter,
): ReadonlyArray<Section> {
  // 1) Roll tokens to keep the timeline manageable on chatty runs.
  const items = pairAndRoll(events)

  // 2) Section by `run.step.started` / `run.step.finished` brackets.
  const sections: Section[] = []
  let current: Section | null = null
  // Push policy: step sections always get pushed (even empty — the
  // header still carries useful info: "Step 3 · stop · 1.4s · 245 tok").
  // Free sections only get pushed when they have items (an empty free
  // section is just visual noise).
  const flush = () => {
    if (current === null) return
    if (current.kind === 'step' || current.items.length > 0) {
      sections.push(current)
    }
    current = null
  }
  for (const item of items) {
    // Step start: open a new step section. Don't include the start event
    // itself — the section header conveys that information.
    if (item.kind === 'single' && item.event.kind === 'run.step.started') {
      flush()
      const p = isObj(item.event.payload) ? item.event.payload : {}
      const rawIdx = numField(p['stepIndex'])
      current = {
        kind: 'step',
        displayNumber: 0, // assigned after sectioning
        rawStepIndex: rawIdx,
        startedTs: item.event.ts,
        finishedTs: null,
        finishReason: null,
        totalTokens: null,
        items: [],
      }
      continue
    }
    // Step finish: close the current step (if any), absorb metadata.
    if (item.kind === 'single' && item.event.kind === 'run.step.finished') {
      const p = isObj(item.event.payload) ? item.event.payload : {}
      if (current && current.kind === 'step') {
        current.finishedTs = item.event.ts
        current.finishReason = strField(p['finishReason'])
        current.totalTokens = numField(
          deepGetField(p, ['usage', 'totalTokens']),
        )
        sections.push(current)
        current = null
        continue
      }
      // Orphan finish — falls through into the free section path below.
    }
    if (!current) current = { kind: 'free', items: [] }
    current.items.push(item)
  }
  flush()

  // Assign sequential 1-based display numbers across step sections so
  // operators see "Step 1, 2, 3…" even when the underlying stepIndex is
  // sparse. (Old runs persisted indices like 0/4/8 because the producer's
  // global counter bumped on every chunk type — fixed in the dispatcher
  // but the rendered output should stay contiguous either way.)
  let stepCounter = 0
  for (const s of sections) {
    if (s.kind === 'step') {
      stepCounter += 1
      s.displayNumber = stepCounter
    }
  }

  // 3) Apply the filter to items inside each section. Drop sections that
  //    end up empty after filtering — step headers without rendered items
  //    aren't useful context anchors at this density.
  if (filter === 'all') return sections
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter((it) => matchesFilter(it, filter)),
    }))
    .filter((s) => s.items.length > 0)
}

function pairAndRoll(events: ReadonlyArray<TimelineEvent>): TimelineItem[] {
  const out: TimelineItem[] = []
  // FIFO queues of pending called-event indices, keyed by pair-key.
  const pending = new Map<string, number[]>()

  for (const e of events) {
    // Token rolling first — they account for the bulk of rows on long
    // runs and have no payload worth expanding for the operator.
    if (e.kind === 'run.token' || e.kind === 'run.token.batch') {
      const last = out[out.length - 1]
      if (last && last.kind === 'token-roll') {
        last.count += 1
        continue
      }
      out.push({
        kind: 'token-roll',
        id: `tokens-${e.id}`,
        firstTs: e.ts,
        count: 1,
      })
      continue
    }

    // "Model is thinking" heartbeats: fold the run of them into one row
    // showing the latest elapsed. Anchor the clock to when the wait began
    // (`sinceTs`) rather than the heartbeat's own ts.
    if (e.kind === 'run.model.waiting') {
      const p = isObj(e.payload) ? e.payload : {}
      const elapsedMs = numField(p['elapsedMs']) ?? 0
      const sinceMs = numField(p['sinceTs'])
      const last = out[out.length - 1]
      if (last && last.kind === 'waiting-roll') {
        last.elapsedMs = Math.max(last.elapsedMs, elapsedMs)
        continue
      }
      out.push({
        kind: 'waiting-roll',
        id: `wait-${e.id}`,
        firstTs: sinceMs !== null ? new Date(sinceMs).toISOString() : e.ts,
        elapsedMs,
      })
      continue
    }

    const info = pairInfo(e)
    if (!info) {
      out.push({ kind: 'single', id: `s-${e.id}`, event: e })
      continue
    }
    if (info.role === 'called') {
      const item: PairItem = {
        kind: 'pair',
        id: `p-${e.id}`,
        called: e,
        result: null,
      }
      out.push(item)
      const arr = pending.get(info.key) ?? []
      arr.push(out.length - 1)
      pending.set(info.key, arr)
    } else {
      // role === 'result'
      const arr = pending.get(info.key)
      if (arr && arr.length > 0) {
        const idx = arr.shift()!
        const item = out[idx]
        if (item && item.kind === 'pair') item.result = e
      } else {
        // Orphan result (REST page started after the called event was
        // already evicted, or producer fired result without a call).
        out.push({ kind: 'single', id: `s-${e.id}`, event: e })
      }
    }
  }
  return out
}

interface PairInfo {
  role: 'called' | 'result'
  key: string
}

function pairInfo(e: TimelineEvent): PairInfo | null {
  const p = isObj(e.payload) ? e.payload : {}
  switch (e.kind) {
    case 'run.tool.called': {
      const id = strField(p['toolCallId'])
      return id ? { role: 'called', key: `tool:${id}` } : null
    }
    case 'run.tool.result': {
      const id = strField(p['toolCallId'])
      return id ? { role: 'result', key: `tool:${id}` } : null
    }
    case 'run.model.called': {
      const idx = numField(p['stepIndex'])
      return idx !== null ? { role: 'called', key: `model:${idx}` } : null
    }
    case 'run.model.result': {
      const idx = numField(p['stepIndex'])
      return idx !== null ? { role: 'result', key: `model:${idx}` } : null
    }
    case 'inspector.tool.called':
      return key('called', 'wrapper', strField(p['wrapperName']))
    case 'inspector.tool.result':
      return key('result', 'wrapper', strField(p['wrapperName']))
    case 'inspector.gitnexus.called':
      return key('called', 'gitnexus', strField(p['tool']))
    case 'inspector.gitnexus.result':
      return key('result', 'gitnexus', strField(p['tool']))
    case 'inspector.llm.called':
      return key('called', 'llm', strField(p['purpose']) ?? 'call')
    case 'inspector.llm.result':
      return key('result', 'llm', strField(p['purpose']) ?? 'call')
    case 'inspector.keyword.called':
      return key('called', 'keyword', strField(p['repoLabel']))
    case 'inspector.keyword.result':
      return key('result', 'keyword', strField(p['repoLabel']))
    default:
      return null
  }
}

function key(
  role: 'called' | 'result',
  prefix: string,
  value: string | null,
): PairInfo | null {
  return value ? { role, key: `${prefix}:${value}` } : null
}

function matchesFilter(item: TimelineItem, filter: TimelineFilter): boolean {
  if (filter === 'all') return true
  // Roll-ups are status markers, not discrete events — only in the All view.
  if (item.kind === 'token-roll' || item.kind === 'waiting-roll') return false
  const ev = item.kind === 'pair' ? item.called : item.event
  const summary = summarizeEvent(ev.kind, ev.payload)
  if (filter === 'errors') {
    if (summary.isError) return true
    if (item.kind === 'pair' && item.result) {
      const r = summarizeEvent(item.result.kind, item.result.payload)
      return r.isError
    }
    return false
  }
  return groupMatches(summary.group, filter)
}

function groupMatches(group: EventGroup, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'tool':
      return group === 'tool'
    case 'model':
      return group === 'model' || group === 'lifecycle'
    case 'inspector':
      return group === 'inspector'
    default:
      return false
  }
}

function countItems(items: ReadonlyArray<TimelineItem>): number {
  let n = 0
  for (const it of items) {
    if (it.kind === 'token-roll') n += it.count
    // waiting-roll is a status marker, not an event — don't count it.
    else if (it.kind === 'waiting-roll') continue
    else n += 1
  }
  return n
}

// ─── Section / Item rendering ──────────────────────────────────────────

function SectionBlock({ section }: { section: Section }) {
  if (section.kind === 'free') {
    return <ItemList items={section.items} />
  }
  return <StepBlock section={section} />
}

/**
 * One step group: a labelled header over its events. The header is a
 * disclosure when the step has events, so an operator can fold a step to
 * skim the shape of a long run. Open by default — never hide events until
 * the operator asks. Empty steps (header only) stay static.
 */
function StepBlock({ section }: { section: StepSection }) {
  const [open, setOpen] = useState(true)
  const count = countItems(section.items)
  const collapsible = count > 0

  const dur =
    section.finishedTs !== null
      ? Date.parse(section.finishedTs) - Date.parse(section.startedTs)
      : null
  const parts: string[] = []
  if (section.finishReason) parts.push(section.finishReason)
  if (dur !== null && Number.isFinite(dur)) parts.push(formatDurationMs(dur))
  if (section.totalTokens !== null)
    parts.push(`${section.totalTokens.toLocaleString()} tok`)

  const headInner = (
    <>
      {collapsible && <Chevron />}
      <span
        className="ab-tl-step-num"
        title={
          section.rawStepIndex !== null
            ? `Producer stepIndex: ${section.rawStepIndex}`
            : undefined
        }
      >
        Step {section.displayNumber}
      </span>
      {section.finishedTs === null ? (
        <Pill kind="warn" dot>
          running
        </Pill>
      ) : (
        parts.length > 0 && (
          <span className="ab-tl-step-meta">{parts.join(' · ')}</span>
        )
      )}
      {collapsible && !open && (
        <span className="ab-tl-step-meta">
          {count} event{count === 1 ? '' : 's'}
        </span>
      )}
      <RelTime iso={section.startedTs} className="ab-tl-step-clock" />
    </>
  )

  return (
    <div className="ab-tl-step">
      {collapsible ? (
        <button
          type="button"
          className={`ab-tl-step-head is-button${open ? ' is-open' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {headInner}
        </button>
      ) : (
        <div className="ab-tl-step-head">{headInner}</div>
      )}
      {open && <ItemList items={section.items} />}
    </div>
  )
}

function ItemList({ items }: { items: ReadonlyArray<TimelineItem> }) {
  if (items.length === 0) {
    return (
      <div className="ab-tl-step-empty">No matching events in this step.</div>
    )
  }
  return (
    <div className="ab-tl-rows">
      {items.map((it) => (
        <ItemRow key={it.id} item={it} />
      ))}
    </div>
  )
}

function ItemRow({ item }: { item: TimelineItem }) {
  if (item.kind === 'token-roll') return <TokenRollRow item={item} />
  if (item.kind === 'waiting-roll') return <WaitingRow item={item} />
  if (item.kind === 'pair') return <PairRow item={item} />
  return <SingleRow item={item} />
}

/**
 * "Model is thinking" gap marker — the folded `run.model.waiting`
 * heartbeats. A pulsing dot + the running wait duration give the long
 * pre-step silence a live signal instead of dead air.
 */
function WaitingRow({ item }: { item: WaitingRollItem }) {
  return (
    <div className="ab-tl-row">
      <div className="ab-tl-waiting">
        <span className="ab-pulse-dot" />
        <span>Waiting on model · {formatDurationMs(item.elapsedMs)}</span>
        <RelTime iso={item.firstTs} className="ab-tl-clock" />
      </div>
    </div>
  )
}

function TokenRollRow({ item }: { item: TokenRollItem }) {
  return (
    <div className="ab-tl-row">
      <div
        className="ab-tl-tokens"
        title={`${item.count} token frame${item.count === 1 ? '' : 's'} folded`}
      >
        <span>Tokens · ×{item.count}</span>
        <RelTime iso={item.firstTs} className="ab-tl-clock" />
      </div>
    </div>
  )
}

function SingleRow({ item }: { item: SingleItem }) {
  const summary = summarizeEvent(item.event.kind, item.event.payload)
  const [open, setOpen] = useState(false)
  const expandable =
    item.event.payload !== null && item.event.payload !== undefined
  return (
    <div className={`ab-tl-row${open && expandable ? ' is-open' : ''}`}>
      <RowHeader
        ts={item.event.ts}
        title={summary.title}
        summary={summary.summary}
        kindLabel={item.event.kind}
        tone={summary.tone}
        open={open}
        onToggle={expandable ? () => setOpen((o) => !o) : null}
      />
      {open && expandable && (
        <div className="ab-tl-expand">
          <PayloadBlock label="Payload" payload={item.event.payload} />
        </div>
      )}
    </div>
  )
}

function PairRow({ item }: { item: PairItem }) {
  const calledSummary = summarizeEvent(item.called.kind, item.called.payload)
  const resultSummary = item.result
    ? summarizeEvent(item.result.kind, item.result.payload)
    : null
  const [open, setOpen] = useState(false)

  // Combined header: title from called, supporting summary from result
  // when present (duration + status), otherwise from called.
  const summary = resultSummary
    ? joinSummaries(
        calledSummary.summary,
        resultSummary.title.split('→').pop()?.trim() ?? null,
      )
    : calledSummary.summary
  const tone = resultSummary?.tone ?? calledSummary.tone
  const isInFlight = item.result === null

  return (
    <div className={`ab-tl-row${open ? ' is-open' : ''}`}>
      <RowHeader
        ts={item.called.ts}
        title={calledSummary.title}
        summary={summary}
        kindLabel={item.called.kind.replace('.called', '')}
        tone={isInFlight ? 'warn' : tone}
        inFlight={isInFlight}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="ab-tl-expand">
          <PayloadBlock
            label="Input"
            tone="input"
            ts={item.called.ts}
            payload={item.called.payload}
          />
          {item.result ? (
            <PayloadBlock
              label={resultSummary?.isError ? 'Error' : 'Output'}
              tone={resultSummary?.isError ? 'error' : 'output'}
              ts={item.result.ts}
              payload={item.result.payload}
            />
          ) : (
            <div className="ab-tl-await">
              <span className="ab-pulse-dot" />
              Awaiting result…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One Input / Output / Error / Payload block inside an expanded row.
 * A header strip (tone-coloured label, timestamp, view/copy actions)
 * over the payload body. No side-stripe — tone reads from the label
 * colour, the box is a flat inset card.
 */
function PayloadBlock({
  label,
  tone,
  ts,
  payload,
}: {
  label: string
  tone?: 'input' | 'output' | 'error'
  ts?: string
  payload: unknown
}) {
  return (
    <div className="ab-tl-block">
      <div className="ab-tl-block-head">
        <span className="ab-tl-block-label" data-tone={tone}>
          {label}
        </span>
        {ts && <RelTime iso={ts} className="ab-tl-block-clock" />}
        <span className="ab-tl-block-actions">
          <ViewJsonButton payload={payload} />
          <CopyJsonButton payload={payload} />
        </span>
      </div>
      <div className="ab-tl-block-body">
        <EventPayloadBody payload={payload} />
      </div>
    </div>
  )
}

// ─── Shared row header ─────────────────────────────────────────────────
//
// The header is the operator's primary scanning surface:
//
//   ● tool  inspect_codebase                       16:43:21.412  ›
//   args.query="redis cluster scaling"
//
// A leading tone dot (success / danger / warn / accent / neutral) reads
// status at a glance; the kind marker sits in mono next to the
// identifier the operator cares about. State language:
//   - hover     → row background lifts to `--surface-hover`
//   - open      → chevron rotates 90°, payload insets below
//   - in-flight → the dot pulses (matches live indicators elsewhere)

function RowHeader({
  ts,
  title,
  summary,
  kindLabel,
  tone,
  open,
  onToggle,
  inFlight,
}: {
  ts: string
  title: string
  summary: string | null
  /** Raw kind (e.g. `inspector.gitnexus.called`) — surfaced as the row's
   *  accessible name + tooltip for keyboard users and debugging. */
  kindLabel: string
  tone: PillKind
  open: boolean
  onToggle: (() => void) | null
  inFlight?: boolean
}) {
  const interactive = onToggle !== null
  const handleKey = (e: ReactKeyboardEvent) => {
    if (!interactive) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle?.()
    }
  }
  const titleParts = splitTitlePrefix(title)

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? open : undefined}
      aria-label={interactive ? `${title} — ${kindLabel}` : undefined}
      onClick={interactive ? () => onToggle?.() : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      className={`ab-tl-row-head${interactive ? ' is-interactive' : ''}${
        open ? ' is-open' : ''
      }`}
      title={kindLabel}
    >
      <span
        aria-hidden
        data-tone={dotTone(tone)}
        className={`ab-tl-dot${inFlight ? ' is-running' : ''}`}
      />
      <div className="ab-tl-row-main">
        <div className="ab-tl-row-title">
          {titleParts.prefix && (
            <span className="ab-tl-kind">{titleParts.prefix}</span>
          )}
          <span className="ab-tl-name">{titleParts.body}</span>
          {inFlight && <span className="ab-tl-running">running…</span>}
        </div>
        {summary && <div className="ab-tl-summary">{summary}</div>}
      </div>
      <div className="ab-tl-row-aside">
        <RelTime iso={ts} className="ab-tl-clock" />
        {interactive && <Chevron />}
      </div>
    </div>
  )
}

/**
 * 10px chevron icon. Rotation (0° → 90° on open) is driven by the
 * parent `.ab-tl-row-head.is-open` class so it animates without a
 * re-render, and never glyph-swaps (which would shift the timestamp).
 */
function Chevron() {
  return (
    <svg
      className="ab-tl-chevron"
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 2 L7 5 L3.5 8" />
    </svg>
  )
}

/** Map an event tone to the dot's `data-tone` attribute. */
function dotTone(tone: PillKind): string {
  switch (tone) {
    case 'success':
      return 'success'
    case 'danger':
      return 'danger'
    case 'warn':
      return 'warn'
    case 'accent':
      return 'accent'
    default:
      return 'neutral'
  }
}

/**
 * Split a row title like `"Tool: inspect_codebase"` into a short kind
 * marker (`Tool`) and the actual identifier (`inspect_codebase`). Falls
 * through to a single body part when the title doesn't fit the
 * `Prefix: rest` shape (e.g. `Run started`, `Cloning`, `Step 1 finished`)
 * so we don't invent structure that isn't there.
 */
function splitTitlePrefix(title: string): {
  prefix: string | null
  body: string
} {
  const idx = title.indexOf(':')
  if (idx <= 0 || idx > 24) return { prefix: null, body: title }
  const prefix = title.slice(0, idx).trim()
  const body = title.slice(idx + 1).trim()
  if (prefix.length === 0 || body.length === 0)
    return { prefix: null, body: title }
  return { prefix, body }
}

// ─── Helpers (timeline-local) ──────────────────────────────────────────

function sseToTimelineEvents(
  sseEvents: ReadonlyArray<RunEvent>,
  afterTs: number,
): ReadonlyArray<TimelineEvent> {
  const out: TimelineEvent[] = []
  for (let i = 0; i < sseEvents.length; i++) {
    const ev = sseEvents[i]
    if (ev === undefined) continue
    if (ev.ts <= afterTs) continue
    if (ev.kind === 'ping') continue
    out.push({
      id: `sse-${ev.ts}-${i}`,
      ts: new Date(ev.ts).toISOString(),
      kind: ev.kind,
      payload: ev.data ?? null,
    })
  }
  return out
}

function joinSummaries(a: string | null, b: string | null): string | null {
  if (a && b) return `${a} · ${b}`
  return a ?? b
}

function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

/**
 * Offset of `iso` from the run-start anchor `t0` (ms epoch), e.g. `+0.41s`,
 * `+12.34s`, `+1m04s`. Falls back to the absolute clock when there's no
 * usable anchor (single malformed timestamp, empty run).
 */
function formatOffset(iso: string, t0: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || !Number.isFinite(t0) || t0 <= 0) {
    return formatClock(iso)
  }
  const s = Math.max(0, t - t0) / 1000
  if (s < 60) return `+${s.toFixed(2)}s`
  // Round to whole seconds FIRST, then split — rounding the remainder on
  // its own can carry to 60 (e.g. 119.6s → "1m60s" instead of "2m00s").
  const whole = Math.round(s)
  const m = Math.floor(whole / 60)
  const rem = whole % 60
  return `+${m}m${String(rem).padStart(2, '0')}s`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function strField(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function deepGetField(
  obj: Record<string, unknown>,
  path: ReadonlyArray<string>,
): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}
