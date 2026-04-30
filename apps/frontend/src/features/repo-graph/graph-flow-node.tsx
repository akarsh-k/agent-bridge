/**
 * GraphFlowNode — custom React Flow node for the GraphModal.
 *
 * Why a custom node (vs the default one):
 *   - Per-kind icon left-glyph (folder/file/function/class/method) so
 *     the operator can read the graph at a glance without the legend.
 *   - Optional path hint under the symbol name — keeps the call graph
 *     legible when the same function name appears in multiple files.
 *   - Optional degree badge so the most-connected nodes pop visually.
 *
 * The node DOM lives at the dagre-computed position; widths/heights
 * still match `NODE_WIDTH` / `NODE_HEIGHT` in graph-modal.tsx so the
 * layout engine and the CSS frame agree.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { RepoGraphMode, RepoGraphNodeKind } from '@agent-bridge/shared'

export interface GraphFlowNodeData {
  /** Display label (already shortened by the modal). */
  readonly label: string
  /** Optional dimmer subtitle — file path for symbols, kind hint for
   *  hierarchical nodes. */
  readonly subtitle: string | null
  readonly kind: RepoGraphNodeKind
  /** Edge degree at extraction time. `null` for nodes whose mode
   *  doesn't compute degrees (structure mode). */
  readonly degree: number | null
  /** Mode that produced this node — used to pick handle positions so
   *  React Flow's edge anchoring matches dagre's layout direction. */
  readonly mode: RepoGraphMode
}

export function GraphFlowNode({ data }: NodeProps) {
  // Custom nodes receive an unknown-shaped `data` from React Flow's
  // generic prop type; we own the writers, so a structural cast is
  // fine here — there's no runtime contract to enforce beyond what
  // the modal already validates.
  const d = data as unknown as GraphFlowNodeData
  const sourcePos = d.mode === 'symbols' ? Position.Bottom : Position.Right
  const targetPos = d.mode === 'symbols' ? Position.Top : Position.Left

  return (
    <div className={`graph-node graph-node-${d.kind}`}>
      <Handle
        type="target"
        position={targetPos}
        className="graph-node-handle"
      />
      <span className={`graph-node-icon graph-node-icon-${d.kind}`}>
        <KindGlyph kind={d.kind} />
      </span>
      <span className="graph-node-text">
        <span className="graph-node-name">{d.label}</span>
        {d.subtitle ? (
          <span className="graph-node-subtitle">{d.subtitle}</span>
        ) : null}
      </span>
      {d.degree && d.degree > 1 ? (
        <span className="graph-node-degree" title={`${d.degree} edges`}>
          {d.degree}
        </span>
      ) : null}
      <Handle
        type="source"
        position={sourcePos}
        className="graph-node-handle"
      />
    </div>
  )
}

function KindGlyph({ kind }: { kind: RepoGraphNodeKind }) {
  // SVG icons sized to fit the 22px glyph slot. We use stroke-only
  // glyphs so they ride the per-kind tint via `currentColor`.
  switch (kind) {
    case 'folder':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'file':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M9 2v3h3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'function':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <text
            x="8"
            y="12"
            textAnchor="middle"
            fontFamily="ui-serif, Georgia, serif"
            fontStyle="italic"
            fontWeight="700"
            fontSize="13"
            fill="currentColor"
          >
            ƒ
          </text>
        </svg>
      )
    case 'class':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect
            x="2.5"
            y="2.5"
            width="11"
            height="11"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M5 6.5h6M5 9h6M5 11.5h4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'method':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M5.6 8.5l1.7 1.7L10.6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}
