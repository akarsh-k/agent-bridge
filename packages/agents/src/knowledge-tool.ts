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
      const PER_FILE_CAP = scope.length === 1 ? Infinity : 3
      const perFileCount = new Map<string, number>()
      const diverse = fused.filter((c) => {
        const seen = perFileCount.get(c.fileId) ?? 0
        if (seen >= PER_FILE_CAP) return false
        perFileCount.set(c.fileId, seen + 1)
        return true
      })

      // Layer-1 candidate cap. Reranker spends LLM tokens proportional
      // to this — 8 is enough to keep room for a good top-3 to top-5
      // and small enough to fit one batched rerank prompt.
      const candidates = diverse.slice(0, 8)

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
}): Promise<ChunkHit[]> {
  const { db, scope, fingerprint, queryVector } = args
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
    LIMIT 20
    `,
    [vectorLiteral, scope.slice(), fingerprint],
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
}): Promise<ChunkHit[]> {
  const { db, scope, fingerprint, query } = args
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
      ts_rank_cd(tsv, q) AS rank
    FROM file_chunks, plainto_tsquery('english', $1) q
    WHERE file_id = ANY($2::uuid[])
      AND embedding_model = $3
      AND embedding IS NOT NULL
      AND tsv @@ q
    ORDER BY rank DESC
    LIMIT 20
    `,
    [query, scope.slice(), fingerprint],
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

/**
 * Reciprocal Rank Fusion. Standard k=60 constant from Cormack et al.
 * No tuning knobs — that's the point of RRF over weighted-sum
 * fusion. A chunk that appears at rank 1 in one list and rank 5 in
 * the other gets `1/(60+1) + 1/(60+5)` ≈ 0.032. Higher = better.
 *
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
  const addRanked = (list: ReadonlyArray<ChunkHit>): void => {
    list.forEach((hit, idx) => {
      const contribution = 1 / (K + (idx + 1))
      const existing = byId.get(hit.id)
      if (existing) {
        byId.set(hit.id, { ...existing, score: existing.score + contribution })
      } else {
        byId.set(hit.id, { ...hit, score: contribution })
      }
    })
  }
  addRanked(vectorList)
  addRanked(bm25List)
  return Array.from(byId.values()).sort((a, b) => b.score - a.score)
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
 * Single LLM call that returns the candidate ids in best-first order.
 * Hardened against partial output: any ids the model omits or
 * hallucinates fall through to the original RRF order. Never throws
 * — a failed rerank just degrades to layer-1 RRF.
 */
export async function rerankWithLlm(args: {
  rerankerAgent: Agent
  query: string
  candidates: ReadonlyArray<FusedChunk>
}): Promise<FusedChunk[]> {
  const { rerankerAgent, query, candidates } = args
  const numbered = candidates
    .map((c, i) => `${i + 1}. ${snippetOf(c.text, 280)}`)
    .join('\n\n')
  const prompt = `You are ranking search results for relevance.

QUERY: ${query}

CANDIDATES (numbered):
${numbered}

Return ONLY the candidate numbers in best-first order, comma-separated. Example: "3,1,4,2". No explanation, no other text.`

  let text: string
  try {
    const result = await rerankerAgent.generate(prompt, {})
    text = (result.text ?? '').trim()
  } catch (err) {
    console.warn(
      `[knowledge-tool] rerank failed; falling back to RRF order: ${err instanceof Error ? err.message : String(err)}`,
    )
    return [...candidates]
  }

  const ordering = parseRerankResponse(text, candidates.length)
  if (!ordering) return [...candidates]

  const seen = new Set<number>()
  const out: FusedChunk[] = []
  for (const idx of ordering) {
    if (seen.has(idx)) continue
    seen.add(idx)
    const candidate = candidates[idx]
    if (candidate) out.push(candidate)
  }
  // Append anything the model omitted, preserving RRF order. Saves
  // us from a silently-truncated reorder hiding good results.
  candidates.forEach((candidate, idx) => {
    if (!seen.has(idx)) out.push(candidate)
  })
  return out
}

/**
 * Parse the LLM's rerank response into a 0-based ordering. Tolerant of
 * prose around the digits and of out-of-range numbers (silently
 * dropped). Returns `null` only when no parseable digit appears.
 * Exported for smoke tests.
 */
export function parseRerankResponse(
  raw: string,
  total: number,
): number[] | null {
  if (!raw) return null
  // Accept comma- or whitespace-separated digits. Tolerant of
  // stray prose around the list.
  const matches = raw.match(/\d+/g)
  if (!matches || matches.length === 0) return null
  const out: number[] = []
  for (const m of matches) {
    const n = parseInt(m, 10)
    if (Number.isFinite(n) && n >= 1 && n <= total) {
      out.push(n - 1) // convert to 0-based
    }
  }
  return out.length > 0 ? out : null
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
