/**
 * `/api/agents/:agentId/scorecard/*` — Retrieval Scorecard.
 *
 *   GET  /queries   → the saved golden set for this agent
 *   PUT  /queries   → replace the golden set (the editor saves the whole list)
 *   POST /run       → run the scorecard and return per-strategy scores
 *
 * The run is synchronous: it embeds each query and runs the hybrid
 * strategies inline, returning the full scorecard in the response. Fine
 * for the hand-authored sets this targets (tens of questions); a large
 * set should move to a worker job + SSE progress (follow-up).
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import {
  scorecardQueriesSaveInputSchema,
  scorecardRunInputSchema,
  type ScorecardQueryInput,
  type ScorecardQueryRow,
} from '@agent-bridge/shared'
import { scorecardsRepo } from '@agent-bridge/db'
import { runScorecard, ScorecardError } from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

const paramSchema = z.object({ agentId: z.uuid() })

type ScorecardQueryDbRow = Awaited<
  ReturnType<typeof scorecardsRepo.listQueries>
>[number]

function toQueryDto(row: ScorecardQueryDbRow): ScorecardQueryRow {
  return {
    id: row.id,
    query: row.query,
    expectedSnippets: row.expectedSnippets ?? [],
    expectedPage: row.expectedPage ?? null,
    note: row.note,
    position: row.position,
  }
}

/** Normalize a validated DTO input into the repo's insert shape (fill
 *  the optional/defaulted fields the schema leaves loose). */
function toRepoInput(q: ScorecardQueryInput) {
  return {
    query: q.query,
    expectedSnippets: q.expectedSnippets ?? [],
    expectedPage: q.expectedPage ?? null,
    note: q.note ?? '',
  }
}

export const agentScorecardRouter = new Hono()
  .get(
    '/queries',
    zValidator('param', paramSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const rows = await scorecardsRepo.listQueries(getDb(), agentId)
      return c.json({ ok: true as const, queries: rows.map(toQueryDto) })
    },
  )
  .put(
    '/queries',
    zValidator('param', paramSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', scorecardQueriesSaveInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { queries } = c.req.valid('json')
      const rows = await scorecardsRepo.replaceQueries(
        getDb(),
        agentId,
        queries.map(toRepoInput),
      )
      return c.json({ ok: true as const, queries: rows.map(toQueryDto) })
    },
  )
  .post(
    '/run',
    zValidator('param', paramSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', scorecardRunInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const db = getDb()

      // Ad-hoc queries from the live editor take precedence; otherwise
      // fall back to the saved golden set.
      let queries: ScorecardQueryInput[]
      if (body.queries && body.queries.length > 0) {
        queries = body.queries
      } else {
        const saved = await scorecardsRepo.listQueries(db, agentId)
        queries = saved.map((r) => ({
          query: r.query,
          expectedSnippets: r.expectedSnippets ?? [],
          expectedPage: r.expectedPage ?? null,
          note: r.note,
        }))
      }

      try {
        const result = await runScorecard({
          db,
          agentId,
          strategyIds: body.strategyIds,
          topK: body.topK,
          queries,
        })
        return c.json({ ok: true as const, ...result })
      } catch (err) {
        if (err instanceof ScorecardError) {
          return httpError(c, {
            code: err.code === 'no_queries' ? 'validation_failed' : 'conflict',
            message: err.message,
          })
        }
        throw err
      }
    },
  )

export type AgentScorecardRouter = typeof agentScorecardRouter
