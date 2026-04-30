import type { ReactNode } from 'react'

export function EmptyState({
  glyph,
  title,
  body,
  action,
}: {
  glyph?: ReactNode
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="ab-empty">
      {glyph && <div className="ab-empty-glyph">{glyph}</div>}
      <div className="ab-empty-title">{title}</div>
      {body && <div className="ab-empty-body">{body}</div>}
      {action}
    </div>
  )
}
