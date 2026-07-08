/**
 * Knowledge tool retrieval smoke. Drives the pure-function pieces of
 * `search_knowledge` over synthetic inputs and asserts:
 *
 *   1. `rrfFuse` returns chunks in best-first order, k=60 constant,
 *      vector arm at weight 1 and BM25 at `RRF_BM25_WEIGHT`.
 *   2. A chunk appearing in both vector + BM25 lists scores higher
 *      than chunks appearing in only one (the whole point of RRF).
 *   3. Empty inputs → empty output (no NaN, no crash).
 *   4. `buildRerankPool`: top-cap slice, BM25 rescue slots (a
 *      fusion-starved keyword hit still reaches the reranker), dedupe,
 *      diversity-cut respect, and the CAP + SLOTS ceiling.
 *   5. `rerankWithLlm` against a stub agent: pointwise 0-10 scoring sorts
 *      highest-rated first (RRF tiebreak), unrated/unparseable input falls
 *      back to RRF order, batches a wide pool and merges, and fires
 *      `onFailure` once when every batch fails.
 *   6. `parseRelevanceScores` reads "<n>: <score>" pairs (0-10), tolerates
 *      brackets/separators, defaults unrated to 0, and rejects
 *      out-of-range scores.
 *   7. `buildSearchKnowledgeTool` returns null when no attached files
 *      OR no embedding provider, and a Tool with id `search_knowledge`
 *      when both are present.
 *   8. Page-aware PDF chunking: `stripPdfChrome` emits page offsets and
 *      `chunkDocument` stamps each chunk with its source page (null for
 *      non-PDF). Guards the "PDF chunks had no page" regression.
 *
 * Pure-function smoke — no DB, no LLM, no embedder. The end-to-end
 * SQL + embedding path needs a real test workspace + real provider
 * and is verified manually in dev. Run in <1s.
 *
 *   pnpm -w run test:knowledge
 */

/* eslint-disable no-console */

import {
  buildRerankPool,
  buildSearchKnowledgeTool,
  chunkDocument,
  parseRelevanceScores,
  RERANK_BATCH_SIZE,
  RERANK_BM25_RESCUE_SLOTS,
  RERANK_CANDIDATE_CAP,
  rerankWithLlm,
  retryOnRateLimit,
  resolveBaseUrl,
  rrfFuse,
  RRF_BM25_WEIGHT,
  stripPdfChrome,
  type ChunkHit,
  type FusedChunk,
} from '@agent-bridge/agents'
import type { LlmProviderRow } from '@agent-bridge/db/schema'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(`${name}${diag ? ` — ${diag}` : ''}`)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

console.log('━'.repeat(60))
console.log(' Knowledge tool smoke')
console.log('━'.repeat(60))

// ── rrfFuse ────────────────────────────────────────────────────────────

function mkHit(id: string, overrides: Partial<ChunkHit> = {}): ChunkHit {
  return {
    id,
    fileId: 'file-a',
    parentId: null,
    chunkIndex: 0,
    page: null,
    sectionPath: null,
    text: `text for ${id}`,
    rawScore: 0,
    ...overrides,
  }
}

// Two ranked lists with one shared chunk. The shared chunk should
// win the fused ranking because it accumulates rank from both arms.
const vectorList: ChunkHit[] = [
  mkHit('shared'),   // vector rank 1
  mkHit('only-vec'), // vector rank 2
  mkHit('only-vec-2'), // rank 3
]
const bm25List: ChunkHit[] = [
  mkHit('only-bm25'), // bm25 rank 1
  mkHit('shared'),    // bm25 rank 2 — same chunk as vector rank 1
  mkHit('only-bm25-2'),
]

const fused = rrfFuse(vectorList, bm25List)
check(
  'rrfFuse produces a non-empty output',
  fused.length > 0,
  `${fused.length} chunks`,
)
check(
  'rrfFuse dedupes chunks across both lists',
  new Set(fused.map((c) => c.id)).size === fused.length,
  `unique ids`,
)
check(
  'shared chunk ranks first (appears in both lists)',
  fused[0]?.id === 'shared',
  `top=${fused[0]?.id}`,
)
const sharedScore = fused.find((c) => c.id === 'shared')?.score ?? 0
const onlyVecScore = fused.find((c) => c.id === 'only-vec')?.score ?? 0
const onlyBm25Score = fused.find((c) => c.id === 'only-bm25')?.score ?? 0
// Weighted RRF: vector arm at weight 1, BM25 down-weighted (rationale
// on `RRF_BM25_WEIGHT` in knowledge-tool.ts).
const expectedSharedScore = 1 / (60 + 1) + RRF_BM25_WEIGHT / (60 + 2)
const expectedOnlyVecScore = 1 / (60 + 2)
const expectedOnlyBm25Score = RRF_BM25_WEIGHT / (60 + 1)
check(
  'shared chunk score = weighted sum of both ranks (RRF k=60)',
  Math.abs(sharedScore - expectedSharedScore) < 1e-9,
  `got ${sharedScore.toFixed(6)}, expected ${expectedSharedScore.toFixed(6)}`,
)
check(
  'only-vector chunk score = single 1/(60+rank)',
  Math.abs(onlyVecScore - expectedOnlyVecScore) < 1e-9,
  `got ${onlyVecScore.toFixed(6)}`,
)
check(
  'only-bm25 chunk score = weighted 1/(60+rank)',
  Math.abs(onlyBm25Score - expectedOnlyBm25Score) < 1e-9,
  `got ${onlyBm25Score.toFixed(6)}`,
)
check(
  'fused output is sorted descending by score',
  fused.every((c, i) => i === 0 || (fused[i - 1]?.score ?? 0) >= c.score),
  'monotone non-increasing',
)
check(
  'rrfFuse on empty inputs returns empty array',
  rrfFuse([], []).length === 0,
  'no NaN, no crash',
)
check(
  'rrfFuse on one-sided input keeps the rank order',
  (() => {
    const out = rrfFuse(vectorList, [])
    return (
      out.length === vectorList.length &&
      out[0]?.id === 'shared' &&
      out[1]?.id === 'only-vec'
    )
  })(),
  'vector-only fusion preserves order',
)

// ── buildRerankPool ────────────────────────────────────────────────────

// The regression this guards: with the BM25 arm down-weighted, a
// keyword-only hit fuses below a vector arm that more than fills the
// pool, and would be sliced out of the rerank pool entirely. The rescue
// slots must pull it back in. Size the arm past the cap so the slice +
// rescue path is exercised regardless of the cap's value.
const vecArm: ChunkHit[] = Array.from(
  { length: RERANK_CANDIDATE_CAP + 8 },
  (_, i) => mkHit(`v${i}`),
)
const bmWithExclusive: ChunkHit[] = [mkHit('kw-hit'), mkHit('v0')]
const fusedStarved = rrfFuse(vecArm, bmWithExclusive)
const rescuePool = buildRerankPool(fusedStarved, bmWithExclusive)
check(
  'rescue slot pulls a fusion-starved bm25-only hit into the pool',
  rescuePool.some((c) => c.id === 'kw-hit'),
  `pool=${rescuePool.map((c) => c.id).join(',')}`,
)
check(
  'rescue appends instead of displacing the fused slice',
  rescuePool.length === RERANK_CANDIDATE_CAP + 1 &&
    rescuePool[RERANK_CANDIDATE_CAP]?.id === 'kw-hit',
  `len=${rescuePool.length}`,
)
check(
  'a bm25 hit already in the pool is not duplicated',
  rescuePool.filter((c) => c.id === 'v0').length === 1,
)

const bmTwoExclusive: ChunkHit[] = [mkHit('kw-a'), mkHit('kw-b')]
const poolCapped = buildRerankPool(
  rrfFuse(vecArm, bmTwoExclusive),
  bmTwoExclusive,
)
check(
  'pool caps at RERANK_CANDIDATE_CAP + RERANK_BM25_RESCUE_SLOTS',
  poolCapped.length === RERANK_CANDIDATE_CAP + RERANK_BM25_RESCUE_SLOTS &&
    poolCapped.some((c) => c.id === 'kw-a') &&
    poolCapped.some((c) => c.id === 'kw-b'),
  `len=${poolCapped.length}`,
)

check(
  'rescue respects the diversity cut (hit absent from fused list is skipped)',
  !buildRerankPool(
    fusedStarved.filter((c) => c.id !== 'kw-hit'),
    bmWithExclusive,
  ).some((c) => c.id === 'kw-hit'),
)

const bmDeep: ChunkHit[] = [mkHit('v0'), mkHit('v1'), mkHit('kw-deep')]
check(
  'rescue only considers the top bm25 ranks, not the whole arm',
  !buildRerankPool(rrfFuse(vecArm, bmDeep), bmDeep).some(
    (c) => c.id === 'kw-deep',
  ),
)

check(
  'a small fused list passes through unchanged',
  (() => {
    const small = rrfFuse([mkHit('a'), mkHit('b')], [mkHit('b')])
    const out = buildRerankPool(small, [mkHit('b')])
    return (
      out.length === 2 && new Set(out.map((c) => c.id)).size === out.length
    )
  })(),
)

// ── rerankWithLlm (fake agent) ─────────────────────────────────────────

type RerankerArg = Parameters<typeof rerankWithLlm>[0]['rerankerAgent']
function fakeReranker(respond: () => Promise<{ text: string }>): RerankerArg {
  return { generate: respond } as unknown as RerankerArg
}
const fusedTrio: FusedChunk[] = [
  { ...mkHit('c1'), score: 0.03 },
  { ...mkHit('c2'), score: 0.02 },
  { ...mkHit('c3'), score: 0.01 },
]

check(
  'rerankWithLlm sorts by pointwise score (desc), highest-rated first',
  JSON.stringify(
    (
      await rerankWithLlm({
        // c1=1, c2=3, c3=2 → ordered c2, c3, c1.
        rerankerAgent: fakeReranker(async () => ({ text: '1: 1\n2: 3\n3: 2' })),
        query: 'q',
        candidates: fusedTrio,
      })
    ).map((c) => c.id),
  ) === JSON.stringify(['c2', 'c3', 'c1']),
)

check(
  'unrated candidates default to 0 and keep RRF tiebreak order',
  JSON.stringify(
    (
      await rerankWithLlm({
        // Only c2 rated (3); c1 & c3 default 0 → broken by RRF score
        // (c1 0.03 > c3 0.01).
        rerankerAgent: fakeReranker(async () => ({ text: '2: 3' })),
        query: 'q',
        candidates: fusedTrio,
      })
    ).map((c) => c.id),
  ) === JSON.stringify(['c2', 'c1', 'c3']),
)

check(
  'unparseable output falls back to the input (RRF) order',
  JSON.stringify(
    (
      await rerankWithLlm({
        rerankerAgent: fakeReranker(async () => ({ text: 'no scores here!' })),
        query: 'q',
        candidates: fusedTrio,
      })
    ).map((c) => c.id),
  ) === JSON.stringify(['c1', 'c2', 'c3']),
)

check(
  'an all-zero rating preserves the RRF order (never below baseline)',
  JSON.stringify(
    (
      await rerankWithLlm({
        rerankerAgent: fakeReranker(async () => ({ text: '1: 0\n2: 0\n3: 0' })),
        query: 'q',
        candidates: fusedTrio,
      })
    ).map((c) => c.id),
  ) === JSON.stringify(['c1', 'c2', 'c3']),
)

// Batched scoring: a pool wider than RERANK_BATCH_SIZE is split into
// multiple LLM calls and merged. Each fake call rates ITS first candidate
// top (10) and the rest 0; with the batch's own first candidate promoted,
// the merged order should lead with the first item of each batch.
check(
  'rerankWithLlm splits a wide pool into batches and merges scores',
  await (async () => {
    const wide: FusedChunk[] = Array.from({ length: RERANK_BATCH_SIZE + 5 }, (_, i) => ({
      ...mkHit(`w${i}`),
      score: 1 / (i + 1), // strictly decreasing RRF prior
    }))
    let calls = 0
    const batchSizes: number[] = []
    const out = await rerankWithLlm({
      rerankerAgent: fakeReranker(async () => {
        calls += 1
        // Rate candidate #1 of whatever batch a 10, the rest 0.
        return { text: '1: 10' }
      }),
      query: 'q',
      candidates: wide,
    })
    // Two batches expected for BATCH_SIZE+5 candidates.
    const expectedCalls = Math.ceil(wide.length / RERANK_BATCH_SIZE)
    void batchSizes
    return (
      calls === expectedCalls &&
      out.length === wide.length &&
      // First candidate of batch 1 (w0) and batch 2 (w{BATCH_SIZE}) both
      // scored 10 → they lead; w0 first (better RRF tiebreak).
      out[0]!.id === 'w0' &&
      out[1]!.id === `w${RERANK_BATCH_SIZE}` &&
      new Set(out.map((c) => c.id)).size === wide.length
    )
  })(),
)

check(
  'rerankWithLlm degrades to RRF order when every batch fails',
  await (async () => {
    const wide: FusedChunk[] = Array.from({ length: RERANK_BATCH_SIZE + 3 }, (_, i) => ({
      ...mkHit(`f${i}`),
      score: 1 / (i + 1),
    }))
    let failures = 0
    const out = await rerankWithLlm({
      rerankerAgent: fakeReranker(async () => {
        throw new Error('connection refused')
      }),
      query: 'q',
      candidates: wide,
      onFailure: () => {
        failures += 1
      },
    })
    // onFailure fires once (not once per batch) and order is unchanged.
    return (
      failures === 1 &&
      JSON.stringify(out.map((c) => c.id)) ===
        JSON.stringify(wide.map((c) => c.id))
    )
  })(),
)

check(
  'a transport failure falls back to input order and fires onFailure once',
  await (async () => {
    let failures = 0
    const out = await rerankWithLlm({
      rerankerAgent: fakeReranker(async () => {
        throw new Error('Loading model')
      }),
      query: 'q',
      candidates: fusedTrio,
      onFailure: () => {
        failures += 1
      },
    })
    return (
      failures === 1 &&
      JSON.stringify(out.map((c) => c.id)) ===
        JSON.stringify(['c1', 'c2', 'c3'])
    )
  })(),
)

// ── retryOnRateLimit + rerank backoff ──────────────────────────────────

// A 429-style error (AI-SDK exposes `statusCode`); `baseMs:1` keeps the
// backoff near-instant so the smoke stays sub-second.
const rateLimited = () =>
  Object.assign(new Error('Too Many Requests'), { statusCode: 429 })
const fastRetry = { retries: 3, baseMs: 1, capMs: 4 }

check(
  'retryOnRateLimit retries a 429 then succeeds',
  await (async () => {
    let calls = 0
    const out = await retryOnRateLimit(async () => {
      calls += 1
      if (calls < 3) throw rateLimited()
      return 'ok'
    }, fastRetry)
    return out === 'ok' && calls === 3
  })(),
)

check(
  'retryOnRateLimit does NOT retry a non-rate-limit error',
  await (async () => {
    let calls = 0
    try {
      await retryOnRateLimit(async () => {
        calls += 1
        throw new Error('bad request')
      }, fastRetry)
      return false
    } catch {
      return calls === 1
    }
  })(),
)

check(
  'retryOnRateLimit gives up after exhausting retries',
  await (async () => {
    let calls = 0
    try {
      await retryOnRateLimit(async () => {
        calls += 1
        throw rateLimited()
      }, fastRetry)
      return false
    } catch {
      // first try + 3 retries
      return calls === 4
    }
  })(),
)

check(
  'rerankWithLlm with retry rides out a 429 burst (no onFailure)',
  await (async () => {
    let calls = 0
    let failures = 0
    const out = await rerankWithLlm({
      rerankerAgent: fakeReranker(async () => {
        calls += 1
        if (calls < 3) throw rateLimited()
        return { text: '1: 1\n2: 3\n3: 2' }
      }),
      query: 'q',
      candidates: fusedTrio,
      onFailure: () => {
        failures += 1
      },
      retry: fastRetry,
    })
    return (
      failures === 0 &&
      JSON.stringify(out.map((c) => c.id)) === JSON.stringify(['c2', 'c3', 'c1'])
    )
  })(),
)

check(
  'rerankWithLlm with retry still fails fast on a non-429 (breaker fires)',
  await (async () => {
    let calls = 0
    let failures = 0
    const out = await rerankWithLlm({
      rerankerAgent: fakeReranker(async () => {
        calls += 1
        throw new Error('connection refused')
      }),
      query: 'q',
      candidates: fusedTrio,
      onFailure: () => {
        failures += 1
      },
      retry: fastRetry,
    })
    return (
      calls === 1 &&
      failures === 1 &&
      JSON.stringify(out.map((c) => c.id)) === JSON.stringify(['c1', 'c2', 'c3'])
    )
  })(),
)

// ── parseRelevanceScores ───────────────────────────────────────────────

check(
  'parseRelevanceScores reads one "n: score" pair per line (0-10 scale)',
  JSON.stringify(parseRelevanceScores('1: 9\n2: 0\n3: 4', 3)) ===
    JSON.stringify([9, 0, 4]),
)
check(
  'parseRelevanceScores parses two-digit score 10',
  JSON.stringify(parseRelevanceScores('1: 10\n2: 3', 2)) ===
    JSON.stringify([10, 3]),
)
check(
  'parseRelevanceScores ignores reasoning before a SCORES: marker',
  // Reasoning mentions "candidate 2" and a stray "1: irrelevant" — only the
  // lines after SCORES: count.
  JSON.stringify(
    parseRelevanceScores(
      'Candidate 2 looks close but candidate 3 answers it.\nSCORES:\n1: 2\n2: 4\n3: 9',
      3,
    ),
  ) === JSON.stringify([2, 4, 9]),
)
check(
  'parseRelevanceScores tolerates [n] brackets and "-"/")"separators',
  JSON.stringify(parseRelevanceScores('[1] - 2\n[2]) 8', 2)) ===
    JSON.stringify([2, 8]),
)
check(
  'parseRelevanceScores defaults unrated candidates to 0',
  JSON.stringify(parseRelevanceScores('2: 7', 3)) === JSON.stringify([0, 7, 0]),
)
check(
  'parseRelevanceScores drops out-of-range candidate numbers',
  JSON.stringify(parseRelevanceScores('1: 9\n99: 2', 3)) ===
    JSON.stringify([9, 0, 0]),
)
check(
  'parseRelevanceScores ignores scores above the scale max (no pair parsed)',
  parseRelevanceScores('1: 17', 3) === null,
)
check(
  'parseRelevanceScores returns null on empty input',
  parseRelevanceScores('', 3) === null,
)
check(
  'parseRelevanceScores returns null when no pair parses',
  parseRelevanceScores('nothing useful here', 3) === null,
)

// ── buildSearchKnowledgeTool ───────────────────────────────────────────

const fakeDb = {} as never  // never used when the factory short-circuits.

const noFiles = buildSearchKnowledgeTool({
  db: fakeDb,
  attachedFiles: [],
  embeddingProvider: mkProvider(),
  chatModel: null,
})
check(
  'buildSearchKnowledgeTool mounts even with empty attachedFiles',
  noFiles !== null && noFiles.id === 'search_knowledge',
  noFiles
    ? `id=${noFiles.id}`
    : 'null — but should mount so thread-scoped uploads still searchable',
)
check(
  'tool description for empty attachedFiles flags the drag-drop path',
  typeof noFiles?.description === 'string' &&
    noFiles.description.includes('drop files'),
  'mentions chat-drop intent',
)

const noProvider = buildSearchKnowledgeTool({
  db: fakeDb,
  attachedFiles: [{ id: 'f1', name: 'a.md', description: '' }],
  embeddingProvider: null,
  chatModel: null,
})
check(
  'buildSearchKnowledgeTool returns null with no embedding provider',
  noProvider === null,
)

const noDefaultModel = buildSearchKnowledgeTool({
  db: fakeDb,
  attachedFiles: [{ id: 'f1', name: 'a.md', description: '' }],
  embeddingProvider: mkProvider({ defaultModel: null }),
  chatModel: null,
})
check(
  'buildSearchKnowledgeTool returns null when provider has no defaultModel',
  noDefaultModel === null,
)

const tool = buildSearchKnowledgeTool({
  db: fakeDb,
  attachedFiles: [
    { id: 'f1', name: 'health-report.md', description: 'Annual physical.' },
    { id: 'f2', name: 'mortgage.md', description: 'Loan contract.' },
  ],
  embeddingProvider: mkProvider(),
  chatModel: null,
})
check(
  'buildSearchKnowledgeTool mounts when files + provider are present',
  tool !== null,
  tool ? `id=${tool.id}` : 'null',
)
check(
  'tool id is exactly "search_knowledge"',
  tool?.id === 'search_knowledge',
  `id=${tool?.id}`,
)
check(
  'tool description names the attached files',
  typeof tool?.description === 'string' &&
    tool.description.includes('health-report.md') &&
    tool.description.includes('mortgage.md'),
  'mentions both files',
)

// ── resolveBaseUrl ─────────────────────────────────────────────────────
//
// The "Invalid JSON response" production bug: a provider row stored as
// `http://127.0.0.1:8081` (no `/v1`) made Mastra hit llama-server's
// native `/embeddings` endpoint instead of the OpenAI-compatible
// `/v1/embeddings`. The fix lives in `resolveBaseUrl`, which trims
// trailing slashes and auto-appends `/v1` if missing. These checks
// pin the normalization so the regression can't slip back in.

check(
  'resolveBaseUrl appends /v1 when missing',
  resolveBaseUrl('openai_compatible', 'http://127.0.0.1:8081') ===
    'http://127.0.0.1:8081/v1',
  'plain host → host/v1',
)
check(
  'resolveBaseUrl keeps /v1 when already present',
  resolveBaseUrl('openai_compatible', 'http://127.0.0.1:8081/v1') ===
    'http://127.0.0.1:8081/v1',
  'no double-/v1 suffix',
)
check(
  'resolveBaseUrl strips trailing slash before appending',
  resolveBaseUrl('openai_compatible', 'http://127.0.0.1:8081/') ===
    'http://127.0.0.1:8081/v1',
  'trailing slash collapsed',
)
check(
  'resolveBaseUrl strips multiple trailing slashes',
  resolveBaseUrl('openai_compatible', 'http://127.0.0.1:8081////') ===
    'http://127.0.0.1:8081/v1',
  'multi-slash collapsed',
)
check(
  'resolveBaseUrl handles existing /v1 with trailing slash',
  resolveBaseUrl('openai_compatible', 'http://127.0.0.1:8081/v1/') ===
    'http://127.0.0.1:8081/v1',
  'slash after /v1 stripped',
)
check(
  'resolveBaseUrl falls back to vendor default for OpenAI when null',
  resolveBaseUrl('openai', null).endsWith('/v1'),
  'OpenAI default ends in /v1',
)

let threwForMissingLocalUrl = false
try {
  resolveBaseUrl('openai_compatible', null)
} catch {
  threwForMissingLocalUrl = true
}
check(
  'resolveBaseUrl throws for openai_compatible when no URL stored',
  threwForMissingLocalUrl,
  'belt-and-brace against the DTO validation that already requires it',
)

// ── page-aware PDF chunking ─────────────────────────────────────────────
// Regression guard: PDF chunks used to come back with page=null because
// extraction flattened all pages into one string.

// Pages big enough to each flush as their own chunk; the middle page is
// empty (chrome-only) so it's dropped, but original page numbers survive.
const bigPage = (label: string): string => `${label} ` + 'lorem '.repeat(700)
const stripped = stripPdfChrome([bigPage('PAGEONE'), '', bigPage('PAGETHREE')])
check(
  'stripPdfChrome returns text plus page boundaries',
  typeof stripped.text === 'string' && Array.isArray(stripped.boundaries),
)
check(
  'empty page is skipped but original page numbers are preserved',
  stripped.boundaries.length === 2 &&
    stripped.boundaries[0]?.page === 1 &&
    stripped.boundaries[1]?.page === 3,
  `pages=${stripped.boundaries.map((b) => b.page).join(',')}`,
)

const pdfPlan = chunkDocument({
  text: stripped.text,
  kind: 'pdf',
  fileName: 'fixture.pdf',
  mode: 'flat',
  pageBoundaries: stripped.boundaries,
})
const pageOf = (needle: string): number | null =>
  pdfPlan.flat.find((c) => c.text.includes(needle))?.page ?? null
check(
  'every PDF chunk carries a non-null page',
  pdfPlan.flat.length > 0 && pdfPlan.flat.every((c) => c.page !== null),
  `${pdfPlan.flat.length} chunks, pages=${pdfPlan.flat.map((c) => c.page).join(',')}`,
)
check(
  'chunks map to the correct source page',
  pageOf('PAGEONE') === 1 && pageOf('PAGETHREE') === 3,
  `PAGEONE→${pageOf('PAGEONE')} PAGETHREE→${pageOf('PAGETHREE')}`,
)

// Small pages merge into one chunk; it's attributed to where it began.
const merged = stripPdfChrome([
  'STARTPAGE ' + 'a '.repeat(30),
  'NEXTPAGE ' + 'b '.repeat(30),
])
const mergedPlan = chunkDocument({
  text: merged.text,
  kind: 'pdf',
  fileName: 'merge.pdf',
  mode: 'flat',
  pageBoundaries: merged.boundaries,
})
check(
  'a merged cross-page chunk is attributed to its start page',
  mergedPlan.flat.length === 1 && mergedPlan.flat[0]?.page === 1,
  `chunks=${mergedPlan.flat.length} page=${mergedPlan.flat[0]?.page}`,
)

// Non-PDF input carries no page boundaries → page stays null.
const txtPlan = chunkDocument({
  text: 'Plain notes. ' + 'words '.repeat(60),
  kind: 'txt',
  fileName: 'notes.txt',
  mode: 'flat',
})
check(
  'non-PDF chunks have a null page',
  txtPlan.flat.length > 0 && txtPlan.flat.every((c) => c.page === null),
  `${txtPlan.flat.length} chunks`,
)

// ── Summary ────────────────────────────────────────────────────────────

console.log('')
console.log('━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`   ✗ ${f}`)
  console.log('━'.repeat(60))
  process.exitCode = 1
} else {
  console.log(' All checks passed.')
  console.log('━'.repeat(60))
}

// ── Helpers ────────────────────────────────────────────────────────────

function mkProvider(overrides: Partial<LlmProviderRow> = {}): LlmProviderRow {
  const now = new Date('2026-05-23T00:00:00Z')
  return {
    id: 'embed-provider-id',
    kind: 'openai_compatible',
    role: 'embedding',
    label: 'Workspace embedder',
    baseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'bge-large-en',
    apiKeyEnvelope: null,
    modelsJson: null,
    embeddingDims: 1024,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}
