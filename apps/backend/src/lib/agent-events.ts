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
 *   - We ALSO append to `agent_config_events` so the Activity timeline
 *     can replay history across page reloads. Append happens with the
 *     same `ts` we publish on the SSE frame, so a downstream dedupe
 *     by timestamp matches the live event to its persisted row exactly.
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
import { agentConfigEventsRepo } from '@agent-bridge/db'
import { getDb } from '../db.js'
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
  const ts = Date.now()
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
    ts,
    streamId: agentStreamId(input.agentId),
    data: payload,
  }
  // Fire and forget the SSE publish — never await, never throw. Live
  // listeners receive it immediately.
  getEventBus()
    .publish(event)
    .catch((err) => {
      console.error(
        `[agent-events] publish failed (agent=${input.agentId}, ` +
          `${input.action} ${input.resource} "${payload.label}"):`,
        err,
      )
    })
  // ALSO persist so the Activity timeline can replay history. Same
  // `ts` so dedupe-by-timestamp on the client matches the live frame
  // to its persisted row. Fire-and-forget — a write failure here
  // doesn't block the request; the SSE frame still went out.
  void agentConfigEventsRepo
    .appendConfigEvent(getDb(), {
      agentId: input.agentId,
      action: input.action,
      resource: input.resource,
      label: payload.label,
      detail: payload.detail ?? null,
      ts: new Date(ts),
    })
    .catch((err) => {
      console.error(
        `[agent-events] persist failed (agent=${input.agentId}, ` +
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
