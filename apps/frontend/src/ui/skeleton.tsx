/**
 * Skeleton — a single shimmering placeholder block. Compose these to
 * build loading states that mirror a real layout, so when the loaded
 * content swaps in it barely shifts the page. Purely decorative: each
 * block is hidden from assistive tech, and the loading region itself
 * carries the busy/label semantics.
 */

import type { CSSProperties } from 'react'

interface SkeletonProps {
  /** Any CSS width (a number is treated as px). Defaults to 100%. */
  width?: number | string
  /** Any CSS height (a number is treated as px). */
  height?: number | string
  /** Render as a pill/circle, for avatars and dots. */
  circle?: boolean
  /** Corner-radius override; ignored when `circle` is set. */
  radius?: string
  style?: CSSProperties
}

export function Skeleton({
  width = '100%',
  height,
  circle = false,
  radius,
  style,
}: SkeletonProps) {
  return (
    <span
      className="ab-skel"
      aria-hidden="true"
      style={{
        width,
        height,
        ...(circle
          ? { borderRadius: 'var(--radius-pill)' }
          : radius
            ? { borderRadius: radius }
            : null),
        ...style,
      }}
    />
  )
}
