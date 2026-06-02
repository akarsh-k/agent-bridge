/**
 * Shared section header used inside ".ab-card-pad" cards across the
 * Agent Builder (Resources panel, Tools tab, …).
 *
 * Pattern: a tone-colored vertical rail + inline stroke icon set to
 * the LEFT of a title/sub stack, with an optional right-aligned
 * action slot. The rail+icon together act as the section's color key
 * so operators can scan the page by hue without reading every
 * heading. Dropping `glyph` collapses the marker entirely and renders
 * a plain title header.
 *
 * Centralised here (vs. inlined per-feature) so the rail dimensions,
 * tone palette, and typography stay in sync as we add new sections.
 */

import type React from 'react'

export type SectionHeadTone = 'accent' | 'success' | 'warn'

/** Tone → solid CSS color var. Reads from `tokens.css` so light/dark
 *  themes track the rest of the app without per-component overrides. */
const TONE_COLOR: Record<SectionHeadTone, string> = {
  accent: 'var(--accent-400)',
  success: 'var(--success)',
  warn: 'var(--warn)',
}

export function SectionHead({
  title,
  sub,
  action,
  glyph,
  tone = 'accent',
}: {
  title: React.ReactNode
  sub: React.ReactNode
  action?: React.ReactNode
  /** Small stroke icon (size ~18) shown inline left of the title,
   *  colored by `tone`. Omit to render a plain title (no rail, no
   *  icon). */
  glyph?: React.ReactNode
  tone?: SectionHeadTone
}) {
  const color = TONE_COLOR[tone]
  return (
    <div
      className="ab-section-head"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          minWidth: 0,
        }}
      >
        {glyph && (
          <span
            aria-hidden="true"
            style={{
              width: 3,
              height: 'calc(var(--space-8) + var(--space-1))',
              flexShrink: 0,
              borderRadius: 'var(--radius-pill)',
              background: color,
            }}
          />
        )}
        {glyph && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              flexShrink: 0,
              color,
            }}
          >
            {glyph}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="ab-section-title">{title}</div>
          <div className="ab-section-sub">{sub}</div>
        </div>
      </div>
      {action}
    </div>
  )
}
