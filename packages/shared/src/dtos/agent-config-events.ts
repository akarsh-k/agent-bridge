/**
 * Persisted history of `agent.config.changed` events. The Activity
 * timeline reads this so the user can see "when did I attach repo X?"
 * across page reloads — the SSE-only path forgets everything when the
 * connection resets.
 */

import { z } from 'zod'
import { agentConfigActions, agentConfigResources } from '../events.js'

export const agentConfigEventResponseSchema = z.object({
  /** bigserial — string-encoded so JSON parsers don't truncate. */
  id: z.string(),
  agentId: z.uuid(),
  /** ISO8601 timestamp the event was published at. */
  ts: z.iso.datetime(),
  action: z.enum(agentConfigActions),
  resource: z.enum(agentConfigResources),
  label: z.string(),
  detail: z.string().nullable(),
})
export type AgentConfigEventResponse = z.infer<
  typeof agentConfigEventResponseSchema
>

export const agentConfigEventListResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(agentConfigEventResponseSchema),
})
export type AgentConfigEventListResponse = z.infer<
  typeof agentConfigEventListResponseSchema
>
