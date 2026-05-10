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
 *    still in-flight the row stays open with a pulsing "running" pill.
 *  - **Step grouping.** When the agent loops (model → tool → model → tool
 *    → …), `run.step.started` / `run.step.finished` brackets become
 *    section headers ("Step 2 · stop · 1.4s · 845 tok"). Events outside
 *    any step (lifecycle, config, worker telemetry) flow in free
 *    sections at top level.
 *  - **Live tail.** When `liveStreamId` is non-null (running run), the
 *    timeline subscribes to its SSE channel and appends new events with
 *    `ts > lastRestEventTs`. Connection state is surfaced as a small
 *    "Live" indicator in the header.
 *
 * Filter chips above the list scope to a coarse group (Tool / Model /
 * Inspector / Errors). Token frames are always rolled into a single
 * dim row regardless of filter — they're noise per-row but useful as a
 * "tokens flowed here" anchor.
 *
 * Used by `run-detail-sheet.tsx` for both run and worker job sheets;
 * Phase 3 will reuse the same component from the chat tab.
 */

import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  EventPayloadViewer,
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

  const sections = useMemo(
    () => buildSections(allEvents, filter),
    [allEvents, filter],
  )

  const totalShown = sections.reduce((n, s) => n + countItems(s.items), 0)
  const tailing = liveStreamId !== null

  return (
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
          From <code className="ab-mono">{source}</code>, oldest first.
          {tailing && (
            <>
              {' '}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: sse.connected ? 'var(--success)' : 'var(--text-muted)',
                }}
              >
                {sse.connected && <span className="ab-pulse-dot" />}
                {sse.connected ? 'Live' : 'Connecting…'}
              </span>
            </>
          )}
        </div>
      </div>

      <TimelineFilterChips
        value={filter}
        onChange={setFilter}
        events={allEvents}
      />

      {sections.length === 0 ? (
        <div className="ab-field-help">
          {totalShown === 0 && allEvents.length > 0
            ? 'No events match this filter.'
            : 'No events recorded.'}
        </div>
      ) : (
        <ol
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {sections.map((s, i) => (
            <SectionBlock key={`${s.kind}-${i}`} section={s} />
          ))}
        </ol>
      )}
    </div>
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
    <div
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 3,
        margin: '8px 0',
        background: 'var(--surface-hi)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    >
      {chips.map((c) => {
        const active = c.key === value
        const empty = c.count === 0 && c.key !== 'all'
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(c.key)}
            disabled={empty}
            style={{
              padding: '4px 10px',
              fontSize: 11.5,
              borderRadius: 'var(--radius-xs)',
              border: 'none',
              background: active ? 'var(--bg-canvas)' : 'transparent',
              color: active
                ? 'var(--text)'
                : empty
                  ? 'var(--text-muted)'
                  : 'var(--text-dim)',
              cursor: empty ? 'default' : 'pointer',
              fontWeight: active ? 500 : 400,
              opacity: empty ? 0.5 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {c.label}
            {c.count !== undefined && (
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
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
type TimelineItem = PairItem | SingleItem | TokenRollItem

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
        current.totalTokens = numField(deepGetField(p, ['usage', 'totalTokens']))
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
      return idx !== null
        ? { role: 'called', key: `model:${idx}` }
        : null
    }
    case 'run.model.result': {
      const idx = numField(p['stepIndex'])
      return idx !== null
        ? { role: 'result', key: `model:${idx}` }
        : null
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
  if (item.kind === 'token-roll') return false
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
      return group === 'inspector' || group === 'resolver'
    default:
      return false
  }
}

function countItems(items: ReadonlyArray<TimelineItem>): number {
  let n = 0
  for (const it of items) {
    if (it.kind === 'token-roll') n += it.count
    else n += 1
  }
  return n
}

// ─── Section / Item rendering ──────────────────────────────────────────

function SectionBlock({ section }: { section: Section }) {
  if (section.kind === 'free') {
    return (
      <li>
        <ItemList items={section.items} />
      </li>
    )
  }
  const dur =
    section.finishedTs !== null
      ? Date.parse(section.finishedTs) - Date.parse(section.startedTs)
      : null
  const parts: string[] = []
  if (section.finishReason) parts.push(section.finishReason)
  if (dur !== null && Number.isFinite(dur)) parts.push(formatDurationMs(dur))
  if (section.totalTokens !== null)
    parts.push(`${section.totalTokens.toLocaleString()} tok`)
  return (
    <li
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--surface-hi)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-canvas)',
        }}
      >
        <span
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--accent-300)',
            fontWeight: 500,
          }}
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
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
            {parts.join(' · ')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          className="ab-mono"
          style={{ fontSize: 10.5, color: 'var(--text-muted)' }}
        >
          {formatClock(section.startedTs)}
        </span>
      </div>
      <div style={{ padding: 10 }}>
        <ItemList items={section.items} />
      </div>
    </li>
  )
}

function ItemList({ items }: { items: ReadonlyArray<TimelineItem> }) {
  if (items.length === 0) {
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          fontSize: 11.5,
          padding: '4px 4px',
        }}
      >
        No matching events in this step.
      </div>
    )
  }
  return (
    <ol
      style={{
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {items.map((it) => (
        <ItemRow key={it.id} item={it} />
      ))}
    </ol>
  )
}

function ItemRow({ item }: { item: TimelineItem }) {
  if (item.kind === 'token-roll') return <TokenRollRow item={item} />
  if (item.kind === 'pair') return <PairRow item={item} />
  return <SingleRow item={item} />
}

function TokenRollRow({ item }: { item: TokenRollItem }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 10px',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius)',
        background: 'transparent',
        color: 'var(--text-muted)',
        fontSize: 11.5,
      }}
      title={`${item.count} token frame${item.count === 1 ? '' : 's'} folded`}
    >
      <span
        className="ab-mono"
        style={{ fontSize: 10.5, color: 'var(--text-muted)', minWidth: 80 }}
      >
        {formatClock(item.firstTs)}
      </span>
      <span>Tokens · ×{item.count}</span>
    </li>
  )
}

function SingleRow({ item }: { item: SingleItem }) {
  const summary = summarizeEvent(item.event.kind, item.event.payload)
  const [open, setOpen] = useState(false)
  const expandable =
    item.event.payload !== null && item.event.payload !== undefined
  return (
    <li
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
    >
      <RowHeader
        ts={item.event.ts}
        title={summary.title}
        summary={summary.summary}
        kindLabel={item.event.kind}
        tone={summary.tone}
        open={open}
        onToggle={expandable ? () => setOpen((o) => !o) : null}
      />
      {open && expandable && <EventPayloadViewer payload={item.event.payload} />}
    </li>
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
    <li
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
    >
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
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-hi)',
            padding: '12px 14px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <PairSubsection
            tone="input"
            label="Input"
            ts={item.called.ts}
            payload={item.called.payload}
          />
          {item.result ? (
            <PairSubsection
              tone={resultSummary?.isError ? 'error' : 'output'}
              label={resultSummary?.isError ? 'Error' : 'Output'}
              ts={item.result.ts}
              payload={item.result.payload}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                background: 'var(--bg-canvas)',
                border: '1px dashed var(--border-strong)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-muted)',
                fontSize: 12,
              }}
            >
              <span className="ab-pulse-dot" />
              Awaiting result…
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * One Input / Output / Error block inside an expanded paired row.
 *
 * Each block is a self-contained card on the surface-hi background of
 * the parent expansion: a header strip with a colour-coded label
 * (input = neutral, output = success, error = danger), the timestamp,
 * and a copy button — followed by the payload body inset so the
 * key/value table breathes inside its own padded region.
 */
function PairSubsection({
  tone,
  label,
  ts,
  payload,
}: {
  tone: 'input' | 'output' | 'error'
  label: string
  ts: string
  payload: unknown
}) {
  const accent =
    tone === 'error'
      ? 'var(--danger)'
      : tone === 'output'
        ? 'var(--success)'
        : 'var(--accent-300)'
  return (
    <div
      style={{
        background: 'var(--bg-canvas)',
        border: '1px solid var(--border)',
        borderLeft: `2px solid ${accent}`,
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-hi)',
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: accent,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span
          className="ab-mono"
          style={{
            fontSize: 10.5,
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatClock(ts)}
        </span>
        <span style={{ flex: 1 }} />
        <CopyJsonButton payload={payload} />
      </div>
      <div style={{ padding: '10px 12px' }}>
        <EventPayloadBody payload={payload} />
      </div>
    </div>
  )
}

// ─── Shared row header ─────────────────────────────────────────────────
//
// The header is the operator's primary scanning surface. Design intent:
//
//   ┃ TOOL · inspect_codebase                  16:43:21.412  ▸
//   ┃ args.query="redis cluster scaling"
//   ↑
//   tonal spine (full row height) — colour reads at scan speed in a
//   stack of 30 rows, where an 8px dot would not. The kind prefix is
//   rendered in the mono face like a kernel-log marker, so eyes can
//   skim a column of "TOOL / WRAPPER / GITNEXUS / STEP" tags without
//   parsing English. The clean `name` portion is reserved for the actual
//   identifier the operator cares about (tool name, wrapper id…).
//
// State language:
//   - hover     → background lifts to `--surface-hi`, chevron brightens
//   - open      → background sticks at `--surface-hi`, spine widens 2→3,
//                 hairline lid below, chevron rotates 90°
//   - in-flight → spine takes a vertical light sweep (matches live
//                 indicators elsewhere in the app)
//   - focus     → inset accent ring via `.ab-evt-row` class

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
   *  accessible name + tooltip for keyboard users and debugging. Not
   *  rendered in body text; the parsed `title` already carries it in
   *  human-readable form. */
  kindLabel: string
  tone: PillKind
  open: boolean
  onToggle: (() => void) | null
  inFlight?: boolean
}) {
  const interactive = onToggle !== null
  const [hover, setHover] = useState(false)

  const handleClick = () => {
    if (interactive && onToggle) onToggle()
  }
  const handleKey = (e: ReactKeyboardEvent) => {
    if (!interactive) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle?.()
    }
  }

  const toneColour = spineColour(tone)
  const titleParts = splitTitlePrefix(title)

  // Background priority: hover > open > resting.
  // Hover wins so the cursor target always feels alive even on open rows.
  const bg =
    interactive && hover
      ? 'var(--surface-hover)'
      : open
        ? 'var(--surface-hi)'
        : 'transparent'

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? open : undefined}
      aria-label={interactive ? `${title} — ${kindLabel}` : undefined}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="ab-evt-row"
      style={{
        position: 'relative',
        width: '100%',
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        background: bg,
        color: 'var(--text)',
        cursor: interactive ? 'pointer' : 'default',
        textAlign: 'left',
        fontSize: 12,
        borderBottom: open ? '1px solid var(--border)' : '1px solid transparent',
        transition:
          'background var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out)',
      }}
      title={kindLabel}
    >
      <StatusSpine tone={tone} colour={toneColour} open={open} inFlight={inFlight} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: open ? '12px 14px' : '10px 14px',
          transition: 'padding var(--dur-1) var(--ease-out)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              flexWrap: 'wrap',
              rowGap: 2,
            }}
          >
            {titleParts.prefix && (
              <span
                className="ab-mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: dimToneColour(tone),
                  // Pull the prefix slightly above the baseline of the
                  // name so the all-caps marker sits visually with the
                  // ascenders of the lowercase identifier next to it.
                  position: 'relative',
                  top: -1,
                }}
              >
                {titleParts.prefix}
              </span>
            )}
            <span
              style={{
                color: 'var(--text)',
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1.3,
                letterSpacing: '-0.005em',
                wordBreak: 'break-word',
                fontVariantLigatures: 'common-ligatures',
              }}
            >
              {titleParts.body}
            </span>
            {inFlight && (
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                  letterSpacing: '0.02em',
                }}
              >
                running…
              </span>
            )}
          </div>
          {summary && (
            <div
              style={{
                color: 'var(--text-dim)',
                fontSize: 11.5,
                marginTop: 5,
                lineHeight: 1.45,
                // One-line ceiling to keep timeline density readable; if
                // the operator wants the full payload they expand the row.
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {summary}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingTop: 2,
            flexShrink: 0,
          }}
        >
          <span
            className="ab-mono"
            style={{
              color: 'var(--text-muted)',
              fontSize: 10.5,
              fontVariantNumeric: 'tabular-nums',
              fontFeatureSettings: '"tnum"',
              letterSpacing: '0.01em',
            }}
          >
            {formatClock(ts)}
          </span>
          {interactive && (
            <Chevron
              open={open}
              colour={hover ? 'var(--accent-300)' : 'var(--text-muted)'}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Vertical tonal spine on the row's left edge. Stretches the full height
 * of the row (so a row with a long summary or wrapped title still reads
 * as one chunk in a stack), takes 2px of width when closed and 3px when
 * open. In-flight rows get a vertical sweep animation so the operator
 * sees energy flowing — not a static dot they have to inspect.
 */
function StatusSpine({
  tone,
  colour,
  open,
  inFlight,
}: {
  tone: PillKind
  colour: string
  open: boolean
  inFlight?: boolean
}) {
  // Match the existing live-indicator language — the same gradient family
  // used by `.ab-pulse-dot` lights up wrapper + worker activity. We ride
  // it vertically here so a thin bar still reads as "alive".
  const animated = inFlight === true
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={animated ? 'ab-evt-spine ab-evt-spine--running' : 'ab-evt-spine'}
      style={{
        flexShrink: 0,
        alignSelf: 'stretch',
        width: open ? 3 : 2,
        background: animated
          ? `linear-gradient(180deg, ${colour} 0%, var(--accent-300) 50%, ${colour} 100%)`
          : colour,
        backgroundSize: animated ? '100% 220%' : undefined,
        transition: 'width var(--dur-1) var(--ease-out)',
      }}
    />
  )
}

/**
 * 10px chevron icon. Rotates 0° → 90° on open instead of glyph-swapping
 * `▸` / `▾` (which have different widths and shift the timestamp by 1px
 * on every toggle). Stroke uses `currentColor` driven by the inline
 * `colour` prop so hover can brighten it without re-rendering.
 */
function Chevron({ open, colour }: { open: boolean; colour: string }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="none"
      stroke={colour}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform var(--dur-2) var(--ease-spring), stroke var(--dur-1) var(--ease-out)',
      }}
    >
      <path d="M3.5 2 L7 5 L3.5 8" />
    </svg>
  )
}

/**
 * Map a tone to the spine's solid colour. The spine reads at scan speed
 * (2-3px wide × full row height), so we use the saturated semantic
 * tokens — not the dimmer text variants — so the column of rows looks
 * like a status histogram from across the room.
 */
function spineColour(tone: PillKind): string {
  switch (tone) {
    case 'success':
      return 'var(--success)'
    case 'danger':
      return 'var(--danger)'
    case 'warn':
      return 'var(--warn)'
    case 'accent':
      return 'var(--accent-400)'
    default:
      // Neutral rows (lifecycle, ping, config) get a soft border tint
      // instead of the muted-text grey — the spine should still feel
      // like part of the chrome, not text that escaped its line.
      return 'var(--border-strong)'
  }
}

/**
 * Quieter variant of the spine colour, used by the kind-prefix marker
 * so it harmonises with the spine without competing for attention. The
 * dimmer accent shades work better as text colour at small sizes.
 */
function dimToneColour(tone: PillKind): string {
  switch (tone) {
    case 'success':
      return 'var(--success)'
    case 'danger':
      return 'var(--danger)'
    case 'warn':
      return 'var(--warn)'
    case 'accent':
      return 'var(--accent-300)'
    default:
      return 'var(--text-muted)'
  }
}

/**
 * Split a row title like `"Tool: inspect_codebase"` into a short
 * uppercase prefix marker (`TOOL`) and the actual identifier
 * (`inspect_codebase`). Falls through to a single body part when the
 * title doesn't fit the `Prefix: rest` shape (e.g. `Run started`,
 * `Cloning`, `Step 1 finished`) so we don't invent structure that
 * isn't there.
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
  return { prefix: prefix.toUpperCase(), body }
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
