/**
 * Design-language showcase (proposal surface, route: /_design).
 *
 * Renders the "Grounded Precision" token system + core primitives in dark and
 * light at once, with a live OKLCH accent control (preset chips + hue/chroma
 * sliders) so the accent identity can be felt on real components instead of
 * guessed from hex. Nothing here touches the live app; once the direction is
 * locked these tokens fold into tokens.css and the primitives into ab-* classes.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import './showcase.css'

interface Preset {
  label: string
  h: number
  c: number
}

// The curated, shippable palette — deliberately NON-violet, spanning
// cool -> warm -> neutral. Teal is the default. The hue slider below is the
// "Custom" power option for anyone who wants a hue between these.
const PRESETS: readonly Preset[] = [
  { label: 'Teal', h: 195, c: 0.125 },
  { label: 'Cyan', h: 208, c: 0.115 },
  { label: 'Cobalt', h: 248, c: 0.15 },
  { label: 'Amber', h: 82, c: 0.135 },
  { label: 'Coral', h: 32, c: 0.15 },
  { label: 'Slate', h: 245, c: 0.035 },
]

/** White on the accent fill except for bright yellow-green hues, where ink reads better. */
function accentForeground(h: number): string {
  return h >= 60 && h <= 120 ? '#15130a' : '#ffffff'
}

export function DesignShowcase() {
  const [h, setH] = useState(195)
  const [c, setC] = useState(0.125)

  const stageStyle = {
    '--acc-h': String(h),
    '--acc-c': String(c),
    // Dark fills sit brighter (need ink on yellow-green); light fills sit
    // darker (white reads on every hue). Each theme picks its own below.
    '--acc-fg-dark': accentForeground(h),
    '--acc-fg-light': '#ffffff',
  } as CSSProperties

  const activePreset = PRESETS.findIndex((p) => p.h === h && p.c === c)

  return (
    <div className="ds-stage" style={stageStyle}>
      <header className="ds-head">
        <div className="ds-eyebrow">Design language · proposal</div>
        <h1 className="ds-title">Grounded Precision</h1>
        <p className="ds-sub">
          The same calm, exact, trustworthy soul, rebuilt with a real type
          scale, a strict 4px spatial system, generous rounding, and one accent
          used structurally. Dark and light shown together. Dial the accent
          below until it feels unmistakably yours.
        </p>
      </header>

      <div className="ds-bar">
        <span className="ds-bar-label">Accent</span>
        <div className="ds-presets">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              type="button"
              className={`ds-preset${i === activePreset ? ' is-active' : ''}`}
              aria-label={p.label}
              aria-pressed={i === activePreset}
              onClick={() => {
                setH(p.h)
                setC(p.c)
              }}
            >
              <span
                className="ds-preset-dot"
                style={{ background: `oklch(0.66 ${p.c} ${p.h})` }}
              />
              {p.label}
            </button>
          ))}
        </div>
        <div className="ds-slider">
          <span className="ds-bar-label">Hue</span>
          <input
            type="range"
            min={0}
            max={360}
            value={h}
            onChange={(e) => setH(Number(e.target.value))}
          />
          <code>{h}°</code>
        </div>
        <div className="ds-slider">
          <span className="ds-bar-label">Chroma</span>
          <input
            type="range"
            min={4}
            max={20}
            value={Math.round(c * 100)}
            onChange={(e) => setC(Number(e.target.value) / 100)}
          />
          <code>{c.toFixed(3)}</code>
        </div>
      </div>

      <div className="ds-panels">
        <Panel theme="dark" />
        <Panel theme="light" />
      </div>
    </div>
  )
}

function Panel({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <section className={`ds-frame ds-${theme} ds-panel`}>
      <div className="ds-panel-tag">{theme} theme</div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Surfaces &amp; accent</h3>
        <Swatches />
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Type scale</h3>
        <TypeScale />
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Spacing · 4px system</h3>
        <SpacingRail />
        <div style={{ height: 18 }} />
        <h3 className="ds-sec-h">Radius</h3>
        <RadiusRail />
        <div style={{ height: 18 }} />
        <h3 className="ds-sec-h">Elevation</h3>
        <div className="ds-elev">
          <div
            className="ds-elev-card"
            style={{ boxShadow: 'var(--shadow-1)' }}
          >
            01
          </div>
          <div
            className="ds-elev-card"
            style={{ boxShadow: 'var(--shadow-2)' }}
          >
            02
          </div>
          <div
            className="ds-elev-card"
            style={{ boxShadow: 'var(--shadow-3)' }}
          >
            03
          </div>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Buttons</h3>
        <div className="ds-stack">
          <div className="ds-row">
            <button className="ds-btn ds-btn-primary">New agent</button>
            <button className="ds-btn ds-btn-secondary">Configure</button>
            <button className="ds-btn ds-btn-ghost">Cancel</button>
            <button className="ds-btn ds-btn-danger">
              <span className="ds-dot" />
              Delete
            </button>
          </div>
          <div className="ds-row">
            <button className="ds-btn ds-btn-primary ds-btn-sm">Small</button>
            <button className="ds-btn ds-btn-secondary">Default</button>
            <button className="ds-btn ds-btn-primary ds-btn-lg">Large</button>
            <button className="ds-btn ds-btn-secondary" disabled>
              Disabled
            </button>
          </div>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Fields</h3>
        <div className="ds-stack">
          <div className="ds-field">
            <label className="ds-label">Agent name</label>
            <input className="ds-input" defaultValue="Repo Inspector" />
          </div>
          <div className="ds-field">
            <label className="ds-label">System prompt</label>
            <textarea
              className="ds-input ds-textarea"
              defaultValue="You are a grounded research agent. Cite file, page, and section."
            />
            <span className="ds-hint">Markdown supported · click to focus</span>
          </div>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Status</h3>
        <div className="ds-row">
          <span className="ds-pill ds-pill-accent">
            <span className="ds-dot" />
            Most recent
          </span>
          <span className="ds-pill ds-pill-success">
            <span className="ds-dot" />
            Ready
          </span>
          <span className="ds-pill ds-pill-warn">2 steps left</span>
          <span className="ds-pill ds-pill-danger">Error</span>
          <span className="ds-pill">inspector</span>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Controls</h3>
        <div className="ds-stack">
          <SlidingPicker
            kind="tabs"
            items={['Configure', 'Resources', 'Chat', 'Bridge']}
          />
          <div className="ds-row">
            <SlidingPicker kind="seg" items={['All', 'Ready', 'Setup']} />
            <SwitchRow />
          </div>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Composed: agent card</h3>
        <div className="ds-card ds-card-pad">
          <div className="ds-card-head">
            <div className="ds-card-glyph">◆</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ds-card-title">Repo Inspector</div>
              <div className="ds-card-sub">
                repo-inspector · github.com/ak/agent-bridge
              </div>
            </div>
            <span className="ds-pill ds-pill-success">
              <span className="ds-dot" />
              Ready
            </span>
          </div>
          <div className="ds-card-body">
            Grounded research over the attached repositories. Traces flow across
            frontend, backend, and shared types with citations back to file.
          </div>
          <div className="ds-row" style={{ marginTop: 16 }}>
            <button className="ds-btn ds-btn-primary ds-btn-sm">
              Open chat
            </button>
            <button className="ds-btn ds-btn-ghost ds-btn-sm">Configure</button>
          </div>
        </div>
      </div>

      <div className="ds-sec">
        <h3 className="ds-sec-h">Menu</h3>
        <div className="ds-menu">
          <button className="ds-menu-item">Open agent</button>
          <button className="ds-menu-item">Duplicate</button>
          <div className="ds-menu-sep" />
          <button className="ds-menu-item" style={{ color: 'var(--danger)' }}>
            Delete agent
          </button>
        </div>
      </div>
    </section>
  )
}

function Swatches() {
  const tokens: Array<{ name: string; v: string }> = [
    { name: 'canvas', v: 'var(--bg-canvas)' },
    { name: 'bg', v: 'var(--bg)' },
    { name: 'surface', v: 'var(--surface)' },
    { name: 'surface-hi', v: 'var(--surface-hi)' },
    { name: 'raised', v: 'var(--surface-raised)' },
    { name: 'acc-300', v: 'var(--acc-300)' },
    { name: 'acc-400', v: 'var(--acc-400)' },
    { name: 'acc-500', v: 'var(--acc-500)' },
    { name: 'acc-fill', v: 'var(--acc-fill)' },
    { name: 'success', v: 'var(--success)' },
    { name: 'warn', v: 'var(--warn)' },
    { name: 'danger', v: 'var(--danger)' },
  ]
  return (
    <div className="ds-swatches">
      {tokens.map((t) => (
        <div key={t.name} className="ds-swatch">
          <div className="ds-swatch-fill" style={{ background: t.v }} />
          <div className="ds-swatch-cap">{t.name}</div>
        </div>
      ))}
    </div>
  )
}

function TypeScale() {
  const steps: Array<{ t: string; px: string; role: string; w?: number }> = [
    { t: 'var(--t-display)', px: '38', role: 'Display', w: 680 },
    { t: 'var(--t-3xl)', px: '30', role: 'Page title', w: 680 },
    { t: 'var(--t-2xl)', px: '24', role: 'Section', w: 590 },
    { t: 'var(--t-xl)', px: '20', role: 'Subsection', w: 590 },
    { t: 'var(--t-lg)', px: '16', role: 'Card title', w: 590 },
    { t: 'var(--t-base)', px: '14', role: 'Body', w: 420 },
    { t: 'var(--t-sm)', px: '13', role: 'Dense', w: 420 },
    { t: 'var(--t-xs)', px: '12', role: 'Label', w: 510 },
  ]
  return (
    <div>
      {steps.map((s) => (
        <div key={s.px} className="ds-type-row">
          <span className="ds-type-meta">
            {s.px}px · {s.role}
          </span>
          <span
            className="ds-type-spec"
            style={{
              fontSize: s.t,
              fontWeight: s.w,
              letterSpacing: Number(s.px) >= 20 ? '-0.02em' : '-0.006em',
            }}
          >
            Grounded research, exactly.
          </span>
        </div>
      ))}
    </div>
  )
}

function SpacingRail() {
  const steps = ['4', '8', '12', '16', '20', '24', '32', '48']
  return (
    <div className="ds-rail">
      {steps.map((s) => (
        <div key={s} className="ds-space-chip">
          <div className="ds-space-bar" style={{ width: Number(s) }} />
          <span className="ds-space-cap">{s}</span>
        </div>
      ))}
    </div>
  )
}

function RadiusRail() {
  const steps: Array<{ v: string; cap: string }> = [
    { v: 'var(--r-sm)', cap: '8' },
    { v: 'var(--r-md)', cap: '10' },
    { v: 'var(--r-lg)', cap: '14' },
    { v: 'var(--r-xl)', cap: '18' },
    { v: 'var(--r-2xl)', cap: '24' },
  ]
  return (
    <div className="ds-rail">
      {steps.map((s) => (
        <div key={s.cap} className="ds-radius-chip">
          <div className="ds-radius-box" style={{ borderTopLeftRadius: s.v }} />
          <span className="ds-radius-cap">{s.cap}</span>
        </div>
      ))}
    </div>
  )
}

/** Tabs / segmented control with a measured sliding thumb. */
function SlidingPicker({
  kind,
  items,
}: {
  kind: 'tabs' | 'seg'
  items: readonly string[]
}) {
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [thumb, setThumb] = useState<{ x: number; w: number }>({ x: 0, w: 0 })

  useLayoutEffect(() => {
    const el = btnRefs.current[active]
    const wrap = wrapRef.current
    if (!el || !wrap) return
    setThumb({ x: el.offsetLeft, w: el.offsetWidth })
  }, [active, items])

  const thumbClass = kind === 'tabs' ? 'ds-tab-thumb' : 'ds-seg-thumb'
  const wrapClass = kind === 'tabs' ? 'ds-tabs' : 'ds-seg'
  const btnClass = kind === 'tabs' ? 'ds-tab' : ''

  return (
    <div className={wrapClass} ref={wrapRef}>
      <span
        className={thumbClass}
        style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }}
      />
      {items.map((it, i) => (
        <button
          key={it}
          type="button"
          ref={(el) => {
            btnRefs.current[i] = el
          }}
          className={`${btnClass}${i === active ? ' is-active' : ''}`.trim()}
          onClick={() => setActive(i)}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

function SwitchRow() {
  const [on, setOn] = useState(true)
  return (
    <button
      type="button"
      className={`ds-switch${on ? ' is-on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label="Toggle memory"
      onClick={() => setOn((v) => !v)}
    />
  )
}
