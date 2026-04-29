/**
 * @mention plumbing for the chat composer (Phase 6d).
 *
 * The chat composer is a plain `<textarea>` — no rich-text editor — so the
 * mention layer here is intentionally minimal: detect when the cursor is
 * trailing an `@<query>` token, surface a filtered list of mentionable
 * resources, and on selection splice `@<token>` (with a trailing space)
 * back into the value at the trigger position. The LLM sees plain text
 * with @-prefixed identifiers; no markup, no DSL — that's what makes it
 * portable across providers.
 *
 * Trigger rules (kept boring on purpose):
 *   - `@` opens the popover only when it's preceded by start-of-string,
 *     whitespace, or a newline. `email@example.com` doesn't trigger.
 *   - The query is everything between `@` and the cursor that matches
 *     `[A-Za-z0-9_.-]*`. Hitting space, newline, or any other char closes
 *     the popover (the user moved past the mention).
 *   - The popover closes when the cursor moves left of the `@` too
 *     (selection-driven cancel).
 *
 * Ranking:
 *   - Score by case-insensitive prefix match first, substring match
 *     second, with a per-kind tiebreaker (skills > tools > agents) since
 *     skills/tools are the resources directly mounted onto this agent.
 *   - Cap to 8 visible items so the popover never grows past the
 *     composer.
 */

import type {
  AgentResponse,
  AllowlistEntryResponse,
  McpConnectionResponse,
  SkillResponse,
  ToolResponse,
} from '@agent-bridge/shared'

export type MentionKind = 'skill' | 'tool' | 'agent'

export interface MentionItem {
  readonly kind: MentionKind
  /** Insertion token (no leading '@'). e.g. "auth-flow", "notion__search". */
  readonly token: string
  /** Human-readable label used as the primary text in the popover. */
  readonly label: string
  /** Secondary text — kind hint or origin (connection name, agent slug). */
  readonly hint: string
}

export interface MentionTrigger {
  /** Char index of the `@` in the textarea value. */
  readonly start: number
  /** Char index of the cursor (one past the last query char). */
  readonly end: number
  /** Lowercased query (text between `@` and the cursor). */
  readonly query: string
}

const MAX_VISIBLE = 8
const QUERY_CHAR_RE = /^[A-Za-z0-9_.-]*$/

/**
 * Detect whether the textarea's current state has an active `@mention`
 * trigger at the cursor. Returns null when no trigger is in flight —
 * caller closes the popover.
 */
export function detectMentionTrigger(
  value: string,
  caret: number,
): MentionTrigger | null {
  if (caret <= 0 || caret > value.length) return null

  // Walk backwards to find a recent `@`. Bail at any non-query char so
  // `email@…` or `Hello world ` doesn't trigger.
  let i = caret
  while (i > 0) {
    const ch = value[i - 1]
    if (ch === '@') {
      const prev = i >= 2 ? value[i - 2] : ''
      const atBoundary = i === 1 || prev === ' ' || prev === '\n' || prev === '\t'
      if (!atBoundary) return null
      const query = value.slice(i, caret)
      if (!QUERY_CHAR_RE.test(query)) return null
      return { start: i - 1, end: caret, query: query.toLowerCase() }
    }
    if (!ch || !QUERY_CHAR_RE.test(ch)) return null
    i--
  }
  return null
}

/**
 * Splice a chosen mention into the textarea value. Returns the next
 * value + cursor offset so the caller can `setValue` and reposition the
 * caret in one render. We always append a trailing space — without it
 * the caret sits glued to the token and the next character extends the
 * mention rather than starting a new word.
 */
export function applyMention(
  value: string,
  trigger: MentionTrigger,
  item: MentionItem,
): { nextValue: string; nextCaret: number } {
  const before = value.slice(0, trigger.start)
  const after = value.slice(trigger.end)
  const insertion = `@${item.token} `
  const nextValue = `${before}${insertion}${after}`
  const nextCaret = before.length + insertion.length
  return { nextValue, nextCaret }
}

/**
 * Build the mentionable items for the chat composer. Sources:
 *   - This agent's skills and native tools (most relevant — they're
 *     mounted directly).
 *   - This agent's MCP allowlist entries, surfaced with the namespaced
 *     `<connection-slug>__<tool-name>` shape that mirrors how
 *     `mountExternalMcps` registers them at runtime, so the LLM can
 *     reference the exact key it sees in its tool dict.
 *   - Other agents, by slug — handy when an operator wants to say
 *     "ask @other-agent" inline.
 */
export function buildMentionItems(input: {
  agentId: string
  skills: readonly SkillResponse[]
  tools: readonly ToolResponse[]
  mcpAllowlist: readonly AllowlistEntryResponse[]
  mcpConnections: readonly McpConnectionResponse[]
  agents: readonly AgentResponse[]
}): readonly MentionItem[] {
  const items: MentionItem[] = []

  for (const skill of input.skills) {
    items.push({
      kind: 'skill',
      token: skill.name,
      label: skill.name,
      hint: 'skill',
    })
  }

  for (const tool of input.tools) {
    items.push({
      kind: 'tool',
      token: tool.name,
      label: tool.name,
      hint: `tool · ${tool.kind}`,
    })
  }

  // Index MCP connections by id so we can show the connection's name on
  // each allowlisted tool. Slug derived the same way as
  // `mountExternalMcps` (lowercase, non-alphanumeric → `_`) so the
  // namespaced key in the LLM's tool dict matches the suggestion the
  // operator sees.
  const connectionsById = new Map<string, McpConnectionResponse>()
  for (const c of input.mcpConnections) connectionsById.set(c.id, c)
  for (const entry of input.mcpAllowlist) {
    const conn = connectionsById.get(entry.mcpConnectionId)
    if (!conn) continue
    const slug = slugifyConnectionName(conn.name)
    const namespaced = `${slug}__${entry.toolName}`
    items.push({
      kind: 'tool',
      token: namespaced,
      label: namespaced,
      hint: `mcp · ${conn.name}`,
    })
  }

  for (const agent of input.agents) {
    if (agent.id === input.agentId) continue
    items.push({
      kind: 'agent',
      token: agent.slug,
      label: agent.name,
      hint: `agent · ${agent.slug}`,
    })
  }

  return items
}

/**
 * Filter + rank mention items against the typed query. Returns at most
 * `MAX_VISIBLE`; an empty query returns the first slice (the popover
 * shows the same set of mentionables every time the operator types `@`
 * by itself).
 */
export function rankMentionItems(
  items: readonly MentionItem[],
  query: string,
): readonly MentionItem[] {
  if (!query) return items.slice(0, MAX_VISIBLE)

  const q = query.toLowerCase()
  const scored: Array<{ item: MentionItem; score: number }> = []
  for (const item of items) {
    const tokenLc = item.token.toLowerCase()
    const labelLc = item.label.toLowerCase()
    let score = -1
    if (tokenLc.startsWith(q) || labelLc.startsWith(q)) score = 100
    else if (tokenLc.includes(q) || labelLc.includes(q)) score = 50
    if (score < 0) continue
    score += kindBoost(item.kind)
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_VISIBLE).map((s) => s.item)
}

function kindBoost(kind: MentionKind): number {
  switch (kind) {
    case 'skill':
      return 3
    case 'tool':
      return 2
    case 'agent':
      return 1
  }
}

/**
 * Mirror of `mountExternalMcps`'s slug derivation. Kept as a private
 * helper here (instead of importing from `packages/agents`) because the
 * Mastra-importing module is node-only — duplicating this 3-line rule
 * keeps the browser bundle clean. If `mountExternalMcps` ever changes
 * the slug rule, this helper is the only place to update on the
 * frontend side.
 */
function slugifyConnectionName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'ext'
}
