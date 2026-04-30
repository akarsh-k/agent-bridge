/**
 * Tiny HTML5 drag-and-drop reordering hook for list rows.
 *
 * Returns row props + UI state. Consumer handles persistence in
 * `onReorder` (called once with the new id-array after a drop).
 */

import { useCallback, useState } from 'react'

export interface DragRowProps {
  draggable: boolean
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragEnter: (e: React.DragEvent<HTMLElement>) => void
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDrop: (e: React.DragEvent<HTMLElement>) => void
  /** True while THIS row is being dragged. */
  isDragging: boolean
  /** True while the drop indicator is hovering above THIS row. */
  isDropTarget: boolean
}

export interface UseDragReorderResult {
  rowProps: (id: string) => DragRowProps
  /** True while any row is being dragged. Useful to show a hint. */
  isReordering: boolean
}

export function useDragReorder<T>(
  items: ReadonlyArray<T>,
  getId: (item: T) => string,
  onReorder: (nextIds: ReadonlyArray<string>) => void,
): UseDragReorderResult {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const rowProps = useCallback(
    (id: string): DragRowProps => ({
      draggable: true,
      onDragStart: (e) => {
        setDraggingId(id)
        e.dataTransfer.effectAllowed = 'move'
        // Firefox needs at least one piece of data to start the drag.
        e.dataTransfer.setData('text/plain', id)
      },
      onDragEnter: (e) => {
        e.preventDefault()
        if (id !== draggingId) setOverId(id)
      },
      onDragOver: (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragEnd: () => {
        setDraggingId(null)
        setOverId(null)
      },
      onDrop: (e) => {
        e.preventDefault()
        const dragged = draggingId
        setDraggingId(null)
        setOverId(null)
        if (!dragged || dragged === id) return
        const ids = items.map(getId)
        const from = ids.indexOf(dragged)
        const to = ids.indexOf(id)
        if (from === -1 || to === -1) return
        const next = ids.slice()
        const [moved] = next.splice(from, 1)
        if (moved !== undefined) next.splice(to, 0, moved)
        onReorder(next)
      },
      isDragging: id === draggingId,
      isDropTarget: id === overId && id !== draggingId,
    }),
    [draggingId, overId, items, getId, onReorder],
  )

  return { rowProps, isReordering: draggingId !== null }
}
