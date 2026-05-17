/**
 * AgentReadinessCard — checklist of setup steps a new operator needs
 * to make an agent fully functional. Replaces the standalone
 * "No LLM provider" alert with a comprehensive view: prompt, chat
 * provider, plus embedding provider + attached repo for the coding /
 * inspector template.
 *
 * Renders nothing when every check passes — the absence of the card
 * is the signal that everything is wired up. A regression (e.g. the
 * embedding provider is deleted) makes the card reappear automatically
 * since readiness is derived, not stored.
 */

import { useState } from 'react'
import { Button } from '../../ui/button'
import { CheckIcon, ArrowRightIcon } from '../../ui/icons'
import { navigate } from '../../lib/router'
import { useAgentReadiness, type ReadinessAction } from './use-agent-readiness'
import { AttachRepoSheet } from './attach-repo-sheet'
import { ProviderCreateSheet } from '../library/provider-create-sheet'

/**
 * Poll for an element by id and smooth-scroll to it once it mounts.
 * The target tab is lazy-loaded, so the element doesn't exist on the
 * frame the tab switch fires — but it will within a few frames. The
 * 30-frame ceiling (~500ms at 60fps) caps the wait so we don't keep
 * polling forever if the user clicked away.
 */
function scrollIntoViewWhenReady(id: string, maxAttempts = 30): void {
  let attempts = 0
  const tick = () => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (++attempts < maxAttempts) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function AgentReadinessCard({
  agentId,
  onNavigateToTab,
}: {
  agentId: string
  onNavigateToTab: (tab: 'configure' | 'resources') => void
}) {
  const { ready, remaining, checks } = useAgentReadiness(agentId)
  const [attachRepoOpen, setAttachRepoOpen] = useState(false)
  const [providerSheetRole, setProviderSheetRole] = useState<
    'chat' | 'embedding' | null
  >(null)

  if (ready) return null

  const runAction = (action: ReadinessAction) => {
    if (action.kind === 'tab') {
      onNavigateToTab(action.tab)
      if (action.scrollTo) scrollIntoViewWhenReady(action.scrollTo)
    } else if (action.kind === 'open-attach-repo-sheet') {
      setAttachRepoOpen(true)
    } else if (action.kind === 'open-provider-sheet') {
      setProviderSheetRole(action.defaultRole)
    } else if (action.kind === 'navigate') {
      navigate(action.href)
    }
  }

  return (
    <>
      <div className="ab-card ab-card-pad" style={{ marginBottom: 18 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div className="ab-section-title">Set up this agent</div>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
            }}
          >
            {remaining} step{remaining === 1 ? '' : 's'} left — finish these
            to make it run end-to-end.
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {checks.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                background: c.done ? 'var(--surface-hi)' : 'var(--surface)',
                opacity: c.done ? 0.65 : 1,
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  flexShrink: 0,
                  marginTop: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: c.done ? 'var(--success)' : 'var(--surface-hi)',
                  color: c.done ? 'var(--bg-canvas)' : 'var(--text-muted)',
                  border: c.done
                    ? '1px solid var(--success)'
                    : '1px solid var(--border)',
                }}
              >
                {c.done ? (
                  <CheckIcon width={12} height={12} strokeWidth={3} />
                ) : null}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--text)',
                  }}
                >
                  {c.label}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    color: 'var(--text-dim)',
                  }}
                >
                  {c.body}
                </div>
              </div>
              {!c.done && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => runAction(c.action)}
                  trailing={<ArrowRightIcon strokeWidth={2.4} />}
                >
                  {c.actionLabel}
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      <AttachRepoSheet
        open={attachRepoOpen}
        agentId={agentId}
        onClose={() => setAttachRepoOpen(false)}
      />
      <ProviderCreateSheet
        open={providerSheetRole !== null}
        defaultRole={providerSheetRole ?? 'chat'}
        onClose={() => setProviderSheetRole(null)}
      />
    </>
  )
}
