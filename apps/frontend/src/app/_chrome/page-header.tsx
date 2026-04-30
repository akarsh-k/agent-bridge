import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="ab-page-header">
      <div>
        <h1 className="ab-page-title">{title}</h1>
        {subtitle && <p className="ab-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ab-page-actions">{actions}</div>}
    </div>
  )
}
