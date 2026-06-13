/**
 * Retrieval Scorecard engine.
 *
 * Runs an agent's attached knowledge files through the SAME retrieval
 * primitives `search_knowledge` uses, under several selectable
 * strategies, and scores each against an operator-authored golden set.
 * This is the measurement layer that turns "a retrieval change feels
 * better" into "hit-rate went 0.62 → 0.81 on our own questions".
 *
 * Strategies (see `scorecardStrategyMeta` in the shared DTO):
 *   - vector      : pgvector cosine only
 *   - bm25        : Postgres full-text only
 *   - rrf         : both, fused via RRF (no rerank)
 *   - rrf_rerank  : production path — RRF → per-file diversity cap →
 *                   `buildRerankPool` → LLM-as-judge rerank
 *
 * Faithfulness: vector/BM25/RRF/rerank are the exact functions the
 * production tool calls (imported, not re-implemented), so the
 * scorecard measures the real pipeline, not an approximation.
 *
 * Relevance is judged by substring match against `expectedSnippets`
 * (case/whitespace-insensitive), with an `expectedPage` fallback. A
 * query with no ground truth is reported but excluded from aggregates.
 * `coverage` additionally treats each snippet as a distinct required
 * piece (the fraction of them retrieval surfaced): for a multi-snippet /
 * multi-hop question it measures completeness; for a single-snippet one
 * it equals hit-rate.
 */

import type { MastraModelConfig } from '@mastra/core/llm'

import { schema, type AgentBridgeDb } from '@agent-bridge/db'
import { and, asc, eq } from 'drizzle-orm'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  scorecardStrategyMeta,
  type ScorecardQueryInput,
  type ScorecardRunResult,
  type ScorecardStrategyId,
  type ScorecardQueryStrategyResult,
} from '@agent-bridge/shared'

import { resolveBaseUrl } from './build-agent.js'
import {
  buildEmbedder,
  buildRerankerAgent,
  buildRerankPool,
  embeddingFingerprint,
  PER_FILE_DIVERSITY_CAP,
  rerankWithLlm,
  retryOnRateLimit,
  rrfFuse,
  runBm25Search,
  runVectorSearch,
  type ChunkHit,
  type FusedChunk,
  type RetryPolicy,
} from './knowledge-tool.js'

/** Rate-limit retries per provider call (embed + rerank) under parallel
 *  fan-out: enough to ride out a throttling burst, few enough that a
 *  dead provider still trips the breaker promptly. */
const RATE_LIMIT_RETRIES = 4

function rerankUnavailable(failures: number): ScorecardError {
  return new ScorecardError(
    'rerank_unavailable',
    `The rerank model failed ${failures} times during this run, so the ` +
      '"Hybrid + rerank" numbers would not be trustworthy. Check the chat ' +
      'provider, or deselect that strategy and run again.',
  )
}

export class ScorecardError extends Error {
  readonly code:
    | 'no_embedding_provider'
    | 'no_files'
    | 'no_queries'
    | 'rerank_unavailable'
  constructor(code: ScorecardError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'ScorecardError'
  }
}

export interface RunScorecardInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  readonly strategyIds: ReadonlyArray<ScorecardStrategyId>
  readonly topK: number
  readonly queries: ReadonlyArray<ScorecardQueryInput>
  /** Max queries processed concurrently. Each in-flight query holds ~2
   *  DB connections (vector + BM25) and fires one embed + one rerank
   *  call, so a high value needs a matching `DATABASE_POOL_SIZE` and a
   *  tolerant provider tier. Defaults to 1 (sequential). */
  readonly concurrency?: number
  /** Called after each query finishes all strategies; drives the
   *  Scorecard tab's progress bar. `done` is monotonic but increments in
   *  finish order under concurrency > 1. */
  readonly onQueryDone?: (done: number, total: number) => Promise<void> | void
}

/**
 * Run `worker` over `[0, count)` with at most `limit` in flight, pulling
 * the next index per runner until drained. On the first worker error it
 * stops scheduling and rethrows that error, so a tripped breaker or
 * failed embed aborts the run promptly.
 */
async function mapWithConcurrency(
  count: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let aborted = false
  let firstError: unknown
  const runnerCount = Math.max(1, Math.min(limit, count))
  const runner = async (): Promise<void> => {
    while (!aborted) {
      const index = next++
      if (index >= count) return
      try {
        await worker(index)
      } catch (err) {
        aborted = true
        firstError = err
        return
      }
    }
  }
  await Promise.all(Array.from({ length: runnerCount }, () => runner()))
  if (aborted) throw firstError
}

/**
 * Run the scorecard end to end. Resolves the agent's embedding/chat
 * providers and attached-file scope internally so the HTTP route stays
 * thin. Throws `ScorecardError` for the operator-actionable failures
 * (no embedder, no files, no questions).
 */
export async function runScorecard(
  input: RunScorecardInput,
): Promise<Omit<ScorecardRunResult, 'ok'>> {
  const { db, agentId, strategyIds, topK, queries, onQueryDone } = input
  const concurrency = Math.max(1, input.concurrency ?? 1)
  const startedAt = Date.now()

  if (queries.length === 0) {
    throw new ScorecardError('no_queries', 'No test questions to run.')
  }

  // ── Embedding provider (singleton) → query embedder + fingerprint ──
  const [embedProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'embedding'))
    .limit(1)
  if (!embedProvider || !embedProvider.defaultModel) {
    throw new ScorecardError(
      'no_embedding_provider',
      'No workspace embedding provider configured. Add one in Library → Providers (role: embedding).',
    )
  }
  const embedder = buildEmbedder(embedProvider)
  const fingerprint = embeddingFingerprint(embedProvider)

  // ── Scope = the agent's `ready` attached files ──
  const fileRows = await db.db
    .select({ id: schema.files.id, name: schema.files.name })
    .from(schema.agentFiles)
    .innerJoin(schema.files, eq(schema.agentFiles.fileId, schema.files.id))
    .where(
      and(
        eq(schema.agentFiles.agentId, agentId),
        eq(schema.files.ingestStatus, 'ready'),
      ),
    )
    .orderBy(asc(schema.agentFiles.position), asc(schema.agentFiles.createdAt))
  if (fileRows.length === 0) {
    throw new ScorecardError(
      'no_files',
      'This agent has no ready knowledge files attached. Attach a document in Resources first.',
    )
  }
  const scope = fileRows.map((f) => f.id)
  const nameById = new Map(fileRows.map((f) => [f.id, f.name]))

  // ── Chat model for the reranker strategy (optional) ──
  const rerankNeeded = strategyIds.includes('rrf_rerank')
  let rerankerAgent: ReturnType<typeof buildRerankerAgent> | null = null
  if (rerankNeeded) {
    const [agentRow] = await db.db
      .select({ llmProviderId: schema.agents.llmProviderId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1)
    if (agentRow?.llmProviderId) {
      const [chatProvider] = await db.db
        .select()
        .from(schema.llmProviders)
        .where(eq(schema.llmProviders.id, agentRow.llmProviderId))
        .limit(1)
      if (chatProvider?.defaultModel) {
        const modelConfig: MastraModelConfig = {
          providerId: chatProvider.kind,
          modelId: chatProvider.defaultModel,
          url: resolveBaseUrl(chatProvider.kind, chatProvider.baseUrl),
          ...(chatProvider.apiKeyEnvelope
            ? { apiKey: decryptSecret(chatProvider.apiKeyEnvelope) }
            : {}),
        }
        rerankerAgent = buildRerankerAgent(modelConfig)
      }
    }
  }

  // ── Per-query retrieval + scoring ──
  // Vector + BM25 are computed ONCE per query and shared across
  // strategies (embedding is the expensive part; don't pay it 4×).
  // Written by index (not push) so output order is deterministic even
  // when queries finish out of order under concurrency > 1.
  const perQuery: ScorecardRunResult['perQuery'] = new Array(queries.length)
  // strategyId → running sums over judged queries, for the aggregates.
  const acc = new Map<
    ScorecardStrategyId,
    {
      hit: number
      rr: number
      ndcg: number
      prec: number
      cov: number
      n: number
    }
  >()
  for (const id of strategyIds) {
    acc.set(id, { hit: 0, rr: 0, ndcg: 0, prec: 0, cov: 0, n: 0 })
  }

  // Rerank circuit breaker. A down provider fails identically on every
  // query; without this a 59-question run attempts (and logs) 59
  // doomed LLM calls. The run FAILS rather than degrading: silently
  // recording RRF-order results under the "Hybrid + rerank" label
  // would poison every baseline comparison. Backoff (below) absorbs
  // transient 429s first, so a tripped breaker means a real outage.
  // Counters are shared across workers but safe: Node never preempts
  // mid-statement, so `+= 1` can't interleave.
  let rerankFailures = 0
  let rerankAttempts = 0
  const RERANK_BREAKER_LIMIT = 3
  const retryPolicy: RetryPolicy = { retries: RATE_LIMIT_RETRIES }
  // Progress counter; increments in finish order under concurrency > 1.
  let completed = 0

  const processQuery = async (index: number): Promise<void> => {
    const q = queries[index]!
    const gold = {
      snippets: q.expectedSnippets ?? [],
      page: q.expectedPage ?? null,
    }
    const judged = gold.snippets.length > 0 || gold.page !== null

    let queryVector: ReadonlyArray<number> | undefined
    try {
      const embed = await retryOnRateLimit(
        () => embedder.doEmbed({ values: [q.query] }),
        retryPolicy,
      )
      queryVector = embed.embeddings[0]
    } catch (err) {
      // Surface a transient embedder failure as a clear error rather than
      // a 500 or N confusing all-zero rows.
      throw new ScorecardError(
        'no_embedding_provider',
        `Failed to embed a query against the workspace embedding provider: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    let vectorHits: ChunkHit[] = []
    let bm25Hits: ChunkHit[] = []
    if (queryVector) {
      ;[vectorHits, bm25Hits] = await Promise.all([
        runVectorSearch({ db, scope, fingerprint, queryVector }),
        runBm25Search({ db, scope, fingerprint, query: q.query }),
      ])
    } else {
      bm25Hits = await runBm25Search({ db, scope, fingerprint, query: q.query })
    }

    const byStrategy: ScorecardQueryStrategyResult[] = []
    for (const strategyId of strategyIds) {
      const ranked = await rankForStrategy({
        strategyId,
        topK,
        vectorHits,
        bm25Hits,
        query: q.query,
        rerankerAgent,
        onRerankAttempt: () => {
          rerankAttempts += 1
        },
        onRerankFailure: () => {
          rerankFailures += 1
        },
        rerankRetry: retryPolicy,
        // Match production: no per-file cap for a single-file scope, else
        // the candidate pool caps at 3 and the reranker never runs.
        perFileCap: scope.length === 1 ? Infinity : PER_FILE_DIVERSITY_CAP,
      })
      const flags = ranked.map((c) => judge(c.text, c.page, gold))
      const metrics = scoreRanked(flags, ranked.length)
      const cov = coverageOf(ranked, gold)
      byStrategy.push({
        strategyId,
        hit: metrics.hit,
        firstRelevantRank: metrics.firstRelevantRank,
        reciprocalRank: metrics.rr,
        ndcg: metrics.ndcg,
        precision: metrics.prec,
        hits: ranked.map((c, i) => ({
          fileName: nameById.get(c.fileId) ?? '',
          page: c.page,
          section: c.sectionPath,
          snippet: snippet(c.text),
          relevant: flags[i] ?? false,
        })),
      })
      if (judged) {
        const a = acc.get(strategyId)!
        a.hit += metrics.hit ? 1 : 0
        a.rr += metrics.rr
        a.ndcg += metrics.ndcg
        a.prec += metrics.prec
        a.cov += cov
        a.n += 1
      }
    }

    perQuery[index] = {
      query: q.query,
      expectedSnippets: gold.snippets,
      judged,
      byStrategy,
    }
    if (rerankFailures >= RERANK_BREAKER_LIMIT) {
      throw rerankUnavailable(rerankFailures)
    }
    completed += 1
    if (onQueryDone) await onQueryDone(completed, queries.length)
  }

  await mapWithConcurrency(queries.length, concurrency, processQuery)

  // Small-run floor: a 1-2 question run can fail every rerank without
  // reaching the in-loop limit; all-attempts-failed is just as
  // untrustworthy. Compared against attempts, not query count, since
  // rerank is skipped for queries with 3 or fewer candidates.
  if (rerankFailures > 0 && rerankFailures >= rerankAttempts) {
    throw rerankUnavailable(rerankFailures)
  }

  const aggregates = strategyIds.map((strategyId) => {
    const a = acc.get(strategyId)!
    const n = a.n || 1
    return {
      strategyId,
      label: scorecardStrategyMeta[strategyId].label,
      hitRate: a.n ? a.hit / n : 0,
      coverage: a.n ? a.cov / n : 0,
      mrr: a.n ? a.rr / n : 0,
      ndcg: a.n ? a.ndcg / n : 0,
      precision: a.n ? a.prec / n : 0,
    }
  })

  // Dense on the success path (any worker throw aborts the run before
  // here); `?.` guards against a future sparse-hole regression.
  const judgedCount = perQuery.filter((p) => p?.judged).length
  return {
    topK,
    fileCount: fileRows.length,
    queryCount: queries.length,
    judgedCount,
    embeddingModel: fingerprint,
    durationMs: Date.now() - startedAt,
    aggregates,
    perQuery,
  }
}

// ─── Strategy composition ───────────────────────────────────────────────────

async function rankForStrategy(args: {
  strategyId: ScorecardStrategyId
  topK: number
  vectorHits: ReadonlyArray<ChunkHit>
  bm25Hits: ReadonlyArray<ChunkHit>
  query: string
  rerankerAgent: ReturnType<typeof buildRerankerAgent> | null
  onRerankAttempt?: () => void
  onRerankFailure?: (err: unknown) => void
  rerankRetry?: RetryPolicy
  perFileCap: number
}): Promise<ChunkHit[]> {
  const {
    strategyId,
    topK,
    vectorHits,
    bm25Hits,
    query,
    rerankerAgent,
    onRerankAttempt,
    onRerankFailure,
    rerankRetry,
    perFileCap,
  } = args
  switch (strategyId) {
    case 'vector':
      return vectorHits.slice(0, topK)
    case 'bm25':
      return bm25Hits.slice(0, topK)
    case 'rrf':
      return rrfFuse(vectorHits, bm25Hits).slice(0, topK)
    case 'rrf_rerank': {
      const fused = rrfFuse(vectorHits, bm25Hits)
      const diverse = diversify(fused, perFileCap)
      const candidates = buildRerankPool(diverse, bm25Hits)
      let ordered: ReadonlyArray<FusedChunk> = candidates
      if (rerankerAgent && candidates.length > 3) {
        if (onRerankAttempt) onRerankAttempt()
        ordered = await rerankWithLlm({
          rerankerAgent,
          query,
          candidates,
          onFailure: onRerankFailure,
          retry: rerankRetry,
        })
      }
      return ordered.slice(0, topK)
    }
  }
}

/** Per-file diversity cap so one long doc can't dominate the candidate
 *  pool. Pass Infinity to disable (e.g. a single-file scope). */
function diversify(
  fused: ReadonlyArray<FusedChunk>,
  perFileCap: number,
): FusedChunk[] {
  const seen = new Map<string, number>()
  const out: FusedChunk[] = []
  for (const c of fused) {
    const n = seen.get(c.fileId) ?? 0
    if (n >= perFileCap) continue
    seen.set(c.fileId, n + 1)
    out.push(c)
  }
  return out
}

// ─── Relevance + metrics ────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** A chunk is relevant if its text contains any gold snippet (normalized
 *  substring), or — when no snippets are given — if its page matches. */
function judge(
  text: string,
  page: number | null,
  gold: { snippets: ReadonlyArray<string>; page: number | null },
): boolean {
  if (gold.snippets.length > 0) {
    const t = normalize(text)
    return gold.snippets.some((s) => t.includes(normalize(s)))
  }
  if (gold.page !== null && page !== null) return page === gold.page
  return false
}

/** Fraction of the gold snippets that at least one ranked chunk contains,
 *  treating each snippet as a distinct required piece. Equals hit (0 or 1)
 *  for a single-snippet query; drops below hit-rate only when a
 *  multi-snippet (multi-hop) query is partially covered. Falls back to the
 *  page check when no snippets are given. */
function coverageOf(
  ranked: ReadonlyArray<ChunkHit>,
  gold: { snippets: ReadonlyArray<string>; page: number | null },
): number {
  if (gold.snippets.length > 0) {
    const texts = ranked.map((c) => normalize(c.text))
    let covered = 0
    for (const s of gold.snippets) {
      const ns = normalize(s)
      if (texts.some((t) => t.includes(ns))) covered += 1
    }
    return covered / gold.snippets.length
  }
  if (gold.page !== null) {
    return ranked.some((c) => c.page === gold.page) ? 1 : 0
  }
  return 0
}

function scoreRanked(
  flags: ReadonlyArray<boolean>,
  size: number,
): {
  hit: boolean
  firstRelevantRank: number | null
  rr: number
  ndcg: number
  prec: number
} {
  const firstIdx = flags.findIndex((f) => f)
  const firstRelevantRank = firstIdx === -1 ? null : firstIdx + 1
  const rr = firstRelevantRank ? 1 / firstRelevantRank : 0
  // Binary-relevance DCG/IDCG over the returned list.
  const dcg = flags.reduce(
    (sum, rel, i) => sum + (rel ? 1 / Math.log2(i + 2) : 0),
    0,
  )
  const relevantCount = flags.filter(Boolean).length
  const idcg = Array.from(
    { length: relevantCount },
    (_, i) => 1 / Math.log2(i + 2),
  ).reduce((a, b) => a + b, 0)
  const ndcg = idcg > 0 ? dcg / idcg : 0
  const prec = size > 0 ? relevantCount / size : 0
  return { hit: firstRelevantRank !== null, firstRelevantRank, rr, ndcg, prec }
}

function snippet(text: string, limit = 320): string {
  if (text.length <= limit) return text
  const slice = text.slice(0, limit)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice) + '…'
}
