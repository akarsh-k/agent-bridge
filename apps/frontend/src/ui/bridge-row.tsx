/**
 * Bridge connection footer for an agent card. Two states — connected
 * (icon stack + IDE names + green "Live") and disconnected (dashed
 * tile CTA). Locked-in patterns from the iteration loop:
 *   - no "BRIDGED VIA" tracking-cap label
 *   - no vertical separator between the stack and the name list
 *   - no pill chrome on the live status
 *   - disconnected state is full-width and dashed, NOT a faint chip
 */

import type { ReactNode } from 'react'
import {
  ClaudeMark,
  CodexMark,
  CursorMark,
  PlugIcon,
  ArrowRightIcon,
} from './icons'
import { Tooltip } from './tooltip'

export type IDEKind = 'cursor' | 'claude' | 'codex' | 'opencode'

const ideMeta: Record<IDEKind, { label: string; mark: () => ReactNode }> = {
  cursor: { label: 'Cursor', mark: () => <CursorMark /> },
  claude: { label: 'Claude Code', mark: () => <ClaudeMark /> },
  codex: { label: 'Codex', mark: () => <CodexMark /> },
  opencode: { label: 'OpenCode', mark: () => <CursorMark /> },
}

export function IDEAvatar({ kind }: { kind: IDEKind }) {
  const m = ideMeta[kind]
  return (
    <Tooltip label={m.label} side="top">
      <span className={`ab-ide-avatar ab-ide-${kind}`} aria-label={m.label}>
        {m.mark()}
      </span>
    </Tooltip>
  )
}

export function IDEAvatarStack({ ides }: { ides: ReadonlyArray<IDEKind> }) {
  return (
    <span className="ab-ide-stack">
      {ides.map((kind) => (
        <IDEAvatar key={kind} kind={kind} />
      ))}
    </span>
  )
}

export interface BridgeRowProps {
  ides: ReadonlyArray<IDEKind>
  live?: boolean
  onConnect?: () => void
}

export function BridgeRow({ ides, live = true, onConnect }: BridgeRowProps) {
  if (ides.length === 0) {
    return (
      <div
        className="ab-bridge-row is-off"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onConnect?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onConnect?.()
          }
        }}
      >
        <div className="ab-bridge-cta-glyph">
          <PlugIcon />
        </div>
        <span className="ab-bridge-cta-title">Bridge to your IDE</span>
        <ArrowRightIcon className="ab-bridge-cta-arrow" />
      </div>
    )
  }

  const names = ides.map((k) => ideMeta[k].label).join(', ')
  return (
    <div className="ab-bridge-row">
      <IDEAvatarStack ides={ides} />
      <span className="ab-bridge-name">{names}</span>
      {live && (
        <span className="ab-bridge-state">
          <span className="ab-pulse-dot" />
          Live
        </span>
      )}
    </div>
  )
}
