/**
 * Persisted history for `agent.config.changed` events. The SSE frames
 * live in memory only; this table is the durable record so the
 * Activity timeline can answer "when did I attach repo X?" /
 * "when was the MCP allowlist last edited?" across page reloads.
 *
 * Append-only by design — same shape as `run_events`. Cascades on
 * agent delete, so a wiped agent leaves no audit trail behind.
 */

import { and, desc, eq, lt } from 'drizzle-orm'
import { agentConfigEvents } from './schema.js'
import type { AgentConfigEventRow } from './schema.js'
import type { AgentBridgeDb } from './client.js'

export interface AppendConfigEventInput {
  readonly agentId: string
  readonly action: string
  readonly resource: string
  readonly label: string
  readonly detail?: string | null
  /**
   * Override the insert-time `now()` default. Used so the persisted
   * row carries the same `ts` the SSE frame already published — keeps
   * the audit row and the live event identical for downstream
   * dedupe-by-timestamp logic in the Activity timeline.
   */
  readonly ts?: Date
}

export async function appendConfigEvent(
  handle: AgentBridgeDb,
  input: AppendConfigEventInput,
): Promise<AgentConfigEventRow> {
  const [row] = await handle.db
    .insert(agentConfigEvents)
    .values({
      agentId: input.agentId,
      action: input.action,
      resource: input.resource,
      label: input.label,
      detail: input.detail ?? null,
      ...(input.ts ? { ts: input.ts } : {}),
    })
    .returning()
  if (!row) {
    throw new Error('appendConfigEvent: insert returned no rows')
  }
  return row
}

export interface ListConfigEventsInput {
  readonly agentId: string
  /** Newest-first cap. Default 100, max 500. */
  readonly limit?: number
  /** Optional `ts < before` cursor for paging older entries. */
  readonly before?: Date
}

/** Newest-first scan for the Activity timeline. */
export async function listConfigEvents(
  handle: AgentBridgeDb,
  input: ListConfigEventsInput,
): Promise<readonly AgentConfigEventRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const cond = input.before
    ? and(
        eq(agentConfigEvents.agentId, input.agentId),
        lt(agentConfigEvents.ts, input.before),
      )
    : eq(agentConfigEvents.agentId, input.agentId)
  const rows = await handle.db
    .select()
    .from(agentConfigEvents)
    .where(cond)
    .orderBy(desc(agentConfigEvents.ts), desc(agentConfigEvents.id))
    .limit(limit)
  return rows
}

