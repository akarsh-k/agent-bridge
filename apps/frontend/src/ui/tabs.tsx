/**
 * Pill-style tab strip. Matches the Linear / DigitalOcean pattern —
 * an inset track with a single sliding pill marking the selected
 * tab. Underline-only tabs are forbidden (they read as a 2010s
 * admin panel).
 */

import type { ReactNode } from 'react'

export interface TabSpec<V extends string = string> {
  value: V
  label: ReactNode
}

export interface TabsProps<V extends string = string> {
  value: V
  onChange: (next: V) => void
  tabs: ReadonlyArray<TabSpec<V>>
  className?: string
}

export function Tabs<V extends string = string>({
  value,
  onChange,
  tabs,
  className,
}: TabsProps<V>) {
  return (
    <div className={['ab-tabs', className].filter(Boolean).join(' ')} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          className="ab-tab"
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
