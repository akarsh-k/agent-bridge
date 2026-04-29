/**
 * Helper for publishing `agent.config.changed` SSE frames from CRUD
 * routes. Lets the right-rail Activity panel surface "skill X added",
 * "repo Y attached", etc. inline with runtime events.
 *
 * Design rules:
 *   - Fire-and-forget. CRUD routes call this AFTER the DB write
 *     succeeds; a publish failure is logged but never propagates back
 *     to the user. The DB row + `updated_at` is the canonical record;
 *     the SSE frame is just a live-feed hint.
 *   - No audit row. `run_events` is keyed by `run_id`, which doesn't
 *     apply to config edits. Replay isn't needed — opening the
 *     inspector reads the current row.
 *   - Routes call `publishAgentConfig(...)` once per logical mutation
 *     (a single PUT that replaces an allowlist is one event, not N).
 *   - `label` is trimmed to a sensible max so a malicious or buggy
 *     client can't push a multi-MB payload through SSE just by
 *     sending a giant skill name.
 */

import {
  agentStreamId,
  type AgentConfigAction,
  type AgentConfigChangedPayload,
  type AgentConfigResource,
  type RunEvent,
} from '@agent-bridge/shared'
import { getEventBus } from '../event-bus.js'

const MAX_LABEL_LEN = 200
const MAX_DETAIL_LEN = 500

export interface PublishAgentConfigInput {
  readonly agentId: string
  readonly action: AgentConfigAction
  readonly resource: AgentConfigResource
  readonly label: string
  readonly detail?: string
}

export function publishAgentConfig(input: PublishAgentConfigInput): void {
  const payload: AgentConfigChangedPayload = {
    agentId: input.agentId,
    action: input.action,
    resource: input.resource,
    label: trim(input.label, MAX_LABEL_LEN),
    ...(input.detail
      ? { detail: trim(input.detail, MAX_DETAIL_LEN) }
      : {}),
  }
  const event: RunEvent = {
    kind: 'agent.config.changed',
    ts: Date.now(),
    streamId: agentStreamId(input.agentId),
    data: payload,
  }
  // Fire and forget — never await, never throw.
  getEventBus()
    .publish(event)
    .catch((err) => {
      console.error(
        `[agent-events] publish failed (agent=${input.agentId}, ` +
          `${input.action} ${input.resource} "${payload.label}"):`,
        err,
      )
    })
}

function trim(value: string, max: number): string {
  if (value.length <= max) return value
  // Use the byte-safe truncation; the `…` keeps the renderer's
  // "this got cut" hint without inventing its own ellipsis policy.
  return `${value.slice(0, max - 1)}…`
}
