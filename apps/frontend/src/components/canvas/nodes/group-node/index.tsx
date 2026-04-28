/**
 * Group node — a single canvas card that stacks every resource of one
 * kind (skills / tools / repos / MCPs / LLM) belonging to a given agent.
 *
 * Why: prior to this, each skill/tool/etc. was its own canvas node with
 * its own edge back to the agent. An agent with five skills produced six
 * cards and five edges, cluttering the graph. The group collapses that
 * into "Skills (5)" with inner mini-cards (icon + name + meta) and a
 * single edge to the agent.
 *
 * Item layout:
 *   - Inner items render as full-width rows with a kind-coloured icon
 *     tile and a prominent name — not tiny pills. The visual weight is
 *     close to the agent card, just one level subordinate, matching the
 *     "stack of cards inside a container card" pattern used by platforms
 *     like Railway for grouped service chrome.
 *
 * Selection model:
 *   - Clicking the card chrome selects the group itself
 *     → right rail shows a list summary with click-through to each item.
 *   - Clicking an item selects the individual resource
 *     → right rail shows the resource's own details.
 *
 * The canvas routes those two cases by inspecting `event.target` inside
 * `onNodeClick` and looking for the `data-pill-id` attribute we set on
 * each item here (kept as `pill` for backward-compat with the router).
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'

import './index.css'

export type GroupKind = 'skill' | 'tool' | 'repo' | 'mcp' | 'llm'

/**
 * Opaque status token a GroupItem may carry. Only the `repo` group supplies
 * it in Phase 2A — other kinds render without a dot. Values intentionally
 * mirror `RepoStatus` so the canvas doesn't need to translate anything;
 * callers pass the column through verbatim. Kept as a string union so the
 * CSS selectors can be authored against a stable vocabulary without coupling
 * the group-node to repo-specific types.
 */
export type GroupItemStatus =
  | 'pending'
  | 'cloning'
  | 'cloned'
  | 'indexing'
  | 'ready'
  | 'error'

export interface GroupItem {
  id: string
  label: string
  sublabel?: string
  /** Optional status dot. Rendered as a small pulsing dot for in-flight
   *  states (`cloning`, `indexing`) and a solid dot for terminal states. */
  status?: GroupItemStatus
}

export interface GroupNodeData extends Record<string, unknown> {
  groupKind: GroupKind
  agentId: string
  items: readonly GroupItem[]
  dimmed?: boolean
}

const KIND_LABEL: Record<
  GroupKind,
  { singular: string; plural: string; glyph: string }
> = {
  skill: { singular: 'Skill', plural: 'Skills', glyph: '✺' },
  tool: { singular: 'Tool', plural: 'Tools', glyph: '⚙' },
  repo: { singular: 'Repo', plural: 'Repos', glyph: '❯' },
  mcp: { singular: 'MCP', plural: 'MCP', glyph: '⬡' },
  llm: { singular: 'LLM', plural: 'LLM', glyph: '◎' },
}

// How many items to show before collapsing the tail into "+N more".
const VISIBLE_ITEMS = 6

export function GroupNode({ data, selected }: NodeProps) {
  const { groupKind, items, dimmed } = data as GroupNodeData
  const meta = KIND_LABEL[groupKind]
  const count = items.length
  const visible = items.slice(0, VISIBLE_ITEMS)
  const overflow = count - visible.length

  const headerLabel =
    count === 1 && meta.singular !== meta.plural ? meta.singular : meta.plural

  return (
    <div
      className={`node node-group node-group-${groupKind}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
      data-group-kind={groupKind}
    >
      <Handle type="target" position={Position.Left} />

      <div className="node-group-header">
        <span className={`node-kind node-kind-${groupKind}`} aria-hidden="true">
          {meta.glyph}
        </span>
        <div className="node-group-title">
          <div className="node-group-label">{headerLabel}</div>
          <div className="node-group-count">
            {count === 0 ? 'empty' : count === 1 ? '1 item' : `${count} items`}
          </div>
        </div>
      </div>

      {count > 0 ? (
        <div className="node-group-items" role="list">
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className="node-group-item nodrag"
              data-pill-id={item.id}
              data-pill-kind={groupKind}
              title={
                item.sublabel ? `${item.label} — ${item.sublabel}` : item.label
              }
            >
              <span
                className={`node-kind node-kind-${groupKind} node-group-item-icon`}
                aria-hidden="true"
              >
                {meta.glyph}
              </span>
              <span className="node-group-item-text">
                <span className="node-group-item-name">{item.label}</span>
                {item.sublabel ? (
                  <span className="node-group-item-sub">{item.sublabel}</span>
                ) : null}
              </span>
              {item.status ? (
                <span
                  className={`node-group-item-status status-${item.status}`}
                  aria-label={`status: ${item.status}`}
                  title={item.status}
                />
              ) : null}
            </button>
          ))}
          {overflow > 0 ? (
            <div className="node-group-more" aria-label={`${overflow} more`}>
              +{overflow} more
            </div>
          ) : null}
        </div>
      ) : (
        <div className="node-group-empty">
          No {meta.plural.toLowerCase()} yet
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  )
}
