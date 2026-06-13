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
  scorecardStreamId,
  type ScorecardQueryInput,
  type ScorecardQueryRow,
  type ScorecardRunProgressPayload,
  type ScorecardRunRecord,
  type ScorecardStrategyAggregate,
  type ScorecardStrategyId,
} from '@agent-bridge/shared'
import { scorecardsRepo } from '@agent-bridge/db'
import { runScorecard, ScorecardError } from '@agent-bridge/agents'
import { getDb } from '../db.js'
import { env } from '../env.js'
import { getEventBus } from '../event-bus.js'
import { httpError, httpValidationError } from '../lib/errors.js'

const paramSchema = z.object({ agentId: z.uuid() })
const baselineParamSchema = z.object({ agentId: z.uuid(), runId: z.uuid() })

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

type ScorecardRunDbRow = Awaited<ReturnType<typeof scorecardsRepo.insertRun>>

function toRunDto(row: ScorecardRunDbRow): ScorecardRunRecord {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: row.label,
    isBaseline: row.isBaseline,
    topK: row.topK,
    queryCount: row.queryCount,
    judgedCount: row.judgedCount,
    embeddingModel: row.embeddingModel,
    durationMs: row.durationMs,
    strategyIds: (row.strategyIds ?? []) as ScorecardStrategyId[],
    aggregates: (row.aggregates ?? []) as ScorecardStrategyAggregate[],
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
        // Per-query progress on `scorecard:<agentId>` so the Scorecard
        // tab can show a live bar (the rerank strategy costs one LLM
        // call per query; full runs take minutes). Publish failures
        // must not fail the run.
        const bus = getEventBus()
        const result = await runScorecard({
          db,
          agentId,
          strategyIds: body.strategyIds,
          topK: body.topK,
          queries,
          concurrency: env.SCORECARD_CONCURRENCY,
          onQueryDone: async (done, total) => {
            try {
              await bus.publish({
                kind: 'scorecard.run.progress',
                ts: Date.now(),
                streamId: scorecardStreamId(agentId),
                data: {
                  agentId,
                  queriesDone: done,
                  queriesTotal: total,
                } satisfies ScorecardRunProgressPayload,
              })
            } catch (err) {
              console.warn('[scorecard] progress publish failed:', err)
            }
          },
        })
        // Persist the run's scores so later runs can show a before/after
        // delta, then resolve what to compare against (pinned baseline, else
        // the previous run; null on the first run).
        const run = await scorecardsRepo.insertRun(db, {
          agentId,
          topK: result.topK,
          queryCount: result.queryCount,
          judgedCount: result.judgedCount,
          embeddingModel: result.embeddingModel,
          durationMs: result.durationMs,
          strategyIds: body.strategyIds,
          aggregates: result.aggregates,
        })
        const comparison = await scorecardsRepo.getComparisonRun(
          db,
          agentId,
          run.id,
        )
        return c.json({
          ok: true as const,
          ...result,
          runId: run.id,
          baseline: comparison ? toRunDto(comparison) : null,
        })
      } catch (err) {
        if (err instanceof ScorecardError) {
          return httpError(c, {
            code: err.code === 'no_queries' ? 'validation_failed' : 'conflict',
            // A dead rerank provider is an upstream outage; 503 marks
            // it retryable. The envelope keeps `conflict` because the
            // ErrorCode enum has no "unavailable" member and the UI
            // only renders the message.
            ...(err.code === 'rerank_unavailable' ? { status: 503 } : {}),
            message: err.message,
          })
        }
        throw err
      }
    },
  )
  .post(
    '/runs/:runId/baseline',
    zValidator('param', baselineParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, runId } = c.req.valid('param')
      await scorecardsRepo.setBaseline(getDb(), agentId, runId)
      return c.json({ ok: true as const })
    },
  )

export type AgentScorecardRouter = typeof agentScorecardRouter
