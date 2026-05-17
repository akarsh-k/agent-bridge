/**
 * Per-agent localStorage flag for the one-time "your agent is ready"
 * celebration. Split from the component file so React Fast Refresh
 * (which requires component-only modules) keeps working.
 *
 * Per-agent (not workspace-wide) so each new agent gets its own
 * milestone: setting up the bridge for the first time AND wiring up
 * a second / third agent are both worth a small "you did it" moment.
 */

const LS_PREFIX = 'ab.celebrated-agent-ready:'

export function hasCelebratedAgentReady(agentId: string): boolean {
  try {
    return window.localStorage.getItem(LS_PREFIX + agentId) === 'true'
  } catch {
    return false
  }
}

export function markAgentReadyCelebrated(agentId: string): void {
  try {
    window.localStorage.setItem(LS_PREFIX + agentId, 'true')
  } catch {
    /* private mode / quota — silently drop; worst case the modal
     * re-fires once on next session. */
  }
}
