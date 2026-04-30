/**
 * Pure helpers used across the agent UI to keep view code clean.
 */

import type { IDEKind } from '../ui/bridge-row'

const GLYPH_KINDS = ['violet', 'green', 'amber', 'cyan'] as const
export type GlyphKind = (typeof GLYPH_KINDS)[number]

/**
 * Stable colour-tile assignment for an agent — hash the id so the
 * same agent always gets the same tint across sessions.
 */
export function agentGlyphKind(id: string): GlyphKind {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return GLYPH_KINDS[h % GLYPH_KINDS.length] as GlyphKind
}

/**
 * Per-agent bridge connections. Today the only bridge transport is
 * MCP-from-IDE — the agents-context will eventually own this; for
 * now we deterministically derive a deterministic-but-varied list
 * from the agent id so cards demonstrate connected vs disconnected
 * states without round-tripping the backend.
 */
const ALL_IDES: ReadonlyArray<IDEKind> = ['cursor', 'claude', 'codex', 'opencode']
export function deriveAgentBridges(id: string): ReadonlyArray<IDEKind> {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const mode = h % 4
  // 0 → none (disconnected), 1–3 → 1, 2, or 3 IDEs
  if (mode === 0) return []
  return ALL_IDES.slice(0, mode)
}
