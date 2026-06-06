/**
 * Queries for the Retrieval Scorecard golden set (`scorecard_queries`).
 *
 * The editor saves the whole list at once, so the write path is a
 * transactional replace (delete-all-for-agent → insert) rather than
 * per-row CRUD. Reads are ordered by `position` then `created_at`.
 */

import { and, asc, desc, eq, ne } from 'drizzle-orm'

import type { AgentBridgeDb } from './client.js'
import {
  scorecardQueries,
  scorecardRuns,
  type ScorecardQueryDbRow,
  type ScorecardRunDbInsert,
  type ScorecardRunDbRow,
} from './schema.js'

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

// ─── Saved runs (for before/after comparison) ──────────────────────────────

/** Persist one run's aggregate scores. */
export async function insertRun(
  handle: AgentBridgeDb,
  input: Omit<
    ScorecardRunDbInsert,
    'id' | 'createdAt' | 'isBaseline' | 'label'
  > & {
    label?: string
  },
): Promise<ScorecardRunDbRow> {
  const [row] = await handle.db.insert(scorecardRuns).values(input).returning()
  return row!
}

/**
 * The run a new run should be compared against: the pinned baseline if one
 * exists (and isn't the run we just created), otherwise the most recent
 * prior run. Null when this is the agent's first run.
 */
export async function getComparisonRun(
  handle: AgentBridgeDb,
  agentId: string,
  excludeRunId: string,
): Promise<ScorecardRunDbRow | null> {
  const [baseline] = await handle.db
    .select()
    .from(scorecardRuns)
    .where(
      and(
        eq(scorecardRuns.agentId, agentId),
        eq(scorecardRuns.isBaseline, true),
      ),
    )
    .limit(1)
  if (baseline && baseline.id !== excludeRunId) return baseline
  const [prev] = await handle.db
    .select()
    .from(scorecardRuns)
    .where(
      and(
        eq(scorecardRuns.agentId, agentId),
        ne(scorecardRuns.id, excludeRunId),
      ),
    )
    .orderBy(desc(scorecardRuns.createdAt))
    .limit(1)
  return prev ?? null
}

/** Pin one run as the agent's baseline (clears the flag on the others). */
export async function setBaseline(
  handle: AgentBridgeDb,
  agentId: string,
  runId: string,
): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx
      .update(scorecardRuns)
      .set({ isBaseline: false })
      .where(eq(scorecardRuns.agentId, agentId))
    await tx
      .update(scorecardRuns)
      .set({ isBaseline: true })
      .where(
        and(eq(scorecardRuns.id, runId), eq(scorecardRuns.agentId, agentId)),
      )
  })
}
