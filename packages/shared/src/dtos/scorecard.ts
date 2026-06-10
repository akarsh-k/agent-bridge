/**
 * Retrieval Scorecard DTOs.
 *
 * The scorecard runs the agent's attached knowledge files through the
 * SAME retrieval primitives `search_knowledge` uses (vector + BM25 +
 * RRF + LLM rerank), under a few selectable STRATEGIES, and scores the
 * results against an operator-authored golden set (query → expected
 * answer snippets). Lets the operator measure "did a retrieval change
 * actually help?" instead of guessing.
 *
 * Relevance is judged by substring match: a retrieved chunk is "relevant"
 * when its text contains any of the query's `expectedSnippets` (or, when
 * none are given, when its page matches `expectedPage`). This is the
 * pragmatic, hand-authorable ground-truth model — no per-chunk labelling.
 */

import { z } from 'zod'

// ─── Strategy presets ──────────────────────────────────────────────────────
// The engine knows how to run each of these. Kept as a closed set for v1;
// future presets (HyDE, weighted fusion, dedicated reranker) slot in here.

export const scorecardStrategyIds = [
  'vector',
  'bm25',
  'rrf',
  'rrf_rerank',
] as const
export type ScorecardStrategyId = (typeof scorecardStrategyIds)[number]

export const scorecardStrategyMeta: Record<
  ScorecardStrategyId,
  { label: string; blurb: string }
> = {
  vector: {
    label: 'Semantic only',
    blurb:
      'Vector similarity (pgvector cosine). Meaning-based, ignores keywords.',
  },
  bm25: {
    label: 'Keyword only',
    blurb: 'Postgres full-text BM25. Exact terms, numbers, proper nouns.',
  },
  rrf: {
    label: 'Hybrid (RRF)',
    blurb: 'Semantic + keyword fused with Reciprocal Rank Fusion. No rerank.',
  },
  rrf_rerank: {
    label: 'Hybrid + rerank',
    blurb: 'Current production: RRF candidates reordered by the LLM-as-judge.',
  },
}

// ─── Query authoring (the golden set) ───────────────────────────────────────

export const scorecardQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  /** Answer-bearing text the right chunk should contain. A retrieved
   *  chunk counts as relevant if it contains ANY of these (case- and
   *  whitespace-insensitive). Multiple lets you accept paraphrases. */
  expectedSnippets: z
    .array(z.string().trim().min(1).max(500))
    .max(10)
    .default([]),
  /** Optional page-number fallback used only when `expectedSnippets`
   *  is empty (handy for PDFs where you know the page, not the wording). */
  expectedPage: z.number().int().min(1).max(100_000).nullable().optional(),
  /** Operator note — why this question matters / what it probes. */
  note: z.string().trim().max(500).default(''),
})
export type ScorecardQueryInput = z.infer<typeof scorecardQueryInputSchema>

export const scorecardQueryRowSchema = scorecardQueryInputSchema.extend({
  id: z.uuid(),
  position: z.number().int(),
})
export type ScorecardQueryRow = z.infer<typeof scorecardQueryRowSchema>

export const scorecardQueriesSaveInputSchema = z.object({
  queries: z.array(scorecardQueryInputSchema).max(200),
})
export type ScorecardQueriesSaveInput = z.infer<
  typeof scorecardQueriesSaveInputSchema
>

export const scorecardQueriesResponseSchema = z.object({
  ok: z.literal(true),
  queries: z.array(scorecardQueryRowSchema),
})
export type ScorecardQueriesResponse = z.infer<
  typeof scorecardQueriesResponseSchema
>

// ─── Run request ────────────────────────────────────────────────────────────

export const scorecardRunInputSchema = z.object({
  strategyIds: z
    .array(z.enum(scorecardStrategyIds))
    .min(1)
    .default([...scorecardStrategyIds]),
  topK: z.number().int().min(1).max(20).default(5),
  /** Optional ad-hoc queries to run WITHOUT saving (live editor "Run"
   *  before the operator commits the set). Falls back to the saved set
   *  when omitted. */
  queries: z.array(scorecardQueryInputSchema).max(200).optional(),
})
export type ScorecardRunInput = z.infer<typeof scorecardRunInputSchema>

// ─── Run result ─────────────────────────────────────────────────────────────

export const scorecardHitSchema = z.object({
  fileName: z.string(),
  page: z.number().nullable(),
  section: z.string().nullable(),
  snippet: z.string(),
  relevant: z.boolean(),
})
export type ScorecardHit = z.infer<typeof scorecardHitSchema>

export const scorecardQueryStrategyResultSchema = z.object({
  strategyId: z.enum(scorecardStrategyIds),
  /** At least one relevant chunk landed in the top-K. */
  hit: z.boolean(),
  /** 1-based rank of the first relevant chunk, or null if none. */
  firstRelevantRank: z.number().nullable(),
  reciprocalRank: z.number(),
  ndcg: z.number(),
  precision: z.number(),
  hits: z.array(scorecardHitSchema),
})
export type ScorecardQueryStrategyResult = z.infer<
  typeof scorecardQueryStrategyResultSchema
>

export const scorecardQueryResultSchema = z.object({
  query: z.string(),
  expectedSnippets: z.array(z.string()),
  /** False when the query has no ground truth (no snippets/page); such
   *  queries are shown but excluded from the aggregates. */
  judged: z.boolean(),
  byStrategy: z.array(scorecardQueryStrategyResultSchema),
})
export type ScorecardQueryResult = z.infer<typeof scorecardQueryResultSchema>

export const scorecardStrategyAggregateSchema = z.object({
  strategyId: z.enum(scorecardStrategyIds),
  label: z.string(),
  /** Mean hit@k across judged queries (a.k.a. recall for single-answer). */
  hitRate: z.number(),
  /** Mean coverage: average fraction of a question's expected snippets that
   *  some retrieved chunk surfaced, treating each snippet as a distinct
   *  required piece. Measures completeness for multi-hop (multi-snippet)
   *  questions; equals hitRate for single-snippet ones. */
  coverage: z.number(),
  /** Mean reciprocal rank. */
  mrr: z.number(),
  /** Mean nDCG@k (binary relevance). */
  ndcg: z.number(),
  /** Mean fraction of the top-K that was relevant. */
  precision: z.number(),
})
export type ScorecardStrategyAggregate = z.infer<
  typeof scorecardStrategyAggregateSchema
>

export const scorecardRunResultSchema = z.object({
  ok: z.literal(true),
  topK: z.number(),
  fileCount: z.number(),
  queryCount: z.number(),
  judgedCount: z.number(),
  embeddingModel: z.string(),
  durationMs: z.number(),
  aggregates: z.array(scorecardStrategyAggregateSchema),
  perQuery: z.array(scorecardQueryResultSchema),
})
export type ScorecardRunResult = z.infer<typeof scorecardRunResultSchema>

// ─── Saved runs + before/after comparison ───────────────────────────────────

/** A persisted run: aggregate scores only (no per-question detail), used to
 *  compare a new run against a baseline. */
export const scorecardRunRecordSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  label: z.string(),
  isBaseline: z.boolean(),
  topK: z.number(),
  queryCount: z.number(),
  judgedCount: z.number(),
  embeddingModel: z.string(),
  durationMs: z.number(),
  strategyIds: z.array(z.enum(scorecardStrategyIds)),
  aggregates: z.array(scorecardStrategyAggregateSchema),
})
export type ScorecardRunRecord = z.infer<typeof scorecardRunRecordSchema>

/** The run response: the full result plus the persisted run id and the run to
 *  compare against (pinned baseline, else the previous run; null on first run). */
export const scorecardRunResponseSchema = scorecardRunResultSchema.extend({
  runId: z.uuid(),
  baseline: scorecardRunRecordSchema.nullable(),
})
export type ScorecardRunResponse = z.infer<typeof scorecardRunResponseSchema>
