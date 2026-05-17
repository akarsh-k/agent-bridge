/**
 * One-time "your agent is ready" celebration. Fires the first time a
 * workspace has any agent with an LLM provider assigned — that's the
 * minimum bar for a runnable agent.
 *
 * Two CTAs:
 *   - Open Chat — switches to the chat tab on this agent so the user
 *     can talk to it immediately.
 *   - Open Bridge — jumps to the Bridge page where the IDE-side MCP
 *     config lives, so the user can wire Cursor / Claude Code /
 *     Codex up and use the agent as a callable tool from there.
 *
 * Persistence: a single workspace-wide localStorage flag so the modal
 * never re-fires. Power users with many agents shouldn't have to
 * dismiss this every time they wire one up — the bridge instructions
 * only matter the first time.
 */

import { useEffect } from 'react'
import { Button } from '../../ui/button'
import { CheckIcon, CloseIcon, ChatIcon, BridgeIcon } from '../../ui/icons'
import { markAgentReadyCelebrated } from './agent-ready-celebration-flag'

export function AgentReadyCelebration({
  open,
  agentId,
  agentName,
  onClose,
  onOpenChat,
  onOpenBridge,
}: {
  open: boolean
  agentId: string
  agentName: string
  onClose: () => void
  onOpenChat: () => void
  onOpenBridge: () => void
}) {
  // Persist the "seen it" flag as soon as the modal mounts, so a
  // refresh mid-celebration doesn't re-fire it.
  useEffect(() => {
    if (open) markAgentReadyCelebrated(agentId)
  }, [open, agentId])

  // Escape to close — matches the rest of the modal/sheet system.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="ab-sheet-backdrop is-open" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ab-celebration-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(480px, calc(100vw - 32px))',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-3)',
          zIndex: 102,
          padding: '28px 24px 20px',
          animation: 'ab-dialog-in 220ms var(--ease-out)',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 6,
            borderRadius: 'var(--radius-xs)',
            display: 'flex',
          }}
        >
          <CloseIcon width={16} height={16} />
        </button>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 12,
          }}
        >
          <div
            className="ab-glyph ab-glyph-green"
            style={{ width: 48, height: 48 }}
          >
            <CheckIcon width={22} height={22} strokeWidth={2.6} />
          </div>
          <h2
            id="ab-celebration-title"
            className="ab-section-title"
            style={{ margin: 0, fontSize: 18 }}
          >
            Your agent's ready
          </h2>
          <div
            className="ab-section-sub"
            style={{ maxWidth: 380, lineHeight: 1.5 }}
          >
            <strong>{agentName}</strong> has a model assigned and can answer
            prompts. Two ways to talk to it from here.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            marginTop: 22,
          }}
        >
          <Button
            variant="primary"
            onClick={() => {
              onOpenChat()
              onClose()
            }}
            leading={<ChatIcon />}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            Open Chat
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenBridge()
              onClose()
            }}
            leading={<BridgeIcon />}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            Open Bridge
          </Button>
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 12,
            color: 'var(--text-muted)',
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          Bridge has the MCP config snippet for Cursor / Claude Code / Codex —
          paste it once and your agent shows up as a callable tool inside the
          IDE.
        </div>
      </div>
    </>
  )
}
