import type { ReactNode } from 'react'

export type PillKind =
  | 'neutral'
  | 'success'
  | 'warn'
  | 'danger'
  | 'accent'

export interface PillProps {
  kind?: PillKind
  dot?: boolean
  children: ReactNode
  className?: string
}

const map: Record<PillKind, string> = {
  neutral: '',
  success: 'ab-pill-success',
  warn: 'ab-pill-warn',
  danger: 'ab-pill-danger',
  accent: 'ab-pill-accent',
}

export function Pill({ kind = 'neutral', dot, children, className }: PillProps) {
  return (
    <span className={['ab-pill', map[kind], className].filter(Boolean).join(' ')}>
      {dot && <span className="ab-pill-dot" />}
      {children}
    </span>
  )
}
