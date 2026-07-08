/**
 * Scratch eval harness — measures the retrieval scorecard for a fixed
 * agent against the DEV database, printing per-strategy aggregates AND
 * the oracle ceiling so we can tell a recall miss from a ranking loss.
 *
 * Does NOT touch the golden set; read-only except for the run row that
 * runScorecard itself never inserts (we call the engine directly).
 *
 *   AGENT_ID=... pnpm --filter @agent-bridge/tests exec tsx eval-scorecard.ts
 */

/* eslint-disable no-console */

import { createDb } from '@agent-bridge/db'
import { runScorecard } from '@agent-bridge/agents'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import type { ScorecardStrategyId } from '@agent-bridge/shared'

loadRootDotenv(import.meta.url, { depth: 1 })

const AGENT_ID =
  process.env['AGENT_ID'] ?? '16138636-8ff7-4525-8be3-b131f3cba3f4'
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const TOP_K = Number(process.env['TOP_K'] ?? 5)
const STRATEGIES = (
  process.env['STRATEGIES']?.split(',') as ScorecardStrategyId[] | undefined
) ?? (['vector', 'bm25', 'rrf', 'rrf_rerank'] as ScorecardStrategyId[])
const CONCURRENCY = Number(process.env['CONCURRENCY'] ?? 6)

const db = createDb({ connectionString: DB_URL, maxConnections: 12 })

try {
  const rows = await db.pool.query<{
    query: string
    expected_snippets: string[] | null
    expected_page: number | null
    note: string | null
  }>(
    `SELECT query, expected_snippets, expected_page, note
       FROM scorecard_queries WHERE agent_id = $1 ORDER BY position ASC`,
    [AGENT_ID],
  )
  let queries = rows.rows.map((r) => ({
    query: r.query,
    expectedSnippets: r.expected_snippets ?? [],
    expectedPage: r.expected_page ?? null,
    note: r.note ?? '',
  }))
  // QUERY_SUBSTR=foo|bar restricts to queries whose text matches any
  // pipe-separated needle (case-insensitive); LIMIT_Q caps the count.
  // Both are for fast iteration on the slow rerank path; full runs omit them.
  const subs = process.env['QUERY_SUBSTR']
  if (subs) {
    const needles = subs.toLowerCase().split('|')
    queries = queries.filter((q) =>
      needles.some((n) => q.query.toLowerCase().includes(n)),
    )
  }
  const limitQ = process.env['LIMIT_Q']
  if (limitQ) queries = queries.slice(0, Number(limitQ))
  console.log(
    `▸ agent=${AGENT_ID.slice(0, 8)} queries=${queries.length} topK=${TOP_K} strategies=${STRATEGIES.join(',')}`,
  )

  const started = Date.now()
  const result = await runScorecard({
    db,
    agentId: AGENT_ID,
    strategyIds: STRATEGIES,
    topK: TOP_K,
    queries,
    concurrency: CONCURRENCY,
  })

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const f3 = (n: number) => n.toFixed(3)
  console.log('')
  console.log(
    'Strategy'.padEnd(18) +
      'Hit'.padEnd(9) +
      'Cov'.padEnd(9) +
      'MRR'.padEnd(8) +
      'nDCG'.padEnd(8) +
      'Prec',
  )
  console.log('─'.repeat(58))
  for (const a of result.aggregates) {
    console.log(
      a.label.padEnd(18) +
        pct(a.hitRate).padEnd(9) +
        pct(a.coverage).padEnd(9) +
        f3(a.mrr).padEnd(8) +
        f3(a.ndcg).padEnd(8) +
        pct(a.precision),
    )
  }
  console.log('')
  console.log('Oracle (gold present ANYWHERE in an arm\'s full retrieved list):')
  console.log(`  vector arm : ${pct(result.oracle.vectorHitRate)}`)
  console.log(`  bm25 arm   : ${pct(result.oracle.bm25HitRate)}`)
  console.log(`  union      : ${pct(result.oracle.unionHitRate)}  ← recall ceiling`)
  console.log(`  union cov  : ${pct(result.oracle.unionCoverage)}`)
  console.log('')
  console.log(
    `judged=${result.judgedCount}/${result.queryCount} files=${result.fileCount} embed=${result.embeddingModel} (${Date.now() - started}ms)`,
  )

  // Per-query miss diagnostics for the reranked path: for each query the
  // rerank missed, show whether RRF had the gold in top-5 (so rerank
  // DEMOTED it) or also missed it (pool/recall limited). Drives the next
  // tuning decision without a second LLM run.
  if (STRATEGIES.includes('rrf_rerank')) {
    const rankOf = (
      pq: (typeof result.perQuery)[number],
      sid: string,
    ): number | null =>
      pq.byStrategy.find((b) => b.strategyId === sid)?.firstRelevantRank ?? null
    const misses = result.perQuery.filter(
      (pq) => pq?.judged && rankOf(pq, 'rrf_rerank') === null,
    )
    console.log(`\nrrf_rerank MISSES (${misses.length}):`)
    for (const pq of misses) {
      const rrf = rankOf(pq, 'rrf')
      const tag = rrf && rrf <= 5 ? `DEMOTED (rrf@${rrf})` : `rrf@${rrf ?? 'miss'}`
      console.log(`  [${tag}] ${pq.query}`)
    }
  }
} finally {
  await db.close()
}
