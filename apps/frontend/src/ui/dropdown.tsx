/**
 * Custom popover-based dropdown — replaces every native <select>.
 * Trigger is styled like the Input primitive so labelled fields look
 * uniform. Menu animates open from the top, click-outside / Esc close,
 * options carry a label + optional sub-text + optional leading SVG.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CheckIcon, ChevronDownIcon } from './icons'

export interface DropdownOption<V extends string = string> {
  value: V
  label: ReactNode
  sub?: ReactNode
  monoLabel?: boolean
  leading?: ReactNode
  disabled?: boolean
  disabledReason?: string
}

export interface DropdownProps<V extends string = string> {
  value: V | null
  onChange: (next: V) => void
  options: ReadonlyArray<DropdownOption<V>>
  placeholder?: string
  disabled?: boolean
  className?: string
  labelId?: string
}

export function Dropdown<V extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  className,
  labelId,
}: DropdownProps<V>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const id = useId()

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const selected = options.find((o) => o.value === value)

  return (
    <div
      ref={rootRef}
      className={[
        'ab-dropdown',
        open && 'is-open',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className="ab-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        aria-controls={`${id}-menu`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={[
            'ab-dropdown-value',
            selected?.monoLabel && 'ab-mono',
            !selected && 'ab-dropdown-placeholder',
          ]
            .filter(Boolean)
            .join(' ')}
          style={!selected ? { color: 'var(--text-muted)' } : undefined}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon className="ab-dropdown-chev" strokeWidth={2.4} />
      </button>
      <div className="ab-dropdown-menu" role="listbox" id={`${id}-menu`}>
        {options.map((opt) => (
          <div
            key={opt.value}
            role="option"
            aria-selected={opt.value === value}
            aria-disabled={opt.disabled}
            className="ab-dropdown-option"
            title={opt.disabled ? opt.disabledReason : undefined}
            style={
              opt.disabled
                ? { opacity: 0.5, cursor: 'not-allowed' }
                : undefined
            }
            onClick={() => {
              if (opt.disabled) return
              onChange(opt.value)
              close()
            }}
          >
            {opt.leading && <span className="ab-dropdown-leading">{opt.leading}</span>}
            <span className="ab-dropdown-option-stack">
              <span className={opt.monoLabel ? 'ab-mono' : undefined}>
                {opt.label}
              </span>
              {(opt.sub || opt.disabledReason) && (
                <span className="ab-dropdown-option-sub">
                  {opt.disabled && opt.disabledReason
                    ? opt.disabledReason
                    : opt.sub}
                </span>
              )}
            </span>
            <CheckIcon className="ab-check" strokeWidth={2.6} />
          </div>
        ))}
      </div>
    </div>
  )
}
