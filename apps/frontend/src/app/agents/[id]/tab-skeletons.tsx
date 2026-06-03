/**
 * Loading skeletons for the lazily-loaded agent tabs. Each one is built
 * from the SAME structural classes its real tab uses (`ab-form-section`,
 * `ab-field-grid`, `ab-list-row`, `ab-chat-shell`, …) and fills them with
 * neutral `Skeleton` blocks, so the placeholder occupies the same space as
 * the loaded content and the swap barely shifts the page. Rendered as the
 * <Suspense fallback>; the ~120ms fade-in delay on `.ab-tab-skeleton` keeps
 * fast/cached chunk loads from flashing a placeholder.
 */

import { Skeleton } from '../../../ui/skeleton'

/* ---- shared pieces -------------------------------------------------------- */

/** One labelled form field. `wide` spans the 2-col grid; `tall` is a
 *  textarea-height control. Mirrors `.ab-field` (label + control, gap 6px). */
function FieldSkeleton({ wide, tall }: { wide?: boolean; tall?: boolean }) {
  return (
    <div
      className="ab-field"
      style={wide ? { gridColumn: '1 / -1' } : undefined}
    >
      <Skeleton width={wide ? 116 : 72} height={10} />
      <Skeleton height={tall ? 88 : 38} radius="var(--radius)" />
    </div>
  )
}

/** One `.ab-list-row`: 30px glyph + two stacked text lines + a trailing pill. */
function ListRowSkeleton({ index }: { index: number }) {
  return (
    <div className="ab-list-row">
      <Skeleton width={30} height={30} radius="var(--radius)" />
      <div className="ab-list-row-head" style={{ gap: 'var(--space-1_5)' }}>
        <Skeleton width={`${34 + ((index * 17) % 22)}%`} height={12} />
        <Skeleton width={`${52 + ((index * 13) % 20)}%`} height={10} />
      </div>
      <div className="ab-list-row-meta">
        <Skeleton width={58} height={20} radius="var(--radius-pill)" />
      </div>
    </div>
  )
}

/** Card with a section header + a `.ab-list-card` of rows, with an optional
 *  trailing action button. Covers the Resources + Bridge tabs. */
function SectionCardSkeleton({
  rows,
  subLines = 1,
  footerWidth,
}: {
  rows: number
  subLines?: number
  footerWidth?: number
}) {
  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div
        className="ab-section-head"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <Skeleton width={140} height={15} />
        {Array.from({ length: subLines }).map((_, i) => (
          <Skeleton
            key={i}
            width={i === subLines - 1 ? '52%' : '80%'}
            height={12}
            style={{ marginTop: 'var(--space-1_5)' }}
          />
        ))}
      </div>
      <div className="ab-card ab-list-card">
        {Array.from({ length: rows }).map((_, i) => (
          <ListRowSkeleton key={i} index={i} />
        ))}
      </div>
      {footerWidth != null && (
        <Skeleton
          width={footerWidth}
          height={34}
          radius="var(--radius)"
          style={{ marginTop: 'var(--space-4)' }}
        />
      )}
    </div>
  )
}

/* ---- Configure ------------------------------------------------------------ */

export function ConfigureTabSkeleton() {
  return (
    <div
      className="ab-tab-skeleton ab-configure-tab"
      role="status"
      aria-label="Loading configuration"
    >
      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{ marginBottom: 'var(--space-4)' }}
        >
          <Skeleton width={120} height={15} />
          <Skeleton
            width="60%"
            height={12}
            style={{ marginTop: 'var(--space-1_5)' }}
          />
        </div>
        <div className="ab-field-grid">
          <FieldSkeleton />
          <FieldSkeleton />
          <FieldSkeleton wide tall />
        </div>
      </div>
      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{ marginBottom: 'var(--space-4)' }}
        >
          <Skeleton width={100} height={15} />
          <Skeleton
            width="54%"
            height={12}
            style={{ marginTop: 'var(--space-1_5)' }}
          />
        </div>
        <div className="ab-field-grid">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
      </div>
    </div>
  )
}

/* ---- Resources / Bridge --------------------------------------------------- */

export function ResourcesTabSkeleton() {
  return (
    <div
      className="ab-tab-skeleton"
      role="status"
      aria-label="Loading resources"
    >
      <SectionCardSkeleton rows={3} />
      <SectionCardSkeleton rows={2} />
    </div>
  )
}

export function BridgeTabSkeleton() {
  return (
    <div
      className="ab-tab-skeleton"
      role="status"
      aria-label="Loading bridge tools"
    >
      <SectionCardSkeleton rows={4} subLines={2} footerWidth={132} />
    </div>
  )
}

/* ---- Chat ----------------------------------------------------------------- */

function BotMsgSkeleton({ lines }: { lines: string[] }) {
  return (
    <div className="ab-msg ab-msg-bot">
      <Skeleton
        circle
        width={28}
        height={28}
        style={{ marginTop: 'var(--space-0_5)' }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2_5)',
        }}
      >
        {lines.map((w, i) => (
          <Skeleton key={i} width={w} height={13} />
        ))}
      </div>
    </div>
  )
}

function UserMsgSkeleton({ width }: { width: number }) {
  return (
    <div className="ab-msg ab-msg-user">
      <Skeleton width={width} height={40} radius="var(--radius-lg)" />
    </div>
  )
}

function ThreadRailSkeleton() {
  return (
    <div className="ab-thread-rail">
      <Skeleton
        height={32}
        radius="var(--radius)"
        style={{ marginBottom: 'var(--space-2)' }}
      />
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1_5)',
            padding: 'var(--space-2) var(--space-2_5)',
          }}
        >
          <Skeleton width={`${58 + ((i * 13) % 30)}%`} height={11} />
          <Skeleton width="34%" height={9} />
        </div>
      ))}
    </div>
  )
}

export function ChatTabSkeleton() {
  return (
    <div
      className="ab-tab-skeleton ab-chat-shell"
      role="status"
      aria-label="Loading chat"
    >
      <div className="ab-chat-with-threads">
        <ThreadRailSkeleton />
        <div className="ab-chat-main">
          <div className="ab-chat-thread">
            <BotMsgSkeleton lines={['96%', '88%', '52%']} />
            <UserMsgSkeleton width={220} />
            <BotMsgSkeleton lines={['92%', '78%', '40%']} />
            <UserMsgSkeleton width={156} />
          </div>
          <div className="ab-chat-input-bar">
            <div className="ab-chat-input-pill">
              <Skeleton
                height={18}
                style={{ flex: 1, margin: 'var(--space-3)' }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  paddingBottom: 'var(--space-1)',
                }}
              >
                <Skeleton width={34} height={34} radius="12px" />
                <Skeleton width={36} height={36} radius="var(--radius)" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
