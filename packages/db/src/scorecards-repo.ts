/**
 * Queries for the Retrieval Scorecard golden set (`scorecard_queries`).
 *
 * The editor saves the whole list at once, so the write path is a
 * transactional replace (delete-all-for-agent → insert) rather than
 * per-row CRUD. Reads are ordered by `position` then `created_at`.
 */

import { asc, eq } from 'drizzle-orm'

import type { AgentBridgeDb } from './client.js'
import { scorecardQueries, type ScorecardQueryDbRow } from './schema.js'

export interface ScorecardQueryInputRow {
  readonly query: string
  readonly expectedSnippets: string[]
  readonly expectedPage: number | null
  readonly note: string
}

export async function listQueries(
  handle: AgentBridgeDb,
  agentId: string,
): Promise<ScorecardQueryDbRow[]> {
  return handle.db
    .select()
    .from(scorecardQueries)
    .where(eq(scorecardQueries.agentId, agentId))
    .orderBy(asc(scorecardQueries.position), asc(scorecardQueries.createdAt))
}

/**
 * Replace the entire golden set for an agent. Runs in a transaction so
 * a partial failure can't leave the set half-rewritten.
 */
export async function replaceQueries(
  handle: AgentBridgeDb,
  agentId: string,
  queries: ReadonlyArray<ScorecardQueryInputRow>,
): Promise<ScorecardQueryDbRow[]> {
  return handle.db.transaction(async (tx) => {
    await tx
      .delete(scorecardQueries)
      .where(eq(scorecardQueries.agentId, agentId))
    if (queries.length === 0) return []
    return tx
      .insert(scorecardQueries)
      .values(
        queries.map((q, i) => ({
          agentId,
          query: q.query,
          expectedSnippets: q.expectedSnippets,
          expectedPage: q.expectedPage,
          note: q.note,
          position: i,
        })),
      )
      .returning()
  })
}
