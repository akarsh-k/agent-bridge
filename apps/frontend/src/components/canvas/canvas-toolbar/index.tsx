import './index.css'

export interface CanvasToolbarProps {
  readonly mode: 'overview' | 'focus'
  readonly canExitFocus: boolean
  readonly onOverview: () => void
  readonly onOrganize: () => void
  readonly onResetLayout: () => void
}

export function CanvasToolbar({
  mode,
  canExitFocus,
  onOverview,
  onOrganize,
  onResetLayout,
}: CanvasToolbarProps) {
  const showLayoutActions = mode === 'overview'

  return (
    <div className="canvas-toolbar nopan nodrag" aria-label="Canvas controls">
      <div className="canvas-toolbar-label">
        {mode === 'focus' ? 'Agent focus' : 'Workspace overview'}
      </div>
      {canExitFocus ? (
        <button type="button" className="canvas-toolbar-btn" onClick={onOverview}>
          Overview
        </button>
      ) : null}
      {showLayoutActions ? (
        <>
          <button type="button" className="canvas-toolbar-btn" onClick={onOrganize}>
            Organize
          </button>
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={onResetLayout}
            title="Clear saved drag positions and re-apply the default layout"
          >
            Reset layout
          </button>
        </>
      ) : null}
    </div>
  )
}
