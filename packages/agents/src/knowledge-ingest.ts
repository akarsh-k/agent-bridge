/**
 * Knowledge file ingestion pipeline.
 *
 * Drives one `files` row through the pipeline:
 *
 *   1. Load row, gate on `ingest_status`.
 *   2. Read original bytes from disk.
 *   3. Extract text (Phase 1: md/txt is a no-op decode).
 *   4. Section-aware chunking (split on markdown headings; sub-split
 *      paragraphs at ~800 tokens; no overlap).
 *   5. Embed each chunk via the workspace embedding provider. Embedding
 *      input is prefixed with `{file.name}\n{section_path}\n\n` so
 *      retrieval can match on location, not just literal content.
 *   6. Write `file_chunks` rows, including the embedding-model
 *      fingerprint that the retrieval path checks before serving.
 *   7. Auto-describe the file via the workspace utility chat model
 *      (best-effort — skipped silently when no chat provider is set).
 *   8. Mark `ingest_status='ready'`.
 *
 * On any failure: status flips to `'error'`, `ingest_error` carries
 * the message, partial chunks remain so a re-ingest can resume from
 * `chunks_done` instead of starting from scratch.
 *
 * Design: see `docs/knowledge-files.md` §Ingestion pipeline.
 */

import { readFile } from 'node:fs/promises'

import { Agent } from '@mastra/core/agent'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import type { MastraModelConfig } from '@mastra/core/llm'
import { asc, eq } from 'drizzle-orm'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  knowledgeExtractedPath,
  knowledgeOriginalPath,
} from '@agent-bridge/shared/paths'
import { writeFile } from 'node:fs/promises'

import type { FileRow } from '@agent-bridge/db/schema'
import {
  fileStreamId,
  MAX_CHUNKS_PER_FILE,
  type KnowledgeIngestFailPayload,
  type KnowledgeIngestOkPayload,
  type KnowledgeIngestProgressPayload,
  type KnowledgeIngestStartedPayload,
  type KnowledgeIngestStep,
  type RunEvent,
} from '@agent-bridge/shared'

import { resolveBaseUrl } from './build-agent.js'
import { ensureFileChunksDim, FileChunksDimMismatch } from './knowledge-dim.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface IngestKnowledgeFileInput {
  readonly db: AgentBridgeDb
  readonly fileId: string
  /** Optional telemetry sink. The backend route plumbs a thunk that
   *  publishes onto the workspace event bus (`file:<id>` stream); the
   *  smoke + tests pass undefined and ingest runs silently. Failures
   *  inside the callback are swallowed by the caller — telemetry must
   *  never take down an ingest. */
  readonly publish?: (event: RunEvent) => Promise<void> | void
}

/**
 * Run the full ingest pipeline for one file. Idempotent: safe to call
 * twice on the same id; the second call resumes from `chunks_done` if
 * the first crashed mid-embed.
 *
 * Returns when the file lands on `'ready'` or `'error'`. Callers
 * normally invoke fire-and-forget (`void ingestKnowledgeFile(...)`)
 * because the pipeline is slow on big files and the HTTP route
 * shouldn't block.
 *
 * Concurrency: a process-level semaphore (default cap 2) serialises
 * ingest jobs so a bulk upload doesn't hammer the embedder with
 * parallel requests. The cap is intentionally low; embedding
 * endpoints (local llama.cpp, hosted OpenAI-compatible, etc.) all
 * rate-limit under load and the queue keeps the burst behind a
 * predictable bottleneck. Override via the env var
 * `AGENT_BRIDGE_INGEST_CONCURRENCY` for power users.
 */
export async function ingestKnowledgeFile(
  input: IngestKnowledgeFileInput,
): Promise<void> {
  await ingestSemaphore.acquire()
  try {
    return await ingestInner(input)
  } finally {
    ingestSemaphore.release()
  }
}

async function ingestInner(input: IngestKnowledgeFileInput): Promise<void> {
  const { db, fileId, publish } = input
  const startedAt = Date.now()
  const emit = makeIngestEmit(fileId, publish)

  // ── Load row + sanity checks ─────────────────────────────────────────
  const [file] = await db.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  if (!file) {
    console.warn(`[knowledge-ingest] file ${fileId} not found, skipping`)
    return
  }
  if (file.ingestStatus === 'ready') {
    return
  }

  // Orphan-chunk cleanup. A previous attempt may have left rows in
  // `file_chunks` for this file without bumping `files.chunks_done`
  // (process crash between the INSERT and the UPDATE — narrow window
  // but real). If we don't clean those up first, the embed loop
  // restarts from chunks_done=0 and INSERTs new rows at the same
  // (file_id, chunk_index) pairs, duplicating every orphan. Only fires
  // when chunks_done is 0 — once it's bumped at least once, the
  // standard resume path picks up cleanly.
  if (file.chunksDone === 0) {
    await db.db
      .delete(schema.fileChunks)
      .where(eq(schema.fileChunks.fileId, fileId))
  }

  await emit('knowledge.ingest.started', {
    fileId,
    fileName: file.name,
    bytes: file.bytes,
    kind: file.kind,
  } satisfies KnowledgeIngestStartedPayload)

  // Local wrappers — keep setStatus/markError DB-only and pair each
  // call with a telemetry emit so the Library page (subscribed to
  // `file:<id>`) sees the lifecycle in real time without polling.
  // Declared before the provider lookup so the "no embedding provider"
  // refusal path also lands a `.fail` event.
  const transition = async (step: KnowledgeIngestStep): Promise<void> => {
    await setStatus(db, fileId, step)
    await emit('knowledge.ingest.progress', {
      fileId,
      step,
    } satisfies KnowledgeIngestProgressPayload)
  }
  const fail = async (message: string): Promise<void> => {
    await markError(db, fileId, message)
    await emit('knowledge.ingest.fail', {
      fileId,
      durationMs: Date.now() - startedAt,
      message: message.slice(0, 1_000),
    } satisfies KnowledgeIngestFailPayload)
  }

  // Resolve the workspace embedding provider once. Fingerprint goes on
  // every chunk row; refusing to ingest without it is louder than
  // ingesting and refusing at query time.
  const [embedProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'embedding'))
    .limit(1)
  if (!embedProvider || !embedProvider.defaultModel) {
    await fail(
      'No workspace embedding provider configured. ' +
        'Add one in Library → Providers (role: embedding) before uploading files.',
    )
    return
  }

  // Sync the `file_chunks.embedding` column type to the provider's
  // reported dim. Non-destructive when the table is empty (fresh
  // install, or post-rebuild reingest). If chunks already exist at a
  // different dim, refuse loudly — the operator has to route through
  // the destructive rebuild flow (provider PATCH with
  // `wipeSemanticVectors=true`, or the Library "Rebuild knowledge
  // index" action), neither of which lives in the ingest path.
  //
  // Refuse upfront when `embeddingDims` is null: without it we can't
  // size the column, and the embed insert would fail later with a
  // vector_dimension_mismatch that's harder to diagnose.
  if (embedProvider.embeddingDims == null) {
    await fail(
      'Workspace embedding provider does not report a `embeddingDims` value. ' +
        'Open Library → Providers, edit the embedding provider, and set the ' +
        'embedding dimension (or click "Test" so it autofills).',
    )
    return
  }
  try {
    await ensureFileChunksDim(db, embedProvider.embeddingDims)
  } catch (err) {
    if (err instanceof FileChunksDimMismatch) {
      await fail(err.message)
      return
    }
    throw err
  }

  const fingerprint = embeddingFingerprint(embedProvider)

  try {
    // ── Extract ────────────────────────────────────────────────────────
    await transition('extracting')
    const extracted = await extractText(file)
    if (!extracted.text.trim()) {
      await fail(
        'This PDF has no selectable text. It looks like a scanned image. ' +
          'Run it through an OCR tool (Acrobat, ocrmypdf, or Preview) so ' +
          'the pages get a text layer, then upload again.',
      )
      return
    }
    // Cache extracted text so reingest skips this step.
    await writeFile(knowledgeExtractedPath(file.id), extracted.text, {
      mode: 0o600,
    })
    if (extracted.pageCount !== null) {
      await db.db
        .update(schema.files)
        .set({ pageCount: extracted.pageCount })
        .where(eq(schema.files.id, fileId))
    }
    // Strip NUL bytes the extractor may have carried out of a malformed
    // PDF / OCR layer. They're meaningless in document text and Postgres
    // rejects them on insert, so clean once here — every chunk, section
    // path, embedding input, and the auto-description derive from `text`.
    const text = stripNul(extracted.text)

    // ── Chunk ──────────────────────────────────────────────────────────
    await transition('chunking')
    const mode = (
      file.chunkingMode === 'hierarchical' ? 'hierarchical' : 'flat'
    ) as 'flat' | 'hierarchical'
    const plan = chunkDocument({
      text,
      kind: file.kind,
      fileName: file.name,
      mode,
    })
    const planCount =
      plan.mode === 'flat' ? plan.flat.length : plan.children.length
    if (planCount === 0) {
      await fail('Chunking produced no chunks (empty document?).')
      return
    }
    // Per-file chunk cap. Without this, a pathologically long doc would
    // run away with embedder calls (and with token cost if Contextual
    // Retrieval is on — one LLM blurb per chunk). Refuse upfront with a
    // clear message; operator can split the doc or raise the cap in
    // `packages/shared/src/dtos/files.ts` if their use case warrants.
    if (planCount > MAX_CHUNKS_PER_FILE) {
      await fail(
        `Chunking produced ${planCount} chunks, which exceeds the ` +
          `${MAX_CHUNKS_PER_FILE}-chunk per-file cap. Split the file into ` +
          `smaller documents or raise MAX_CHUNKS_PER_FILE in ` +
          `packages/shared/src/dtos/files.ts.`,
      )
      return
    }

    // ── Contextual Retrieval (opt-in) ─────────────────────────────────
    // Anthropic's "Contextual Retrieval": per-chunk LLM blurb that
    // describes where the chunk sits in the document. Prepended to
    // the embedding INPUT (not the stored text), so geometric
    // placement encodes document-level context. Anthropic reports a
    // 67% retrieval-failure reduction with this + reranking. Cost is
    // ONE LLM CALL PER CHUNK at ingest time — material on big files.
    //
    // Opt-in via `AGENT_BRIDGE_CONTEXTUAL_RETRIEVAL=true`. Default off.
    const contextualEnabled =
      process.env['AGENT_BRIDGE_CONTEXTUAL_RETRIEVAL'] === 'true'
    let contextBlurbs: ReadonlyArray<string> = []
    if (contextualEnabled) {
      const targets =
        plan.mode === 'flat'
          ? plan.flat
          : plan.children.map((c) => ({
              text: c.text,
              sectionPath: c.sectionPath,
              page: c.page,
            }))
      contextBlurbs = (
        await maybeGenerateContextBlurbs({
          db,
          fileName: file.name,
          docPreview: text.slice(0, 2000),
          chunks: targets,
        })
      ).map(stripNul)
    }

    // ── Embed + write ─────────────────────────────────────────────────
    await transition('embedding')
    const embedder = buildEmbedder(embedProvider)
    // Per-batch progress emitter — gives the Library page a live
    // "embedding 12 / 45" line instead of just an "embedding" pill.
    const chunksTotal =
      plan.mode === 'flat' ? plan.flat.length : plan.children.length
    const onEmbedBatch = async (chunksDone: number): Promise<void> => {
      await emit('knowledge.ingest.progress', {
        fileId,
        step: 'embedding',
        chunksDone,
        chunksTotal,
      } satisfies KnowledgeIngestProgressPayload)
    }
    if (plan.mode === 'flat') {
      await embedAndStore({
        db,
        fileId,
        chunks: plan.flat,
        contextBlurbs,
        embedder,
        embeddingModel: fingerprint,
        onBatch: onEmbedBatch,
      })
    } else {
      await embedAndStoreHierarchical({
        db,
        fileId,
        parents: plan.parents,
        children: plan.children,
        contextBlurbs,
        embedder,
        embeddingModel: fingerprint,
        onBatch: onEmbedBatch,
      })
    }

    // ── Auto-describe (best-effort) ────────────────────────────────────
    await transition('describing')
    const description = await tryAutoDescribe({
      db,
      file,
      extractedText: text,
    })
    if (description) {
      await db.db
        .update(schema.files)
        .set({ description: stripNul(description) })
        .where(eq(schema.files.id, fileId))
    }

    await setStatus(db, fileId, 'ready')
    // ── Done ───────────────────────────────────────────────────────────
    // Read back the chunk count so the .ok payload matches reality even
    // after a partial resume (chunks_done was advanced batch-by-batch).
    const [doneRow] = await db.db
      .select({
        chunksDone: schema.files.chunksDone,
        pageCount: schema.files.pageCount,
      })
      .from(schema.files)
      .where(eq(schema.files.id, fileId))
      .limit(1)
    await emit('knowledge.ingest.ok', {
      fileId,
      durationMs: Date.now() - startedAt,
      chunkCount: doneRow?.chunksDone ?? 0,
      pageCount: doneRow?.pageCount ?? null,
    } satisfies KnowledgeIngestOkPayload)
  } catch (err) {
    await fail(formatIngestError(err))
  }
}

/**
 * Pull useful diagnostic detail out of upstream errors before we
 * persist them onto `files.ingest_error`. The AI SDK throws
 * `APICallError` with the upstream status code + response body
 * attached, but the bare `err.message` is just "Invalid JSON response"
 * / "API call failed" etc. — useless for figuring out WHY the
 * embedder choked. Pull the extras (status, response body tail, url)
 * into the user-facing string so the operator can see what their
 * llama.cpp / hosted embedder actually returned.
 */
function formatIngestError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const base = err.message || 'Ingest failed'
  // Duck-type the AI SDK's APICallError shape rather than importing
  // the type — keeps the agents package free of an explicit dep on
  // `@ai-sdk/provider`. The fields are stable across the SDK's
  // 1.x and 2.x lines (used by the embedder + reranker paths).
  const e = err as {
    statusCode?: unknown
    url?: unknown
    responseBody?: unknown
    cause?: unknown
  }
  const parts: string[] = [base]
  if (typeof e.statusCode === 'number') parts.push(`status=${e.statusCode}`)
  if (typeof e.url === 'string') parts.push(`url=${e.url}`)
  if (typeof e.responseBody === 'string' && e.responseBody.length > 0) {
    parts.push(`body="${e.responseBody.slice(0, 400)}"`)
  }
  // For wrapped errors that aren't APICallError but carry a cause.
  if (e.cause instanceof Error && e.cause.message && e.cause.message !== base) {
    parts.push(`cause=${e.cause.message}`)
  }
  // Detect the most common misconfiguration: the embedder is returning
  // llama.cpp's native shape (top-level array with `"embedding":
  // [[...]]`) instead of the OpenAI-compatible shape (`{ "data":
  // [{ "embedding": [...] }] }`). Happens when the provider's baseUrl
  // omits `/v1`, so Mastra hits `/embeddings` (native) instead of
  // `/v1/embeddings` (OpenAI). Surface the fix instead of leaving the
  // operator to puzzle through "expected object, received array".
  if (looksLikeLlamaNativeEmbeddingShape(e)) {
    parts.push(
      'hint=embedder returned llama.cpp native shape; update the ' +
        'embedding provider baseUrl to end in /v1 so Mastra hits ' +
        '/v1/embeddings instead of /embeddings',
    )
  }
  return parts.join(' · ')
}

function looksLikeLlamaNativeEmbeddingShape(e: {
  url?: unknown
  responseBody?: unknown
}): boolean {
  const body = typeof e.responseBody === 'string' ? e.responseBody : ''
  if (!body) return false
  // Cheap pattern match — the native shape opens with `[{"index"` and
  // packs each embedding as a 2D array (`[[`). Both must be present
  // before we suggest the URL fix; one alone could be a coincidence.
  return body.startsWith('[{') && /"embedding"\s*:\s*\[\[/.test(body)
}

// ─── Extraction ──────────────────────────────────────────────────────────

interface ExtractedDocument {
  readonly text: string
  /** Non-null only for paginated kinds (PDF). Backfilled onto
   *  `files.page_count` by the caller. */
  readonly pageCount: number | null
}

async function extractText(file: FileRow): Promise<ExtractedDocument> {
  if (file.kind === 'pdf') return extractPdfText(file)
  const ext = file.kind === 'md' ? 'md' : 'txt'
  const path = knowledgeOriginalPath(file.id, ext)
  const buf = await readFile(path)
  return { text: buf.toString('utf8'), pageCount: null }
}

/**
 * Plain-text extraction via `pdf-parse` (2.x — class-based API; the
 * 1.x default-function form is gone). Strips repeating headers /
 * footers (lines that appear on ≥80% of pages) and standalone page
 * numbers before joining pages; these chrome lines were one of the
 * most-cited "trash in chunks" failure modes in the research synthesis
 * (`docs/knowledge-files.md` §Production learnings).
 *
 * Returns the page count alongside the cleaned text so the caller can
 * backfill `files.page_count`.
 *
 * Dynamic import: pdf-parse loads pdfjs-dist on first import, which
 * is a non-trivial cost. Consumers that never touch PDFs (most
 * agent-build paths) shouldn't pay it.
 */
async function extractPdfText(file: FileRow): Promise<ExtractedDocument> {
  const path = knowledgeOriginalPath(file.id, 'pdf')
  const buf = await readFile(path)
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buf })
  try {
    const result = await parser.getText()
    const pages = result.pages ?? []
    const cleaned = stripPdfChrome(pages.map((p) => p.text ?? ''))
    return {
      text: cleaned,
      pageCount: pages.length || null,
    }
  } finally {
    await parser.destroy().catch(() => {
      // Swallow — pdf-parse's internal worker teardown can be racy;
      // a failed destroy doesn't affect the extracted text we already
      // returned. The pdfjs library logs its own warnings.
    })
  }
}

/**
 * Strip repeating page chrome (headers, footers, watermarks, page
 * numbers) and join pages with paragraph breaks. The heuristic:
 *
 *   - A short line (≤80 chars after trim) that appears on ≥80% of
 *     pages is "chrome" and removed.
 *   - Lines that are JUST a page number (`12`, `Page 3 of 8`,
 *     `iv`) anywhere are removed.
 *
 * The 80% threshold is conservative on purpose — a short repeating
 * footer like "Confidential" appears every page (100%); a section
 * heading "Lipid panel" might appear on 2-3 pages of an 8-page doc
 * (25-40%) and stays in. Below the threshold we err toward keeping
 * the line.
 *
 * Pages don't need to be returned individually — the chunker treats
 * the joined string as one document; chunk-level page numbers are
 * NOT preserved in v1 (they'd require per-line page tracking which
 * pdf-parse doesn't expose cleanly). Page numbers on chunks land in
 * Phase 4 via layout-aware extraction.
 */
function stripPdfChrome(pages: ReadonlyArray<string>): string {
  if (pages.length === 0) return ''
  if (pages.length === 1) {
    // No "repeating" to detect; just kill page-number lines.
    return removePageNumberLines(pages[0] ?? '')
  }
  const SHORT_LINE_CHARS = 80
  const REPEAT_THRESHOLD = 0.8

  const perPageLines = pages.map((p) =>
    (p ?? '').split(/\r?\n/).map((l) => l.trim()),
  )
  // Count occurrences of each "short" line across pages. We count a
  // line at most once per page (a footer printed twice on one page
  // counts once toward repetition).
  const occurrences = new Map<string, number>()
  for (const lines of perPageLines) {
    const seenThisPage = new Set<string>()
    for (const line of lines) {
      if (line.length === 0 || line.length > SHORT_LINE_CHARS) continue
      if (seenThisPage.has(line)) continue
      seenThisPage.add(line)
      occurrences.set(line, (occurrences.get(line) ?? 0) + 1)
    }
  }
  const chromeLines = new Set<string>()
  const minOccurrences = Math.ceil(pages.length * REPEAT_THRESHOLD)
  for (const [line, count] of occurrences) {
    if (count >= minOccurrences) chromeLines.add(line)
  }

  const cleanedPages = perPageLines.map((lines) =>
    lines
      .filter(
        (line) =>
          line.length > 0 && !chromeLines.has(line) && !isPageNumberLine(line),
      )
      .join('\n'),
  )
  return cleanedPages.filter((p) => p.length > 0).join('\n\n')
}

function removePageNumberLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isPageNumberLine(line.trim()))
    .join('\n')
}

function isPageNumberLine(line: string): boolean {
  if (line.length === 0 || line.length > 30) return false
  // Bare digit ("12") or "Page X" / "Page X of Y" patterns. Also
  // catches roman numerals up to a handful of letters ("iv", "xiii").
  if (/^\d+$/.test(line)) return true
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(line)) return true
  if (/^[ivxlcdm]+$/i.test(line) && line.length <= 6) return true
  return false
}

// ─── Chunking ────────────────────────────────────────────────────────────

interface RawChunk {
  /** The chunk body (what the LLM sees as a citation snippet). */
  readonly text: string
  /** Heading trail at the point this chunk was emitted, e.g. "Intro > Setup". */
  readonly sectionPath: string | null
  /** Always null for v1 (PDF lands in Phase 2). */
  readonly page: number | null
}

/** Output of the chunker. In flat mode, only `flat` is populated.
 *  In hierarchical mode (Phase 3, see `docs/knowledge-files.md`),
 *  `parents` carries large parent chunks (no embedding) and `children`
 *  carries small chunks that point at their parent via `parentIdx`. */
interface ChunkPlan {
  readonly mode: 'flat' | 'hierarchical'
  readonly flat: ReadonlyArray<RawChunk>
  readonly parents: ReadonlyArray<RawChunk>
  /** `parentIdx` indexes into `parents` and gets resolved to the
   *  actual `file_chunks.id` after the parent rows are inserted. */
  readonly children: ReadonlyArray<RawChunk & { readonly parentIdx: number }>
}

const EMPTY_PLAN: ChunkPlan = {
  mode: 'flat',
  flat: [],
  parents: [],
  children: [],
}

/**
 * Section-aware chunker. For markdown, splits on `#` headings and
 * tracks the heading stack so each chunk carries its path. For plain
 * text, treats blank-line-separated paragraphs as the only boundary.
 *
 * Token budget is approximated by chars/4 — close enough for the
 * cap; we don't tokenize per chunk because the ingest hot path
 * shouldn't pay for it. Hard cap CHUNK_CHAR_TARGET, with a softer
 * "stop if a section ends" preference.
 *
 * For hierarchical mode (Phase 3), first runs the flat chunker at
 * the CHILD size (~400 tokens) to produce small leaves, then groups
 * consecutive leaves into PARENT chunks until the parent reaches
 * its target (~1500 tokens). Children store their parent index so
 * the ingest pipeline can stitch up `file_chunks.parent_id` after
 * inserting parents.
 */
function chunkDocument(input: {
  text: string
  kind: string
  fileName: string
  mode: 'flat' | 'hierarchical'
}): ChunkPlan {
  const { text, kind, mode } = input
  const flat = kind === 'md' ? chunkMarkdown(text) : chunkPlainText(text)
  if (mode === 'flat') {
    return { mode: 'flat', flat, parents: [], children: [] }
  }
  return hierarchicalize(flat)
}

/**
 * Group consecutive flat chunks into parent buckets until each
 * parent reaches the parent-size target. Children are the original
 * flat chunks, re-pointed at their parent index. The parent's text
 * is the concatenation of its children (so retrieval expansion
 * returns the full surrounding context, not just the matched
 * sentence).
 *
 * Section-path inheritance: a parent's section_path is the LONGEST
 * common prefix of its children's section_paths. If children come
 * from different sections, the parent's path is the closest shared
 * ancestor (often null). The child's own section_path stays, so
 * citations remain precise.
 */
function hierarchicalize(flat: ReadonlyArray<RawChunk>): ChunkPlan {
  if (flat.length === 0) return EMPTY_PLAN
  const PARENT_CHAR_TARGET = 6000 // ≈1500 tokens
  const parents: RawChunk[] = []
  const children: Array<RawChunk & { parentIdx: number }> = []
  let bucket: RawChunk[] = []
  let bucketLen = 0
  const flushBucket = (): void => {
    if (bucket.length === 0) return
    const parentIdx = parents.length
    const parentText = bucket.map((c) => c.text).join('\n\n')
    parents.push({
      text: parentText,
      sectionPath: commonSectionAncestor(bucket),
      page: bucket[0]?.page ?? null,
    })
    for (const c of bucket) {
      children.push({ ...c, parentIdx })
    }
    bucket = []
    bucketLen = 0
  }
  for (const c of flat) {
    const projected = bucketLen + c.text.length
    if (bucket.length > 0 && projected > PARENT_CHAR_TARGET) {
      flushBucket()
    }
    bucket.push(c)
    bucketLen += c.text.length
  }
  flushBucket()
  return { mode: 'hierarchical', flat: [], parents, children }
}

function commonSectionAncestor(bucket: ReadonlyArray<RawChunk>): string | null {
  const paths = bucket
    .map((c) => c.sectionPath)
    .filter((p): p is string => p !== null && p.length > 0)
  if (paths.length === 0) return null
  if (paths.length === 1) return paths[0]!
  const first = paths[0]!.split(' > ')
  const common: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (paths.every((p) => p.split(' > ')[i] === seg)) {
      common.push(seg!)
    } else {
      break
    }
  }
  return common.length > 0 ? common.join(' > ') : null
}

/** ~800 tokens at the gpt tokenizer; close enough across embedders. */
const CHUNK_CHAR_TARGET = 3200
/** Hard cap so a single paragraph that's bigger than the target still
 *  gets split, just not section-aware. */
const CHUNK_CHAR_HARD_MAX = 5000
/** Skip emitting chunks shorter than this — they're usually noise
 *  (a stray heading with no body, a one-word paragraph). */
const CHUNK_CHAR_MIN = 80

function chunkMarkdown(source: string): RawChunk[] {
  const out: RawChunk[] = []
  const lines = source.split(/\r?\n/)
  // Heading stack: index = level - 1. Strings populate up to the
  // deepest seen level; deeper-level headings pop later.
  const stack: string[] = []
  let buffer = ''
  let bufferSection: string | null = null

  const flush = (): void => {
    const trimmed = buffer.trim()
    if (trimmed.length >= CHUNK_CHAR_MIN) {
      out.push({
        text: trimmed,
        sectionPath: bufferSection,
        page: null,
      })
    }
    buffer = ''
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      // Heading boundary — flush previous section's accumulated body
      // before updating the heading stack.
      flush()
      const level = (headingMatch[1] ?? '#').length
      const title = (headingMatch[2] ?? '').trim()
      stack.length = level - 1
      stack.push(title)
      bufferSection = stack.filter((s) => s.length > 0).join(' > ') || null
      continue
    }
    // Body line. If appending would push past the hard cap, force
    // a flush so the chunk stays bounded even mid-paragraph.
    if (buffer.length + line.length + 1 > CHUNK_CHAR_HARD_MAX) {
      flush()
    }
    buffer += (buffer.length > 0 ? '\n' : '') + line
    // Soft target: at a paragraph boundary (blank line) past the
    // target, emit early so chunks stay near the target size.
    if (buffer.length >= CHUNK_CHAR_TARGET && /\n\s*\n$/.test(buffer)) {
      flush()
    }
  }
  flush()
  return out
}

function chunkPlainText(source: string): RawChunk[] {
  const out: RawChunk[] = []
  const paragraphs = source.split(/\r?\n\s*\r?\n+/)
  let buffer = ''
  const flush = (): void => {
    const trimmed = buffer.trim()
    if (trimmed.length >= CHUNK_CHAR_MIN) {
      out.push({ text: trimmed, sectionPath: null, page: null })
    }
    buffer = ''
  }
  for (const p of paragraphs) {
    const piece = p.trim()
    if (!piece) continue
    if (buffer.length + piece.length + 2 > CHUNK_CHAR_HARD_MAX) flush()
    buffer += (buffer.length > 0 ? '\n\n' : '') + piece
    if (buffer.length >= CHUNK_CHAR_TARGET) flush()
  }
  flush()
  return out
}

// ─── Embedding ──────────────────────────────────────────────────────────

type LlmProviderRow = typeof schema.llmProviders.$inferSelect

function buildEmbedder(provider: LlmProviderRow): ModelRouterEmbeddingModel {
  const apiKey = provider.apiKeyEnvelope
    ? decryptSecret(provider.apiKeyEnvelope)
    : undefined
  return new ModelRouterEmbeddingModel({
    providerId: provider.kind,
    modelId: provider.defaultModel!,
    // `resolveBaseUrl` strips trailing slashes and auto-appends `/v1`
    // if missing so we hit `/v1/embeddings` (OpenAI shape) instead of
    // `/embeddings` (llama.cpp native shape). Without this a provider
    // stored as `http://127.0.0.1:8081` 404-equivalents into a parse
    // error because the native endpoint returns `[{"embedding":[[...]]}]`
    // and the AI SDK expects `{"data":[{"embedding":[...]}]}`. Same
    // rule the gitnexus mount + build-agent's chat model apply — keep
    // these in lockstep so one provider row works everywhere.
    url: resolveBaseUrl(provider.kind, provider.baseUrl),
    ...(apiKey ? { apiKey } : {}),
  })
}

function embeddingFingerprint(provider: LlmProviderRow): string {
  const dim = provider.embeddingDims ?? 1024
  return `${provider.kind}:${provider.defaultModel}:${dim}`
}

/**
 * Embed each chunk in mini-batches; insert into `file_chunks`.
 * Resumability: the loop checks `files.chunks_done` and skips the
 * leading chunks already written. Insert rows in the order of the
 * chunks array so `chunk_index` matches position.
 */
async function embedAndStore(args: {
  db: AgentBridgeDb
  fileId: string
  chunks: ReadonlyArray<RawChunk>
  /** Contextual Retrieval blurbs, one per chunk. Empty array when
   *  the feature is disabled (default). When populated, each blurb
   *  is prepended to its chunk's embedding INPUT and stored on
   *  `file_chunks.context_blurb`. */
  contextBlurbs: ReadonlyArray<string>
  embedder: ModelRouterEmbeddingModel
  embeddingModel: string
  /** Called once after each batch lands in the DB, with the cumulative
   *  `chunksDone` count. Used to fan out `knowledge.ingest.progress`
   *  events with embedding sub-step progress. Optional — defaults to
   *  a no-op so smoke tests and direct callers stay quiet. */
  onBatch?: (chunksDone: number) => Promise<void> | void
}): Promise<void> {
  const {
    db,
    fileId,
    chunks,
    contextBlurbs,
    embedder,
    embeddingModel,
    onBatch,
  } = args

  const [file] = await db.db
    .select({ chunksDone: schema.files.chunksDone, name: schema.files.name })
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  const start = file?.chunksDone ?? 0
  const fileName = file?.name ?? ''

  const BATCH = 16
  // Track the last embedded chunk's tail across batch boundaries so
  // the first chunk in batch N+1 still gets continuity context from
  // the last chunk of batch N. Empty on resume (first batch after a
  // crash starts fresh; missing tail context for one chunk is fine).
  let prevTail = ''
  let prevSectionPath: string | null = null
  for (let i = start; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH)
    const sliceBlurbs = slice.map((_, idx) => contextBlurbs[i + idx] ?? '')
    // Prefix each chunk's embedding input with the file name +
    // section path + (optional) Contextual Retrieval blurb +
    // (optional) prior chunk's tail when the section path matches.
    // The chunk's literal text becomes the cited snippet; the prefix
    // only influences retrieval.
    const inputs = slice.map((c, j) => {
      // Continuity context: tail of the chunk immediately before this
      // one (across batches), but only when the section path matches
      // — crossing a section boundary would inject misleading prefix.
      const prevForThis = j === 0 ? prevTail : tailOf(slice[j - 1]!.text)
      const prevSection = j === 0 ? prevSectionPath : slice[j - 1]!.sectionPath
      const continuity =
        prevForThis && prevSection === c.sectionPath ? prevForThis : ''
      return buildEmbedInput(fileName, c, sliceBlurbs[j] ?? '', continuity)
    })
    const embedResult = await embedder.doEmbed({ values: inputs })
    const vectors = embedResult.embeddings
    if (vectors.length !== slice.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${slice.length} inputs`,
      )
    }

    await db.db.insert(schema.fileChunks).values(
      slice.map((chunk, j) => ({
        fileId,
        chunkIndex: i + j,
        page: chunk.page,
        sectionPath: chunk.sectionPath,
        text: chunk.text,
        contextBlurb: sliceBlurbs[j] || null,
        embeddingModel,
        embedding: vectors[j],
      })),
    )

    const cumulativeDone = i + slice.length
    await db.db
      .update(schema.files)
      .set({ chunksDone: cumulativeDone })
      .where(eq(schema.files.id, fileId))
    if (onBatch) await onBatch(cumulativeDone)

    // Advance the cross-batch continuity carry. Last chunk in this
    // batch becomes the prev-tail for the first chunk of the next.
    const last = slice[slice.length - 1]
    if (last) {
      prevTail = tailOf(last.text)
      prevSectionPath = last.sectionPath
    }
  }
}

/**
 * Last `n` characters of a chunk's text, used as continuity context
 * prepended to the NEXT chunk's embedding input when the section path
 * matches. Borrowed from gitnexus's text-generator (it appends ~120
 * chars of preceding code; same idea, applied to prose).
 *
 * Conservative cap: short enough that even when the continuity is
 * mildly off (e.g. across a paragraph break), the chunk's own ~800
 * tokens still dominate the embedding signal.
 */
function tailOf(text: string, n = 120): string {
  if (text.length <= n) return text
  const slice = text.slice(-n)
  // Snap to a word boundary so we don't begin mid-word.
  const firstSpace = slice.indexOf(' ')
  return firstSpace > 0 && firstSpace < n * 0.3
    ? slice.slice(firstSpace + 1)
    : slice
}

function buildEmbedInput(
  fileName: string,
  chunk: RawChunk,
  contextBlurb: string = '',
  precedingTail: string = '',
): string {
  const sectionLine = chunk.sectionPath ? `${chunk.sectionPath}\n` : ''
  const blurbLine = contextBlurb ? `${contextBlurb}\n\n` : ''
  const precedingLine = precedingTail
    ? `[Preceding context]: ${precedingTail}\n\n`
    : ''
  return `${fileName}\n${sectionLine}${blurbLine}${precedingLine}${chunk.text}`
}

/**
 * Hierarchical store path. Insert parent rows first (no embedding —
 * they're retrieval expansion targets, not search targets), capture
 * their ids, then embed + insert children with `parent_id` set to
 * the matched parent's id.
 *
 * Resumability: `chunks_done` tracks only CHILDREN (the parents are
 * tiny relative to the embedding work). The counter advances after
 * each child batch finishes embedding, so a partial failure resumes
 * from the right child offset. Re-ingest must re-run from scratch
 * if the parents were already inserted; we DELETE all chunks at the
 * top of re-ingest in the routes layer anyway, so this is fine.
 */
async function embedAndStoreHierarchical(args: {
  db: AgentBridgeDb
  fileId: string
  parents: ReadonlyArray<RawChunk>
  children: ReadonlyArray<RawChunk & { parentIdx: number }>
  /** One blurb per CHILD (parents aren't embedded so don't need
   *  blurbs). Empty array when Contextual Retrieval is disabled. */
  contextBlurbs: ReadonlyArray<string>
  embedder: ModelRouterEmbeddingModel
  embeddingModel: string
  /** See `embedAndStore.onBatch`. Called once per CHILD batch with the
   *  cumulative children-done count. */
  onBatch?: (chunksDone: number) => Promise<void> | void
}): Promise<void> {
  const {
    db,
    fileId,
    parents,
    children,
    contextBlurbs,
    embedder,
    embeddingModel,
    onBatch,
  } = args

  const [fileRow] = await db.db
    .select({
      chunksDone: schema.files.chunksDone,
      name: schema.files.name,
    })
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  const start = fileRow?.chunksDone ?? 0
  const fileName = fileRow?.name ?? ''

  // Insert parents (idempotent-ish via chunks_done > 0 check — if
  // resuming mid-children, parents are already in the table).
  let parentIds: string[]
  if (start === 0) {
    const inserted = await db.db
      .insert(schema.fileChunks)
      .values(
        parents.map((p, idx) => ({
          fileId,
          chunkIndex: idx,
          page: p.page,
          sectionPath: p.sectionPath,
          text: p.text,
          embeddingModel,
          // embedding stays null — parents aren't searched directly.
        })),
      )
      .returning({ id: schema.fileChunks.id })
    parentIds = inserted.map((r) => r.id)
  } else {
    // Resume: load existing parent ids by file + chunk_index < parents.length.
    const existing = await db.db
      .select({
        id: schema.fileChunks.id,
        chunkIndex: schema.fileChunks.chunkIndex,
      })
      .from(schema.fileChunks)
      .where(eq(schema.fileChunks.fileId, fileId))
    parentIds = existing
      .filter((r) => r.chunkIndex < parents.length)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((r) => r.id)
  }
  if (parentIds.length !== parents.length) {
    throw new Error(
      `hierarchical ingest: expected ${parents.length} parent rows, found ${parentIds.length}`,
    )
  }

  // Embed + insert children in BATCH_SIZE batches.
  const BATCH = 16
  let prevTail = ''
  let prevSectionPath: string | null = null
  let prevParentIdx: number | null = null
  for (let i = start; i < children.length; i += BATCH) {
    const slice = children.slice(i, i + BATCH)
    const sliceBlurbs = slice.map((_, idx) => contextBlurbs[i + idx] ?? '')
    const inputs = slice.map((c, j) => {
      // Continuity context for hierarchical mode: only carry across
      // children that share BOTH section path AND parent. The
      // parent-bucket boundary is a stronger semantic break than a
      // mere paragraph and pre-tail across it would mislead the
      // embedder.
      const prevForThis = j === 0 ? prevTail : tailOf(slice[j - 1]!.text)
      const prevSection = j === 0 ? prevSectionPath : slice[j - 1]!.sectionPath
      const prevParent = j === 0 ? prevParentIdx : slice[j - 1]!.parentIdx
      const continuity =
        prevForThis &&
        prevSection === c.sectionPath &&
        prevParent === c.parentIdx
          ? prevForThis
          : ''
      return buildEmbedInput(fileName, c, sliceBlurbs[j] ?? '', continuity)
    })
    const result = await embedder.doEmbed({ values: inputs })
    const vectors = result.embeddings
    if (vectors.length !== slice.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${slice.length} inputs`,
      )
    }
    await db.db.insert(schema.fileChunks).values(
      slice.map((child, j) => {
        const parentId = parentIds[child.parentIdx]
        if (!parentId) {
          throw new Error(
            `hierarchical ingest: missing parent id for child ${child.parentIdx}`,
          )
        }
        return {
          fileId,
          parentId,
          chunkIndex: parents.length + i + j,
          page: child.page,
          sectionPath: child.sectionPath,
          text: child.text,
          contextBlurb: sliceBlurbs[j] || null,
          embeddingModel,
          embedding: vectors[j],
        }
      }),
    )
    const cumulativeDone = i + slice.length
    await db.db
      .update(schema.files)
      .set({ chunksDone: cumulativeDone })
      .where(eq(schema.files.id, fileId))
    if (onBatch) await onBatch(cumulativeDone)

    // Advance cross-batch continuity carry for the hierarchical path.
    const last = slice[slice.length - 1]
    if (last) {
      prevTail = tailOf(last.text)
      prevSectionPath = last.sectionPath
      prevParentIdx = last.parentIdx
    }
  }
}

// ─── Auto-describe ──────────────────────────────────────────────────────

/**
 * One LLM call against the workspace's first chat-role provider that
 * produces a 2-3 sentence file description. Best-effort: returns
 * `null` if there's no chat provider, the call fails, or the response
 * is empty. The file still goes to `ready` either way — operators can
 * fill in the description manually.
 *
 * Picks the first chat-role `LlmProvider` by `created_at` to keep the
 * selection stable. A future enhancement would let the operator pin a
 * "utility model" workspace setting (see docs/knowledge-files.md §
 * Utility model).
 */
async function tryAutoDescribe(args: {
  db: AgentBridgeDb
  file: FileRow
  extractedText: string
}): Promise<string | null> {
  const { db, file, extractedText } = args
  // Pick the oldest chat provider — deterministic across ingests so
  // a workspace with multiple chat providers doesn't flip-flop which
  // model generates file descriptions. Stable choice until the
  // operator pins one explicitly (`utility_chat_provider_id` open Q
  // in docs/knowledge-files.md).
  const [chatProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'chat'))
    .orderBy(asc(schema.llmProviders.createdAt))
    .limit(1)
  if (!chatProvider || !chatProvider.defaultModel) return null

  const apiKey = chatProvider.apiKeyEnvelope
    ? decryptSecret(chatProvider.apiKeyEnvelope)
    : undefined
  const modelConfig: MastraModelConfig = {
    providerId: chatProvider.kind,
    modelId: chatProvider.defaultModel,
    // Same /v1 auto-append rule as buildEmbedder — chat endpoints land
    // on `/v1/chat/completions`; without normalization a baseUrl that
    // omits `/v1` would hit `/chat/completions` and 404.
    url: resolveBaseUrl(chatProvider.kind, chatProvider.baseUrl),
    ...(apiKey ? { apiKey } : {}),
  }

  // Tools-less, memoryless sibling — same pattern `inspector/expand.ts`
  // uses. Empty instructions; we hand the full task on the prompt.
  const agent = new Agent({
    id: `file-describer:${file.id}`,
    name: 'file-describer',
    description:
      'Generates a short description for an uploaded knowledge file.',
    instructions: '',
    model: modelConfig,
  })

  // Cap the text we feed in. Embedder limits are usually higher than
  // chat context, but a 50 MB file would be wasteful and would
  // dominate the prompt; the first ~3000 chars + headings are plenty
  // for a 2-3 sentence summary.
  const head = extractedText.slice(0, 3000)
  const prompt = `Write a concise 2-3 sentence description of the document below. Cover what topic it concerns, what shape it takes (report, contract, manual, notes, etc.), and the most useful keywords a reader would search for. No quotes, no preamble — just the description.

DOCUMENT NAME: ${file.name}
DOCUMENT CONTENT (truncated):
${head}`

  try {
    const result = await agent.generate(prompt, {})
    const text = (result.text ?? '').trim()
    if (!text) return null
    // Single line, modest cap. Multi-paragraph descriptions waste
    // catalog tokens (see FILE_DESCRIPTION_MAX in shared dtos).
    const oneLine = text.replace(/\s+/g, ' ').slice(0, 500)
    return oneLine
  } catch (err) {
    console.warn(
      `[knowledge-ingest] auto-describe failed for ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

// ─── Contextual Retrieval ───────────────────────────────────────────────

/**
 * Generate one context blurb per chunk via the workspace utility
 * chat provider. Anthropic's "Contextual Retrieval" (linked from
 * `docs/knowledge-files.md`): the blurb is a 1-2 sentence summary of
 * WHERE THE CHUNK SITS IN THE DOC and what topic it covers. The
 * blurb is prepended to the embedding INPUT (not the stored text),
 * so the chunk's vector encodes document-level context the local
 * chunk text would miss.
 *
 * Cost reality: one LLM call per chunk. For a 5-chunk PDF that's
 * five short generation calls (~250 tokens each); for a 200-chunk
 * monster it's 200 calls. We don't parallelise to avoid hammering
 * the local llama.cpp instance — Anthropic's paper indicates a
 * sequential ingest pass produces nearly-identical retrieval gains
 * at lower load.
 *
 * Returns an empty array on any failure (no chat provider, LLM
 * call timeout, etc.). The caller treats empty as "feature off" —
 * embedding proceeds without blurbs.
 */
async function maybeGenerateContextBlurbs(args: {
  db: AgentBridgeDb
  fileName: string
  docPreview: string
  chunks: ReadonlyArray<{
    text: string
    sectionPath: string | null
    page: number | null
  }>
}): Promise<ReadonlyArray<string>> {
  const { db, fileName, docPreview, chunks } = args
  // Same oldest-first pick as `tryAutoDescribe` so an ingest's
  // describe step and its Contextual-Retrieval blurbs land on the
  // same chat provider.
  const [chatProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'chat'))
    .orderBy(asc(schema.llmProviders.createdAt))
    .limit(1)
  if (!chatProvider || !chatProvider.defaultModel) {
    console.warn(
      '[knowledge-ingest] AGENT_BRIDGE_CONTEXTUAL_RETRIEVAL=true but no chat ' +
        'provider configured; skipping per-chunk blurb generation.',
    )
    return []
  }

  const apiKey = chatProvider.apiKeyEnvelope
    ? decryptSecret(chatProvider.apiKeyEnvelope)
    : undefined
  const modelConfig: MastraModelConfig = {
    providerId: chatProvider.kind,
    modelId: chatProvider.defaultModel,
    // Same /v1 auto-append rule as buildEmbedder — chat endpoints land
    // on `/v1/chat/completions`; without normalization a baseUrl that
    // omits `/v1` would hit `/chat/completions` and 404.
    url: resolveBaseUrl(chatProvider.kind, chatProvider.baseUrl),
    ...(apiKey ? { apiKey } : {}),
  }
  const agent = new Agent({
    id: 'knowledge-context',
    name: 'knowledge-context',
    description: 'Per-chunk context-blurb generator for Contextual Retrieval.',
    instructions: '',
    model: modelConfig,
  })

  const blurbs: string[] = []
  for (const chunk of chunks) {
    const sectionLine = chunk.sectionPath
      ? `Section: ${chunk.sectionPath}\n`
      : ''
    const pageLine = chunk.page != null ? `Page: ${chunk.page}\n` : ''
    const prompt = `Document title: ${fileName}

Document preview (first ~2000 chars for context):
"""
${docPreview}
"""

Now consider this specific passage from the document.
${sectionLine}${pageLine}
"""
${chunk.text.slice(0, 1500)}
"""

Write 1-2 short sentences (max 200 chars total) describing where this passage sits in the document and what topic it covers. No preamble, no quotes — just the description, plain text.`
    try {
      const result = await agent.generate(prompt, {})
      const text = (result.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
      blurbs.push(text)
    } catch (err) {
      console.warn(
        `[knowledge-ingest] context blurb failed for chunk; skipping: ${err instanceof Error ? err.message : String(err)}`,
      )
      blurbs.push('')
    }
  }
  return blurbs
}

// ─── Telemetry emit ─────────────────────────────────────────────────────

/**
 * Build a single sink that wraps the caller's optional `publish`
 * thunk. Stamps `streamId = file:<id>` and the current timestamp,
 * swallows publish errors (telemetry must never take down an ingest),
 * and mirrors to stderr so operators running the backend in the
 * terminal see ingest progress without subscribing to the SSE stream.
 *
 * Returns a no-op when `publish` is undefined (smoke tests, direct
 * library callers).
 */
function makeIngestEmit(
  fileId: string,
  publish: IngestKnowledgeFileInput['publish'],
): (
  kind:
    | 'knowledge.ingest.started'
    | 'knowledge.ingest.progress'
    | 'knowledge.ingest.ok'
    | 'knowledge.ingest.fail',
  data: unknown,
) => Promise<void> {
  return async (kind, data) => {
    // Always log a one-liner — useful when running the backend in dev
    // without the SSE stream open.
    try {
      console.log(`[knowledge-ingest] ${kind} file=${fileId}`, data ?? '')
    } catch {
      /* console errors aren't worth crashing for */
    }
    if (!publish) return
    const event: RunEvent = {
      kind,
      ts: Date.now(),
      streamId: fileStreamId(fileId),
      data,
    }
    try {
      await publish(event)
    } catch (err) {
      console.warn(`[knowledge-ingest] publish ${kind} failed:`, err)
    }
  }
}

// ─── Status helpers ─────────────────────────────────────────────────────

/**
 * Strip NUL (U+0000) before any text is persisted to Postgres. `text` /
 * `varchar` columns reject 0x00 ("invalid byte sequence for encoding
 * UTF8: 0x00"); it carries no meaning in document text and only shows up
 * as binary noise from malformed PDFs / OCR output. Left unstripped it
 * aborts the chunk insert — and then the error-recording write too.
 */
function stripNul(value: string): string {
  return value.replace(/\0/g, '')
}

async function setStatus(
  db: AgentBridgeDb,
  fileId: string,
  status: 'extracting' | 'chunking' | 'embedding' | 'describing' | 'ready',
): Promise<void> {
  await db.db
    .update(schema.files)
    .set({ ingestStatus: status, ingestError: null })
    .where(eq(schema.files.id, fileId))
}

async function markError(
  db: AgentBridgeDb,
  fileId: string,
  message: string,
): Promise<void> {
  await db.db
    .update(schema.files)
    .set({ ingestStatus: 'error', ingestError: stripNul(message) })
    .where(eq(schema.files.id, fileId))
}

// ─── Concurrency semaphore ──────────────────────────────────────────────
//
// Tiny FIFO semaphore so we don't ship a dependency just for this. N
// permits, FIFO waiters. `acquire()` blocks until a permit is free;
// `release()` grants it to the next waiter (or returns it to the
// pool). Crash safety: we always `release()` in a `finally`, so even
// a synchronous throw inside the pipeline can't leak a permit.

class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []
  constructor(permits: number) {
    this.permits = Math.max(1, permits)
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Hand the permit straight to the next waiter — don't increment
      // permits, that would let a fresh acquire() race ahead.
      next()
    } else {
      this.permits += 1
    }
  }
}

const INGEST_CONCURRENCY = (() => {
  const env = process.env['AGENT_BRIDGE_INGEST_CONCURRENCY']
  const n = env ? parseInt(env, 10) : NaN
  return Number.isFinite(n) && n >= 1 ? n : 2
})()
const ingestSemaphore = new Semaphore(INGEST_CONCURRENCY)
