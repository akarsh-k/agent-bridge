/**
 * `search_knowledge` — built-in retrieval tool over the agent's attached
 * knowledge files. Hybrid retrieval (vector cosine + BM25 / `ts_rank_cd`)
 * fused via Reciprocal Rank Fusion, then LLM-as-judge reranked.
 *
 * Counterpart to the "Attached files" catalog block injected into the
 * system prompt by `composeInstructions`. The catalog tells the LLM
 * which files exist; this tool actually fetches the passages.
 *
 * Mounted only when the agent has at least one attached file. The set
 * of file ids is captured at build time; the `builtAgentCache`
 * invalidates whenever any underlying row changes, so attachments
 * stay in sync between catalog and tool.
 *
 * Design + retrieval algorithm: see `docs/knowledge-files.md`
 * §Retrieval (hybrid + rerank).
 */

import { Agent } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { createTool, type Tool } from '@mastra/core/tools'
import { z } from 'zod'

import type { AgentBridgeDb } from '@agent-bridge/db'
import type { LlmProviderRow } from '@agent-bridge/db/schema'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  KNOWLEDGE_PREVIEW_BYTES_CAP,
  type KnowledgeSearchCalledPayload,
  type KnowledgeSearchResultPayload,
} from '@agent-bridge/shared'

import { resolveBaseUrl } from './build-agent.js'
import {
  emitInspectorEvent,
  getInspectorRunContext,
} from './inspector/run-context.js'
import { getRunContext } from './run-context.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface AttachedKnowledgeFile {
  readonly id: string
  readonly name: string
  readonly description: string
}

export interface BuildSearchKnowledgeToolInput {
  readonly db: AgentBridgeDb
  readonly attachedFiles: ReadonlyArray<AttachedKnowledgeFile>
  /** Workspace embedding provider, used to embed the query at call
   *  time AND to compute the fingerprint that gates which chunks are
   *  queryable. Pass `null` to skip mounting (no provider → can't
   *  search). */
  readonly embeddingProvider: LlmProviderRow | null
  /** Agent's chat model. Used by the LLM-as-judge reranker. Pass
   *  `null` to skip rerank — top-K from RRF fusion is returned as-is. */
  readonly chatModel: MastraModelConfig | null
}

/**
 * Returns null when no embedding provider is configured. Mounts the
 * tool even when `attachedFiles` is empty — the agent might have no
 * `agent_files` rows but still get chat-scoped uploads via
 * `thread_files` that surface through the per-run async context.
 * The tool's empty-result hint covers the case where neither path
 * yields any in-scope files at call time.
 */
export function buildSearchKnowledgeTool(
  input: BuildSearchKnowledgeToolInput,
): Tool<any, any, any, any> | null {
  if (!input.embeddingProvider) return null
  if (!input.embeddingProvider.defaultModel) return null

  const { db, attachedFiles, embeddingProvider, chatModel } = input
  const embedder = buildEmbedder(embeddingProvider)
  const fingerprint = embeddingFingerprint(embeddingProvider)
  const fileIdSet = new Set(attachedFiles.map((f) => f.id))
  const fileNameById = new Map(attachedFiles.map((f) => [f.id, f.name]))
  const rerankerAgent = chatModel ? buildRerankerAgent(chatModel) : null

  // Per-tool-instance burst counter. Each `buildSearchKnowledgeTool`
  // call captures fresh closure state; the BuiltAgent cache rebuilds
  // on any underlying row change, so the counter is naturally scoped
  // to one "conversation epoch". A 60-second stale-reset catches
  // genuine pauses between turns and lets the next turn start at zero.
  //
  // The doc spec said "per-turn cap, enforced in the dispatcher".
  // That needs deeper plumbing into the run-event stream; this
  // closure-level cap is the pragmatic v1 — it catches the failure
  // mode (LLM loops calling the same tool) without per-run tracking.
  let burstCount = 0
  let lastCallAt = 0
  const BURST_WINDOW_MS = 60_000
  // Cap is intentionally generous (10) for v1 — the doc proposed 3 as
  // a starting value, but real per-turn use easily hits 3 with
  // legitimate multi-phrasing or multi-scope retries. 10 still catches
  // obvious runaway loops (which produce 20+ calls). Tune down once we
  // see real usage tracked via dispatcher telemetry.
  const BURST_CAP = 10

  return createTool({
    id: 'search_knowledge',
    description: buildToolDescription(attachedFiles),
    inputSchema: SEARCH_KNOWLEDGE_INPUT_SCHEMA,
    execute: async (raw) => {
      const startedAt = Date.now()
      if (startedAt - lastCallAt > BURST_WINDOW_MS) burstCount = 0
      lastCallAt = startedAt
      burstCount += 1
      // When the operator @-referenced files this turn the LLM may
      // legitimately fan one search per file; bump the cap.
      const effectiveCap = (() => {
        const ctx = getRunContext()
        return ctx.referencedFileIds.length > 0 ? BURST_CAP + 5 : BURST_CAP
      })()
      // Inspector run context — present when called from inside the
      // dispatcher's stream loop (the production path). Absent in the
      // pure-function smoke. We treat absence as "no telemetry surface,
      // run silently", same contract the inspector wrappers use.
      const inspectorCtx = getInspectorRunContext()
      const runId = inspectorCtx?.runId ?? ''

      if (burstCount > effectiveCap) {
        const hint =
          `Reached search_knowledge call cap (${effectiveCap} per turn). ` +
          `Use the chunks you already retrieved to answer; calling again on the same turn won't add new results.`
        await emitSearchResult({
          runId,
          durationMs: Date.now() - startedAt,
          chunkCount: 0,
          fileCount: 0,
          rerankUsed: false,
          capped: true,
          hint,
        })
        return {
          ok: false as const,
          chunks: [],
          hint,
        }
      }
      const args = SEARCH_KNOWLEDGE_INPUT_SCHEMA.parse(raw)

      // Pull per-run context (thread-attached files + referenced ids
      // from @-mentions). Empty when invoked outside a dispatched
      // run (e.g. the smoke test); we then operate against only the
      // build-time agent attachments.
      const ctx = getRunContext()
      const threadFileIdSet = new Set(ctx.threadFiles.map((f) => f.id))
      const referencedSet = new Set(ctx.referencedFileIds)

      // Authorized scope = agent attachments ∪ thread attachments.
      // Everything else (including referenced-but-not-attached ids)
      // gets filtered out so the LLM can't search files the operator
      // hasn't authorized.
      const authorized = new Set<string>([...fileIdSet, ...threadFileIdSet])

      // Scope resolution:
      //   1. `file_ids` arg from the LLM → hard filter (intersected
      //      with authorized).
      //   2. else if the operator @-referenced files this turn →
      //      hard filter to those.
      //   3. else search the full authorized union.
      const requestedExplicitly =
        Array.isArray(args.file_ids) && args.file_ids.length > 0
      const scope = requestedExplicitly
        ? args.file_ids!.filter((id) => authorized.has(id))
        : referencedSet.size > 0
          ? Array.from(referencedSet).filter((id) => authorized.has(id))
          : Array.from(authorized)

      // `knowledge.search.called` — fire as soon as scope is settled so
      // the Logs panel can render the search BEFORE it finishes. Mirrors
      // the inspector wrapper's emitToolCalled placement.
      const queryPreview = clipPreview(args.query, KNOWLEDGE_PREVIEW_BYTES_CAP)
      await emitInspectorEvent('knowledge.search.called', {
        runId,
        query: queryPreview.preview,
        queryTruncated: queryPreview.truncated,
        scopeFileCount: scope.length,
        ...(requestedExplicitly && args.file_ids
          ? { explicitFileIds: args.file_ids }
          : {}),
        topK: args.top_k ?? 5,
      } satisfies KnowledgeSearchCalledPayload)

      if (scope.length === 0) {
        const hint = requestedExplicitly
          ? 'None of the requested file ids are attached to this agent or thread. Pick from the catalog in your system prompt, or omit `file_ids` to search across all attached files.'
          : referencedSet.size > 0
            ? 'The files referenced via @-mention this turn are not attached to this agent or thread.'
            : 'No files attached to this agent or thread.'
        await emitSearchResult({
          runId,
          durationMs: Date.now() - startedAt,
          chunkCount: 0,
          fileCount: 0,
          rerankUsed: false,
          capped: false,
          hint,
        })
        return { ok: true as const, chunks: [], hint }
      }

      // Merge thread file names into the lookup so citations show the
      // real name (not an empty string) for hits from thread-scoped
      // files. Per-call clone — we don't want to mutate the closure
      // map and leak names across turns.
      const namesById = new Map(fileNameById)
      for (const tf of ctx.threadFiles) namesById.set(tf.id, tf.name)

      // Embed the query. One vector, used by the vector arm + as the
      // query input the LLM-as-judge sees alongside candidates.
      const embedResult = await embedder.doEmbed({ values: [args.query] })
      const queryVector = embedResult.embeddings[0]
      if (!queryVector) {
        const hint = 'Embedding service returned no vector for the query.'
        await emitSearchResult({
          runId,
          durationMs: Date.now() - startedAt,
          chunkCount: 0,
          fileCount: 0,
          rerankUsed: false,
          capped: false,
          hint,
        })
        return { ok: false as const, chunks: [], hint }
      }

      const [vectorHits, bm25Hits] = await Promise.all([
        runVectorSearch({ db, scope, fingerprint, queryVector }),
        runBm25Search({ db, scope, fingerprint, query: args.query }),
      ])

      const fused = rrfFuse(vectorHits, bm25Hits)
      if (fused.length === 0) {
        const hint =
          'No passages matched. The agent has files attached, but ' +
          'nothing in them clears the relevance threshold for this query.'
        await emitSearchResult({
          runId,
          durationMs: Date.now() - startedAt,
          chunkCount: 0,
          fileCount: 0,
          rerankUsed: false,
          capped: false,
          hint,
        })
        return { ok: true as const, chunks: [], hint }
      }

      // Per-file diversity cap on the fused candidate pool. Without it,
      // one chunky doc with many high-scoring passages can saturate the
      // rerank pool, crowding out other attached files. Mirrors the
      // top-3-per-file aggregation gitnexus applies inside its BM25
      // index (we apply post-fuse instead so both arms get a fair say).
      //
      // Skipped when only one file is in scope — a single-doc deep
      // dive shouldn't lose recall to a diversity rule that has
      // nothing to diversify across.
      const PER_FILE_CAP =
        scope.length === 1 ? Infinity : PER_FILE_DIVERSITY_CAP
      const perFileCount = new Map<string, number>()
      const diverse = fused.filter((c) => {
        const seen = perFileCount.get(c.fileId) ?? 0
        if (seen >= PER_FILE_CAP) return false
        perFileCount.set(c.fileId, seen + 1)
        return true
      })

      // Rerank pool: wider than the returned top-k so a gold passage the
      // embedder ranked deep (as far as ~rank 40 on the scorecard) still
      // reaches the judge, plus guaranteed slots for the keyword arm's best
      // hits. `rerankWithLlm` scores this pool in focused batches so the
      // width doesn't overload the local judge. See `buildRerankPool`,
      // `RERANK_CANDIDATE_CAP`, `RERANK_BATCH_SIZE`.
      const candidates = buildRerankPool(diverse, bm25Hits)

      const ordered =
        rerankerAgent && candidates.length > 3
          ? await rerankWithLlm({
              rerankerAgent,
              query: args.query,
              candidates,
            })
          : candidates

      const topK = ordered.slice(0, Math.min(args.top_k ?? 5, 10))

      // Hierarchical expansion: for any topK chunk that has a
      // `parentId`, fetch the parent's text and substitute. Keeps
      // page + section_path from the matching CHILD (the citation
      // points where the match actually was), but the LLM sees the
      // wider parent context. Single round-trip — batched by parent
      // id set across all topK results.
      const parentIds = Array.from(
        new Set(
          topK
            .map((c) => c.parentId)
            .filter((id): id is string => id !== null),
        ),
      )
      const parentTextById = new Map<string, string>()
      if (parentIds.length > 0) {
        const rows = await db.pool.query<{ id: string; text: string }>(
          `SELECT id, text FROM file_chunks WHERE id = ANY($1::uuid[])`,
          [parentIds],
        )
        for (const r of rows.rows) parentTextById.set(r.id, r.text)
      }

      // Hierarchical parents (~1500 tokens) are bigger than the 500-
      // char flat-snippet cap. Use a larger limit so we don't trim
      // away the very context that the expansion was meant to surface.
      const HIERARCHICAL_SNIPPET_LIMIT = 2000

      const distinctFiles = new Set(topK.map((c) => c.fileId)).size
      await emitSearchResult({
        runId,
        durationMs: Date.now() - startedAt,
        chunkCount: topK.length,
        fileCount: distinctFiles,
        rerankUsed: Boolean(rerankerAgent && candidates.length > 3),
        capped: false,
      })

      return {
        ok: true as const,
        chunks: topK.map((c) => {
          const expandedText = c.parentId
            ? (parentTextById.get(c.parentId) ?? c.text)
            : c.text
          const limit = c.parentId
            ? HIERARCHICAL_SNIPPET_LIMIT
            : undefined
          return {
            file_id: c.fileId,
            file_name: namesById.get(c.fileId) ?? '',
            page: c.page,
            section: c.sectionPath,
            snippet: snippetOf(expandedText, limit),
            score: c.score,
          }
        }),
      }
    },
  })
}

// ─── Tool input schema ──────────────────────────────────────────────────

const SEARCH_KNOWLEDGE_INPUT_SCHEMA = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'The information you want to find. Plain question or noun phrase, not boolean operators.',
      ),
    file_ids: z
      .array(z.string().uuid())
      .max(20)
      .optional()
      .describe(
        'Optional: scope the search to specific files (by id). Omit to search every file attached to this agent.',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Maximum chunks to return. Default 5, max 10.'),
  })
  .strict()

function buildToolDescription(
  files: ReadonlyArray<AttachedKnowledgeFile>,
): string {
  const base =
    'Search uploaded knowledge files for passages relevant to a query. ' +
    'Returns chunks with file name, page, section, snippet, and a score. ' +
    'Use the returned snippets to ground your answer and cite them by file name.'
  if (files.length === 0) {
    return (
      base +
      ' No files attached to this agent at build time, but the user may ' +
      'drop files into the chat — call this if the message suggests a doc lookup.'
    )
  }
  const fileSummary = files
    .map((f) => `\`${f.name}\` (id: ${f.id})`)
    .join(', ')
  return `${base} Available files: ${fileSummary}.`
}

// ─── Retrieval primitives ───────────────────────────────────────────────

/** Single result from one retrieval arm (vector OR BM25), exported
 *  so smoke tests can construct inputs to `rrfFuse` directly. */
export interface ChunkHit {
  readonly id: string
  readonly fileId: string
  /** When non-null, this hit is a CHILD chunk in hierarchical mode —
   *  the result mapping expands to the parent's text for snippet
   *  output (so the LLM sees full surrounding context). The child's
   *  page + section_path are kept for the citation; only the text
   *  body gets swapped. */
  readonly parentId: string | null
  readonly chunkIndex: number
  readonly page: number | null
  readonly sectionPath: string | null
  readonly text: string
  /** Source-specific raw score (cosine sim or ts_rank_cd). Carried for
   *  debugging; the fused output uses RRF below. */
  readonly rawScore: number
}

/** Chunk + RRF-fused score across vector + BM25 arms. */
export interface FusedChunk extends ChunkHit {
  readonly score: number
}

export async function runVectorSearch(args: {
  db: AgentBridgeDb
  scope: ReadonlyArray<string>
  fingerprint: string
  queryVector: ReadonlyArray<number>
  /** Retrieval depth. Defaults to `RETRIEVAL_DEPTH`. */
  limit?: number
}): Promise<ChunkHit[]> {
  const { db, scope, fingerprint, queryVector, limit = RETRIEVAL_DEPTH } = args
  // pgvector expects the literal `[1.0,2.0,...]` form for the parameter.
  // Build it here so the parameter is a plain string Postgres knows how
  // to cast — drizzle's `sql` template doesn't auto-stringify numeric
  // arrays into the pgvector shape.
  const vectorLiteral = `[${queryVector.join(',')}]`
  // node-postgres has clean JS-array → text[] / uuid[] binding when you
  // route through `pool.query` directly. The drizzle `sql` template
  // doesn't (it serialises the array as a plain string, which Postgres
  // then refuses to cast to `uuid[]`). Use the pool client.
  const rows = await db.pool.query<{
    id: string
    file_id: string
    parent_id: string | null
    chunk_index: number
    page: number | null
    section_path: string | null
    text: string
    cosine_distance: number
  }>(
    `
    SELECT
      id,
      file_id,
      parent_id,
      chunk_index,
      page,
      section_path,
      text,
      (embedding <=> $1::vector) AS cosine_distance
    FROM file_chunks
    WHERE file_id = ANY($2::uuid[])
      AND embedding_model = $3
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $4
    `,
    [vectorLiteral, scope.slice(), fingerprint, limit],
  )
  return rows.rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    parentId: r.parent_id,
    chunkIndex: r.chunk_index,
    page: r.page,
    sectionPath: r.section_path,
    text: r.text,
    // Convert distance → similarity for stable "higher is better" debug.
    rawScore: 1 - Number(r.cosine_distance),
  }))
}

export async function runBm25Search(args: {
  db: AgentBridgeDb
  scope: ReadonlyArray<string>
  fingerprint: string
  query: string
  /** Retrieval depth. Defaults to `RETRIEVAL_DEPTH`. */
  limit?: number
}): Promise<ChunkHit[]> {
  const { db, scope, fingerprint, query, limit = RETRIEVAL_DEPTH } = args
  const rows = await db.pool.query<{
    id: string
    file_id: string
    parent_id: string | null
    chunk_index: number
    page: number | null
    section_path: string | null
    text: string
    rank: number
  }>(
    `
    SELECT
      id,
      file_id,
      parent_id,
      chunk_index,
      page,
      section_path,
      text,
      ts_rank_cd(tsv, tq.q) AS rank
    FROM file_chunks,
      -- OR the lexemes instead of plainto_tsquery's implicit AND. Real
      -- BM25 scores partial matches; requiring every term meant
      -- natural-language questions matched almost nothing (13.6% hit
      -- rate on the scorecard). plainto_tsquery still handles
      -- tokenising/stemming/stopwords; lexemes are single quoted words,
      -- so the ' & ' → ' | ' replace is safe, ts_rank_cd still ranks
      -- many-term matches higher, and an all-stopword query yields the
      -- empty tsquery (matches nothing, as before). Subselect because
      -- a bare cast isn't a valid FROM item.
      (
        SELECT replace(
          plainto_tsquery('english', $1)::text, ' & ', ' | '
        )::tsquery AS q
      ) tq
    WHERE file_id = ANY($2::uuid[])
      AND embedding_model = $3
      AND embedding IS NOT NULL
      AND tsv @@ tq.q
    ORDER BY rank DESC
    LIMIT $4
    `,
    [query, scope.slice(), fingerprint, limit],
  )
  return rows.rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    parentId: r.parent_id,
    chunkIndex: r.chunk_index,
    page: r.page,
    sectionPath: r.section_path,
    text: r.text,
    rawScore: Number(r.rank),
  }))
}

// ─── Retrieval tuning knobs ─────────────────────────────────────────────
// Scorecard-validated; `knowledge-eval.ts` imports these so the
// scorecard always measures the same funnel as production.

/** How deep each arm (vector + BM25) retrieves before fusion. The
 *  oracle recall ceiling rises with depth: gold sat at vector rank
 *  17-50 on enough scorecard queries that a depth-20 pool capped the
 *  reachable hit-rate at ~95%. Going deeper lifts the ceiling and feeds
 *  more true candidates to the reranker, at the cost of a longer rerank
 *  prompt — bounded downstream by `RERANK_CANDIDATE_CAP`. */
export const RETRIEVAL_DEPTH = 50

/** BM25's vote weight in `rrfFuse`. The OR-matched keyword arm is far
 *  noisier than the vector arm; at equal weight it displaced good
 *  vector candidates and hybrid scored below vector-only. */
export const RRF_BM25_WEIGHT = 0.35

/** Fused candidates fed to the LLM reranker (then cut to `top_k`). Wider
 *  than a tight pool so relevant-but-deep chunks (gold sat as deep as
 *  vector rank ~40 on the scorecard) reach the judge and lift the pool's
 *  recall ceiling. Scoring all of them in ONE prompt hurt the local judge,
 *  so `rerankWithLlm` splits the pool into `RERANK_BATCH_SIZE` chunks and
 *  scores each independently — the cap can be wide without the focus-loss
 *  penalty. Only affects the reranker's side-call, never the agent's chat
 *  context. */
export const RERANK_CANDIDATE_CAP = 40

/** Candidates scored per LLM call inside `rerankWithLlm`. The pointwise
 *  judge stays accurate over a focused set but degrades over a long one
 *  (scoring 40 at once fell below scoring ~16-24); batching keeps each
 *  prompt small while the cap stays wide. Pointwise scores are per-passage,
 *  so splitting and merging is sound. A pool of `RERANK_CANDIDATE_CAP`
 *  becomes ceil(cap / batch) concurrent calls per search. */
export const RERANK_BATCH_SIZE = 20

/** Chars of each candidate the reranker judges on. Covers most of a
 *  typical chunk (chunker target ~3200) so the judge isn't ranking on the
 *  opening alone, while keeping the prompt small enough to stay fast. */
export const RERANK_EXCERPT_CHARS = 2600

/** Top BM25 hits guaranteed a rerank slot (see `buildRerankPool`). */
export const RERANK_BM25_RESCUE_SLOTS = 2

/** Per-file diversity cap on the rerank pool (skipped for single-file
 *  scopes). Shared with the scorecard so the measured funnel matches. */
export const PER_FILE_DIVERSITY_CAP = 3

/**
 * Rerank pool selection: the top `RERANK_CANDIDATE_CAP` fused
 * candidates, plus up to `RERANK_BM25_RESCUE_SLOTS` of the keyword
 * arm's top hits appended when fusion left them below the cut.
 *
 * The rescue slots exist because the down-weight makes BM25-only hits
 * unable to out-fuse a full vector arm (max 0.35/61 vs 1/80 for the
 * 20th vector hit), and a chunk the reranker never sees is an
 * unrecoverable miss. Appending (rather than swapping into the top
 * slice) keeps the fused slice's measured recall intact; an exact
 * identifier match the embedder missed still reaches the judge. Hits
 * cut by the diversity cap stay cut.
 */
export function buildRerankPool(
  diverse: ReadonlyArray<FusedChunk>,
  bm25List: ReadonlyArray<ChunkHit>,
): FusedChunk[] {
  const pool = diverse.slice(0, RERANK_CANDIDATE_CAP)
  const inPool = new Set(pool.map((c) => c.id))
  for (const hit of bm25List.slice(0, RERANK_BM25_RESCUE_SLOTS)) {
    if (inPool.has(hit.id)) continue
    const entry = diverse.find((c) => c.id === hit.id)
    if (!entry) continue
    pool.push(entry)
    inPool.add(hit.id)
  }
  return pool
}

/**
 * Weighted Reciprocal Rank Fusion. Standard k=60 constant from
 * Cormack et al.: a chunk at rank r contributes `weight / (60 + r)`
 * per arm (vector at 1, BM25 at `RRF_BM25_WEIGHT`); higher = better.
 * Dedupes by chunk id (the same chunk can appear in both lists).
 *
 * Exported for smoke tests (`tests/smoke-knowledge-tool.ts`); not part
 * of the public surface other consumers should call.
 */
export function rrfFuse(
  vectorList: ReadonlyArray<ChunkHit>,
  bm25List: ReadonlyArray<ChunkHit>,
): FusedChunk[] {
  const K = 60
  const byId = new Map<string, FusedChunk>()
  const addRanked = (
    list: ReadonlyArray<ChunkHit>,
    weight: number,
  ): void => {
    list.forEach((hit, idx) => {
      const contribution = weight / (K + (idx + 1))
      const existing = byId.get(hit.id)
      if (existing) {
        byId.set(hit.id, { ...existing, score: existing.score + contribution })
      } else {
        byId.set(hit.id, { ...hit, score: contribution })
      }
    })
  }
  addRanked(vectorList, 1)
  addRanked(bm25List, RRF_BM25_WEIGHT)
  return Array.from(byId.values()).sort((a, b) => b.score - a.score)
}

// ─── Rate-limit backoff ─────────────────────────────────────────────────

/** Provider responses we treat as "slow down, retry later" rather than
 *  "this call is broken". 429 = rate limited; 503/529 = overloaded. */
const RATE_LIMIT_STATUSES = new Set([429, 503, 529])

/** Duck-type a provider/transport error for rate-limit pushback. AI-SDK
 *  errors expose `statusCode`, fetch-style ones `status`; `Retry-After`
 *  (seconds) is surfaced when present. */
function rateLimitInfo(err: unknown): {
  retryable: boolean
  retryAfterMs?: number
} {
  if (!err || typeof err !== 'object') return { retryable: false }
  const e = err as Record<string, unknown>
  const status =
    typeof e.statusCode === 'number'
      ? e.statusCode
      : typeof e.status === 'number'
        ? e.status
        : undefined
  if (status === undefined || !RATE_LIMIT_STATUSES.has(status)) {
    return { retryable: false }
  }
  const headers = (e.responseHeaders ?? e.headers) as
    | Record<string, string>
    | undefined
  const ra = headers?.['retry-after'] ?? headers?.['Retry-After']
  const secs = ra !== undefined ? Number(ra) : NaN
  return {
    retryable: true,
    ...(Number.isFinite(secs) && secs >= 0
      ? { retryAfterMs: secs * 1000 }
      : {}),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryPolicy {
  /** Retry attempts AFTER the first try (total tries = retries + 1). */
  readonly retries: number
  /** Base backoff in ms; doubles per attempt, capped at `capMs`. */
  readonly baseMs?: number
  readonly capMs?: number
}

/**
 * Run `fn`, retrying ONLY rate-limit errors (429/503/529) with
 * exponential backoff + jitter. Other errors throw immediately, so a
 * dead provider still fails fast (and trips the scorecard breaker) while
 * transient throttling just waits and retries. `Retry-After` is honored
 * but clamped to `capMs` so a hostile value can't stall a worker.
 */
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  const { retries, baseMs = 500, capMs = 8000 } = policy
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const info = rateLimitInfo(err)
      if (!info.retryable || attempt >= retries) throw err
      const backoff = baseMs * 2 ** attempt
      const jittered = backoff * (0.5 + Math.random() * 0.5)
      const waitMs = Math.min(capMs, Math.max(jittered, info.retryAfterMs ?? 0))
      attempt += 1
      await sleep(waitMs)
    }
  }
}

// ─── LLM-as-judge reranker ──────────────────────────────────────────────

export function buildRerankerAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: 'search-knowledge-reranker',
    name: 'search-knowledge-reranker',
    description:
      'Reorders search candidates by relevance to a query for the search_knowledge tool.',
    instructions: '',
    model,
  })
}

/**
 * Pointwise LLM rerank. Rather than ask the model for a full best-first
 * permutation of N candidates — unreliable past a handful of items on
 * smaller/local models, where it demoted gold the vector arm already had
 * in the top-k and dropped hit-rate BELOW plain RRF — we ask it to RATE
 * each candidate's relevance to the query on a 0-3 scale.
 *
 * We then sort by `(llmScore desc, RRF score desc)`: the score promotes a
 * deep-but-relevant chunk up into the returned top-k, while the RRF prior
 * breaks ties so a strong vector hit is never displaced by a distractor
 * the model happened to rate equally. The worst case is "model rates
 * everything 0" → pure RRF order, i.e. rerank can no longer score below
 * the RRF baseline.
 *
 * Never throws: a transport failure or unparseable output degrades to the
 * input (RRF) order. Transport failures fire `onFailure` (breaker); a
 * parse miss does not (the provider is alive, just terse).
 */
export async function rerankWithLlm(args: {
  rerankerAgent: Agent
  query: string
  candidates: ReadonlyArray<FusedChunk>
  /** Called when the rerank LLM call itself fails (transport/provider
   *  errors, not parse fallbacks). Lets callers trip a circuit breaker
   *  instead of re-attempting a dead provider per query. Fired once per
   *  rerank only when EVERY batch failed at the transport layer (a genuine
   *  outage); a partial-batch failure degrades those candidates to RRF
   *  order without tripping the breaker. */
  onFailure?: (err: unknown) => void
  /** Opt-in backoff on rate-limit pushback, for the scorecard's parallel
   *  fan-out. The per-turn production path omits it (a 429 there just
   *  degrades to RRF). Non-rate-limit errors still fall through to
   *  `onFailure` immediately. */
  retry?: RetryPolicy
}): Promise<FusedChunk[]> {
  const { rerankerAgent, query, candidates, onFailure, retry } = args
  if (candidates.length === 0) return []

  // Score in focused batches rather than one big prompt. A local judge
  // loses accuracy over a long candidate list — on the scorecard, scoring
  // all 40 at once DROPPED hit-rate below scoring 24, even though 40 has
  // the higher recall ceiling. Because scoring is POINTWISE (each passage
  // rated on its own 0-10 merit, not ranked against the others), a wide
  // pool can be split into `RERANK_BATCH_SIZE` chunks scored independently
  // and merged — keeping each prompt small while still considering every
  // candidate. Batches run concurrently; one batch failing just leaves its
  // candidates at score 0 (RRF order) instead of sinking the whole rerank.
  const batches: FusedChunk[][] = []
  for (let i = 0; i < candidates.length; i += RERANK_BATCH_SIZE) {
    batches.push(candidates.slice(i, i + RERANK_BATCH_SIZE))
  }

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      try {
        return {
          ok: true as const,
          scores: await scoreCandidateBatch({
            rerankerAgent,
            query,
            batch,
            retry,
          }),
        }
      } catch (err) {
        return { ok: false as const, err }
      }
    }),
  )

  // Merge batch scores back onto the global candidate list (aligned by the
  // batch offsets). Unscored candidates — failed batch or parse miss —
  // stay 0 and fall to RRF order via the tiebreak.
  const scores = new Array<number>(candidates.length).fill(0)
  let offset = 0
  let anyScored = false
  let failedBatches = 0
  batchResults.forEach((res, bi) => {
    const len = batches[bi]!.length
    if (!res.ok) {
      failedBatches += 1
    } else if (res.scores) {
      for (let j = 0; j < len; j++) scores[offset + j] = res.scores[j] ?? 0
      anyScored = true
    }
    offset += len
  })

  // Every batch failed at the transport layer → the provider is down. Fire
  // the breaker and degrade to RRF order (same contract as the old single
  // call). A partial failure does NOT trip it.
  if (failedBatches === batches.length) {
    const firstErr = batchResults.find((r) => !r.ok && 'err' in r)
    const err = firstErr && !firstErr.ok ? firstErr.err : undefined
    console.warn(
      `[knowledge-tool] rerank failed; falling back to RRF order: ${err instanceof Error ? err.message : String(err)}`,
    )
    if (onFailure) onFailure(err)
    return [...candidates]
  }
  if (!anyScored) return [...candidates]

  // Stable reorder: higher LLM score first, RRF score breaks ties. Sort an
  // index array so equal-keyed candidates keep their incoming (RRF) order.
  const order = candidates.map((_, i) => i)
  order.sort((a, b) => {
    const sa = scores[a] ?? 0
    const sb = scores[b] ?? 0
    if (sb !== sa) return sb - sa
    return (candidates[b]!.score ?? 0) - (candidates[a]!.score ?? 0)
  })
  return order.map((i) => candidates[i]!)
}

/**
 * Score one batch of candidates 0-10 for relevance to the query, returning
 * a score array aligned to `batch` (or null if the model's output didn't
 * parse). Throws on a transport/provider error so the caller can count it
 * toward the breaker. Decoded at `temperature: 0` for accurate, stable
 * scores; `maxRetries: 0` so a dead provider fails fast (the optional
 * `retry` only backs off on rate-limit pushback).
 */
async function scoreCandidateBatch(args: {
  rerankerAgent: Agent
  query: string
  batch: ReadonlyArray<FusedChunk>
  retry?: RetryPolicy
}): Promise<number[] | null> {
  const { rerankerAgent, query, batch, retry } = args
  // Present the section heading (high-signal for structured docs like
  // regulations/contracts) plus an excerpt. The section path keeps the
  // judge oriented even when the answer sits past the excerpt cut.
  const numbered = batch
    .map((c, i) => {
      const head = c.sectionPath ? `(section: ${c.sectionPath})\n` : ''
      return `[${i + 1}] ${head}${snippetOf(c.text, RERANK_EXCERPT_CHARS)}`
    })
    .join('\n\n')
  const prompt = `You score how well each candidate passage answers a search query.

QUERY: ${query}

A passage ANSWERS the query if it states the answer — even when it uses
different words than the question (synonyms, legal or technical terms,
paraphrase). A passage that only repeats the query's topic without giving the
answer is NOT a good match.

CANDIDATES:
${numbered}

First, in one or two short sentences, reason about which candidate numbers
actually answer the query, looking past differences in wording. Then write a
line containing only "SCORES:" and, after it, one line per candidate as
"<number>: <score>" where score is 0 to 10:
  9-10 = states the explicit answer to the query
  6-8  = clearly relevant, contains most of the answer
  3-5  = related but does not answer the query
  1-2  = only mentions the topic in passing
  0    = unrelated
Use the FULL range; the single best passage gets the highest score.

Example:
Candidates 3 and 1 both answer it; 3 is the most direct.
SCORES:
1: 7
2: 0
3: 9`

  const call = () =>
    rerankerAgent.generate(prompt, {
      modelSettings: { maxRetries: 0, temperature: 0 },
    })
  const result = retry ? await retryOnRateLimit(call, retry) : await call()
  const text = (result.text ?? '').trim()
  return parseRelevanceScores(text, batch.length)
}

/** Top of the pointwise relevance scale (0..`RELEVANCE_SCALE_MAX`). A
 *  finer scale than 0-3 discriminates between several "clearly relevant"
 *  passages so the single best one wins the top slot instead of tying and
 *  being settled by the weaker retrieval-rank tiebreak. */
export const RELEVANCE_SCALE_MAX = 10

/**
 * Parse pointwise relevance scores from the model's output into an array
 * of length `total` (0-based by candidate index; unrated candidates
 * default to 0). Accepts one `"<n>: <score>"` pair per line, tolerant of
 * `[n]` brackets and `:`/`)`/`-`/`.` separators. Scores are clamped to
 * 0..`RELEVANCE_SCALE_MAX`; candidate numbers outside 1..total are
 * dropped. Returns `null` only when no pair parses, so the caller can
 * fall back to RRF order. Exported for smoke tests.
 *
 * When the model is asked to reason first, it emits a `SCORES:` marker
 * before the score lines; we parse only what follows the LAST such marker
 * so the free-text reasoning (which may mention numbers) can't pollute the
 * scores. Output without a marker is parsed whole (back-compat).
 */
export function parseRelevanceScores(
  raw: string,
  total: number,
): number[] | null {
  if (!raw) return null
  // Keep only the text after the final "SCORES:" marker, if present.
  const marker = /SCORES:/gi
  let lastMarkerEnd = -1
  for (let m = marker.exec(raw); m; m = marker.exec(raw)) {
    lastMarkerEnd = m.index + m[0].length
  }
  const body = lastMarkerEnd >= 0 ? raw.slice(lastMarkerEnd) : raw
  const scores = new Array<number>(total).fill(0)
  let any = false
  // A leading optional "[", the candidate number, a separator, then the
  // score (1-2 digits). Anchored per line so excerpt digits can't bleed
  // in; the score is range-checked below rather than in the pattern.
  const re = /^\s*\[?\s*(\d+)\s*\]?\s*[:)\].\-]\s*(\d{1,2})\b/
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(re)
    if (!m) continue
    const n = parseInt(m[1]!, 10)
    const s = parseInt(m[2]!, 10)
    if (n >= 1 && n <= total && s >= 0 && s <= RELEVANCE_SCALE_MAX) {
      scores[n - 1] = s
      any = true
    }
  }
  return any ? scores : null
}

// ─── Helpers ────────────────────────────────────────────────────────────

export function buildEmbedder(provider: LlmProviderRow): ModelRouterEmbeddingModel {
  const apiKey = provider.apiKeyEnvelope
    ? decryptSecret(provider.apiKeyEnvelope)
    : undefined
  // `resolveBaseUrl` strips trailing slashes and auto-appends `/v1` if
  // missing so we hit `/v1/embeddings` (OpenAI shape) instead of
  // `/embeddings` (llama.cpp native shape). Same rule the gitnexus
  // mount + build-agent's chat model already apply — keep these in
  // lockstep so a single provider row works everywhere.
  return new ModelRouterEmbeddingModel({
    providerId: provider.kind,
    modelId: provider.defaultModel!,
    url: resolveBaseUrl(provider.kind, provider.baseUrl),
    ...(apiKey ? { apiKey } : {}),
  })
}

export function embeddingFingerprint(provider: LlmProviderRow): string {
  const dim = provider.embeddingDims ?? 1024
  return `${provider.kind}:${provider.defaultModel}:${dim}`
}

// ─── Eager pre-fetch ────────────────────────────────────────────────────

/**
 * Run the same hybrid retrieval the tool runs, without the LLM
 * rerank. Returns top-K chunks for a single file, ready to inject
 * into a prompt as a synthetic "pre-fetched context" note.
 *
 * The dispatcher's caller (the backend `POST /runs` route) uses this
 * for the doc-spec'd "one-shot eager pre-fetch": when the user
 * @-mentions exactly one file in a short message ("summarise this"),
 * we skip the LLM's tool-call round-trip and stuff the relevant
 * passages directly into the prompt. The LLM gets the chunks even
 * if it never thinks to call `search_knowledge`.
 *
 * Returns an empty array on any failure (no embedding provider,
 * dim mismatch, fingerprint mismatch on the file's chunks, query
 * embedding failure). Pre-fetch is best-effort; missing chunks
 * shouldn't fail the user's turn.
 */
export async function eagerPrefetchKnowledge(args: {
  db: AgentBridgeDb
  fileId: string
  query: string
  topK?: number
}): Promise<
  ReadonlyArray<{
    fileId: string
    page: number | null
    sectionPath: string | null
    snippet: string
    score: number
  }>
> {
  const { db, fileId, query, topK = 3 } = args
  // Look up the workspace embedding provider. Mirrors the same
  // lookup the dispatcher does at agent build, but inlined here so
  // pre-fetch doesn't need an agent.
  const result = await db.pool.query<{
    kind: string
    default_model: string
    base_url: string | null
    api_key_envelope: string | null
    embedding_dims: number | null
  }>(
    `SELECT kind, default_model, base_url, api_key_envelope, embedding_dims
     FROM llm_providers WHERE role = 'embedding' LIMIT 1`,
  )
  const row = result.rows[0]
  if (!row || !row.default_model) return []

  const apiKey = row.api_key_envelope
    ? decryptSecret(row.api_key_envelope)
    : undefined
  const embedder = new ModelRouterEmbeddingModel({
    providerId: row.kind,
    modelId: row.default_model,
    // Mirror `buildEmbedder` — auto-append `/v1` so the URL lands on
    // `/v1/embeddings` regardless of whether the operator stored the
    // baseUrl with or without the `/v1` suffix.
    url: resolveBaseUrl(row.kind as LlmProviderRow['kind'], row.base_url),
    ...(apiKey ? { apiKey } : {}),
  })
  const fingerprint = `${row.kind}:${row.default_model}:${row.embedding_dims ?? 1024}`

  let queryVector: ReadonlyArray<number>
  try {
    const embed = await embedder.doEmbed({ values: [query] })
    const vec = embed.embeddings[0]
    if (!vec) return []
    queryVector = vec
  } catch {
    return []
  }

  const [vec, bm25] = await Promise.all([
    runVectorSearch({ db, scope: [fileId], fingerprint, queryVector }),
    runBm25Search({ db, scope: [fileId], fingerprint, query }),
  ])
  const fused = rrfFuse(vec, bm25)
  if (fused.length === 0) return []
  return fused.slice(0, topK).map((c) => ({
    fileId: c.fileId,
    page: c.page,
    sectionPath: c.sectionPath,
    snippet: snippetOf(c.text),
    score: c.score,
  }))
}

/** Trim a chunk to a snippet for the LLM. 500-char cap matches the
 *  ToolAPI shape in `docs/knowledge-files.md`. Word boundary at the
 *  trim point so we don't slice mid-word into the LLM's view. */
function snippetOf(text: string, limit = 500): string {
  if (text.length <= limit) return text
  const slice = text.slice(0, limit)
  const lastSpace = slice.lastIndexOf(' ')
  if (lastSpace > limit * 0.6) {
    return slice.slice(0, lastSpace) + '…'
  }
  return slice + '…'
}

// ─── Event-emit helpers ─────────────────────────────────────────────────

/** Truncate a string for an event preview. Matches the inspector's
 *  `previewJson` shape but takes plain strings (no JSON.stringify). */
function clipPreview(
  raw: string,
  cap: number,
): { preview: string; truncated: boolean } {
  if (raw.length <= cap) return { preview: raw, truncated: false }
  return {
    preview: raw.slice(0, Math.max(cap - 1, 0)) + '…',
    truncated: true,
  }
}

/** Single sink for `knowledge.search.result` so every return path goes
 *  through one redaction-aware emit. Truncates `hint` so a long empty-
 *  result message can't blow the per-event preview budget. */
async function emitSearchResult(
  payload: KnowledgeSearchResultPayload,
): Promise<void> {
  const trimmed: KnowledgeSearchResultPayload = payload.hint
    ? {
        ...payload,
        hint: clipPreview(payload.hint, KNOWLEDGE_PREVIEW_BYTES_CAP).preview,
      }
    : payload
  await emitInspectorEvent('knowledge.search.result', trimmed)
}
