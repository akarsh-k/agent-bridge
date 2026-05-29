---
name: Agent Bridge
description: Local-first agent workbench and MCP bridge for grounded codebase research.
colors:
  accent: "#5b8def"
  accent-strong: "#3f6fd6"
  accent-soft: "#a9c4f7"
  accent-solid: "#3856ad"
  ink-black: "#0a0b0f"
  graphite-900: "#0d0e13"
  graphite-800: "#15161b"
  graphite-700: "#1c1d24"
  graphite-600: "#23242c"
  near-white: "#f2f3f5"
  slate-dim: "#a0a3ad"
  slate-muted: "#6c6f7a"
  border-hairline: "#ffffff17"
  border-strong: "#ffffff29"
  success: "#34d399"
  danger: "#fb7185"
  warn: "#fbbf24"
typography:
  display:
    fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  mono:
    fontFamily: "'Geist Mono Variable', ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "3px"
  sm: "5px"
  md: "7px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent-solid}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "#3358bb"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.graphite-700}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-ghost:
    textColor: "{colors.slate-dim}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  card:
    backgroundColor: "{colors.graphite-800}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.graphite-700}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.md}"
    padding: "9px 11px"
  badge-accent:
    backgroundColor: "#5b8def1f"
    textColor: "{colors.accent-soft}"
    rounded: "{rounded.pill}"
---

# Design System: Agent Bridge

## 1. Overview

**Creative North Star: "The Quiet Instrument"**

Agent Bridge is a precision instrument for developers, not a destination. The interface is a control surface that recedes so the work, configuring providers, watching index jobs land, confirming an agent is callable, reading exactly what a run did, stays in front. It reads like a serious developer tool that trusts the operator's expertise: state shown plainly, no false reassurance, no marketing varnish. Calm confidence, never excitement.

The surface is a cool near-black graphite with hairline borders carrying the structure. A single periwinkle-blue is the only accent: it carries the primary action and marks focus, links, selection, and the moment an agent becomes ready. Everything else stays neutral, so the one blue is the only color competing for attention. Geist Sans and Geist Mono give it the exact, engineered feel of the Vercel/Linear lineage the brand draws from.

This system explicitly rejects the **hype-y AI aesthetic** (glowing orbs, neon gradients, "supercharge your workflow"), the **cluttered enterprise/devtools chrome** that exposes a hundred knobs at once, and the **generic SaaS dashboard** template (identical card grids, the hero-metric block, decorative widgets). When in doubt, it is quieter, flatter, and more specific than the category default.

**Key Characteristics:**
- Cool-neutral graphite surfaces; one periwinkle accent used sparingly.
- Monochrome primary actions; the accent is for state and navigation, not buttons.
- Flat by default: hairline borders over shadows, no gradients on chrome.
- Honest state: status is the core information surface and must always read true.
- Geist Sans + Mono; tight tracking, clear weight contrast, no decorative case.

## 2. Colors

A cool-neutral graphite scale where every surface and the lone accent share one blue-leaning temperature, so the accent reads as native rather than applied.

### Primary
- **Periwinkle Signal** (`#5b8def`): The bright accent for text-weight uses on dark surfaces, focus rings, links, selection, active nav, info tones, the "agent ready" moment. In light theme it deepens to `#2f5bc0` for contrast on white.
- **Periwinkle Solid** (`#3856ad` dark / `#2f5bc0` light): The fill for primary buttons. A deeper sibling of the Signal so white label text clears WCAG AA (~6.6:1); the bright Signal would only reach ~3:1 with white text.
- **Periwinkle Strong** (`#3f6fd6`): Pressed/active accent states and accent borders.
- **Periwinkle Soft** (`#a9c4f7`): Accent text on dark accent-tinted fills (glyphs, bot avatar, tool-call labels).

### Neutral
- **Ink Black** (`#0a0b0f`): The deepest canvas, behind the workspace and inside the sidebar and inset log feeds.
- **Graphite 900 / 800 / 700 / 600** (`#0d0e13` → `#15161b` → `#1c1d24` → `#23242c`): The body, then stepped surfaces for cards, raised panels, and hovers. Depth is built by layering these, not by shadow.
- **Near-White** (`#f2f3f5`): Primary text, and the fill for monochrome primary buttons and the brand mark.
- **Slate Dim** (`#a0a3ad`): Secondary text, labels, ghost-button text.
- **Slate Muted** (`#6c6f7a`): Tertiary text, timestamps, placeholder-level information.
- **Hairline / Strong Border** (`#ffffff17` / `#ffffff29`): The structural language. Most separation is a 1px hairline; strong borders mark focusable or raised elements.

### Semantic
- **Mint** (`#34d399`), **Coral** (`#fb7185`), **Amber** (`#fbbf24`): Success / danger / warning. Each is always paired with text, icon, or shape, never color alone. Retuned to darker values in light theme so they never fail contrast on white.

### Named Rules
**The One-Accent Rule.** There is exactly one accent hue, periwinkle. Other colors are neutral or semantic. If a surface needs a second decorative color, the answer is no.

**The Solid-Accent-Primary Rule.** The primary action is a solid periwinkle fill (`--accent-solid`) with white text, never a gradient. Use the deeper `--accent-solid` (not the bright link Signal) so white text clears WCAG AA. Secondary and ghost actions stay neutral so the one blue button is unmistakably the primary path.

## 3. Typography

**Display & Body Font:** Geist Variable (with system-sans fallback)
**Mono Font:** Geist Mono Variable (with `ui-monospace` fallback)

**Character:** Geist is a precise, slightly mechanical grotesque, engineered and neutral, exactly the unhyped, exact tone the brand wants. One family across UI and a true mono for code, logs, IDs, and JSON. Self-hosted, no font CDN, consistent with the local-first posture.

### Hierarchy
- **Display** (600, 1.625rem/26px, 1.2, -0.02em): Page titles only. `text-wrap: balance`.
- **Title** (600, 0.9375rem/15px, 1.3, -0.01em): Section headings, card titles, sheet headers.
- **Body** (400, 0.875rem/14px, 1.5): Default text. `text-wrap: pretty` on prose; cap reading measures at 65–75ch.
- **Label** (500, 0.75rem/12px, 1.4): Field labels, pills, metadata. Sentence case.
- **Mono** (400, 0.75rem/12px, 1.5): Code blocks, tool calls, run IDs, JSON, log rows, tabular numerics.

### Named Rules
**The No-Tracked-Caps Rule.** Avoid all-caps tracked micro-labels as default scaffolding. Use sentence-case labels. Uppercase is reserved for the rare genuine acronym or status token, never an eyebrow over every section.

## 4. Elevation

Flat by default. Depth comes from tonal layering (Graphite 900 → 600) and hairline borders, not from shadows. Shadows are reserved for genuinely floating layers (dropdowns, dialogs, the chat composer) and stay tight and neutral, never a colored bloom or glow.

### Shadow Vocabulary
- **Resting** (`--shadow-1`, `0 1px 2px rgba(0,0,0,0.4)`): Barely-there separation for small raised chrome.
- **Floating** (`--shadow-2`, `0 4px 16px -2px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)`): Overlays, dialogs, popovers, the composer pill.
- **Focus ring** (`--shadow-glow`, `0 0 0 1px var(--accent-border)`): A flat accent ring. No radial glow.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. If you reach for a `box-shadow` on a card or button, stop: use a border or a tonal step instead. Shadows appear only for layers that truly float above the page.

**The No-Glow Rule.** No colored glow, ever. The old violet aura, gradient buttons, and gradient glyphs are gone and do not come back.

## 5. Components

### Buttons
- **Shape:** Gently squared (`--radius` 7px), 36px tall (30px for `sm`).
- **Primary:** Solid Periwinkle fill (`--accent-solid`, `#3856ad` dark / `#2f5bc0` light), white text, 600 weight. Hover deepens to `--accent-solid-hover`. No gradient, no glow.
- **Secondary:** Graphite-700 fill with a strong hairline border, Near-White text. Hover steps to Graphite-600.
- **Ghost:** No fill, Slate-Dim text; hover adds a faint accent-tinted wash and brightens text to Near-White.
- **Danger:** Transparent with Coral text; hover fills with the soft Coral tint.
- **Focus:** A two-layer ring (`0 0 0 2px var(--bg), 0 0 0 4px var(--border-focus)`) on every interactive element.

### Chips / Badges
- **Style:** Pill (`--radius-pill`), 11px label. Neutral badge uses a surface fill + hairline; accent/success/warn/danger use the matching soft tint + tone color.
- **Integration chips** (GitHub, Linear, Notion, etc.) keep the service's own brand hue as a flat tint, never a gradient, since the color encodes which service it is.

### Cards / Containers
- **Corner Style:** `--radius-lg` (10px).
- **Background:** Graphite-800 surface on the Graphite-900 body.
- **Shadow Strategy:** None at rest (see Elevation). Hover shifts border to Strong and background to Graphite-700.
- **Border:** 1px hairline.
- **Featured:** Same flat surface, distinguished only by an accent hairline border. No glow, no gradient.
- **Internal Padding:** `lg` (16px) to `xl` (24px).

### Inputs / Fields
- **Style:** Graphite-700 fill, 1px hairline, `--radius` (7px), 13px text.
- **Focus:** Border shifts to the focus blue plus a soft 3px accent-tinted ring. No glow.
- **Disabled:** 60% opacity. **Error:** Coral hairline + Coral hint text.

### Navigation (sidebar)
- **Style:** Static panel on the Ink-Black canvas with a hairline right border. Nav links are Slate-Dim, sentence case; hover brightens to Near-White with a faint wash; the active route gets an accent-tinted fill and Near-White text.

### Glyphs / Avatars
- **Agent glyphs:** 36px rounded squares, flat tinted fills (accent / mint / amber / cyan) with a matching hairline and tone-colored initial or icon. They differentiate by hue + letter, never by gradient.
- **Brand mark:** Solid Near-White square with the Ink-Black mark. Monochrome, like the primary button.

### Status Pills & Log Feed (signature)
- The clone/index/embed/run status pills and the mono log feed are the product's core information surface. Progress fills use a flat accent tint; a low-key animated sheen marks "running"; errors use the Coral tint. Always pair color with a text label, this is the honesty contract.

## 6. Do's and Don'ts

### Do:
- **Do** keep one accent: periwinkle. Bright Signal (`#5b8def` dark / `#2f5bc0` light) for links/focus/selection/active-nav; deeper Solid (`#3856ad` dark / `#2f5bc0` light) for primary-button fills with white text.
- **Do** make primary actions a solid periwinkle fill with white text; keep secondary/ghost neutral so the one blue button is clearly the primary path.
- **Do** build separation with hairline borders (`#ffffff17`) and tonal steps, not shadows.
- **Do** pair every status color with a text/icon cue. State must read true and never imply success that hasn't happened.
- **Do** use Geist Mono for code, logs, run IDs, JSON, and tabular numbers.
- **Do** reveal configuration progressively, lead to the next concrete step, keep ready/not-ready obvious.

### Don't:
- **Don't** reintroduce the **hype-y AI aesthetic**: no glowing orbs, neon gradients, glassmorphism, or "supercharge/streamline/seamless" energy.
- **Don't** build **cluttered enterprise/devtools chrome** with every knob exposed at once.
- **Don't** fall into the **generic SaaS dashboard**: no identical card grids, no hero-metric block (big number + small label + gradient accent), no decorative widgets that only fill space.
- **Don't** use gradient text (`background-clip: text`) or gradient fills on chrome. Emphasis comes from weight, size, and the lone accent.
- **Don't** use colored glows or `box-shadow` blooms. Flat by default.
- **Don't** put tracked all-caps eyebrows over every section. Sentence-case labels; uppercase only for genuine acronyms/status tokens.
- **Don't** add a second accent hue. If a surface seems to need one, redesign it.
