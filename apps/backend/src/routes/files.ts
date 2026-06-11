/**
 * `/api/files` — workspace-wide knowledge document CRUD.
 *
 * A file lives in three places: a row in `files`, bytes on disk under
 * `<dataDir>/knowledge/<id>/original.<ext>`, and (once ingested) chunk
 * rows in `file_chunks`. Per-agent and per-thread attachments are
 * managed elsewhere — see `agent-files.ts` and the thread cleanup
 * hook on `deleteAgentThread`.
 *
 * Lifecycle:
 *   1. POST /api/files — multipart upload. Hashes bytes (sha256),
 *      checks `files_content_hash_uq` for an existing row (dedup),
 *      writes bytes to disk, creates `files` row with
 *      `ingest_status='pending'`, kicks off `ingestFile(id)` in the
 *      background, returns the row immediately.
 *   2. Background `ingestFile` flips status through extracting →
 *      chunking → (contextualizing, when opted in) → embedding →
 *      describing → ready (or error). Wired in Slice C; in Slice B
 *      the call is a stub that does nothing.
 *   3. PATCH /api/files/:id — name / description edits only. Pipeline
 *      state is worker-owned.
 *   4. DELETE — cascades chunks via FK, removes attachment rows via
 *      FK, then `rm -rf` the file's storage dir.
 *   5. POST /api/files/:id/reingest — re-runs the pipeline from
 *      chunking (keeps cached `extracted.txt`). For when the
 *      embedding model or chunking config changes.
 *
 * Workspace-level events (file uploaded / deleted) are NOT recorded
 * in `agent_config_events` — that table is per-agent keyed. Per-agent
 * attach / detach IS audited in `agent-files.ts`.
 *
 * Design: see `docs/knowledge-files.md`.
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'

import { zValidator } from '@hono/zod-validator'
import { count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  FILE_KINDS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_WORKSPACE,
  fileItemParamSchema,
  fileUpdateInputSchema,
  type FileKind,
} from '@agent-bridge/shared'
import {
  knowledgeFileDir,
  knowledgeOriginalPath,
} from '@agent-bridge/shared/paths'
import { schema, type AgentBridgeDb } from '@agent-bridge/db'

type FileRow = typeof schema.files.$inferSelect
import {
  ingestKnowledgeFile,
  rebuildFileChunksAtDim,
} from '@agent-bridge/agents'
import type { RunEvent } from '@agent-bridge/shared'
import { getDb } from '../db.js'
import { getEventBus } from '../event-bus.js'
import { httpError, httpValidationError } from '../lib/errors.js'

import { toFileResponse } from '../lib/file-converter.js'

/**
 * Resolve the file extension from a filename. Returns the lowercase
 * extension without the leading dot, or `null` if there's no dot.
 * Used to derive `files.kind` from upload metadata.
 */
function extOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Map a normalised extension to one of our supported `FileKind`s.
 * v1 ships md/txt/pdf; DOCX (Phase 3) widens this further. Returns
 * `null` for unrecognised extensions — the upload route rejects
 * with a 415 in that case.
 */
function kindFromExt(ext: string | null): FileKind | null {
  if (!ext) return null
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'txt' || ext === 'text') return 'txt'
  if (ext === 'pdf') return 'pdf'
  return null
}

export const filesRouter = new Hono()
  // ─── POST /api/files ─────────────────────────────────────────────────────
  //
  // Multipart upload. We deliberately don't use the @hono/zod-validator on
  // the body — the parsed multipart shape is `File | string` values, which
  // doesn't fit a Zod schema cleanly. Hand-validate the few fields we care
  // about (file presence, kind, byte cap), and use `fileUploadMetaSchema`
  // on optional metadata fields.
  .post('/', async (c) => {
    const { db } = getDb()

    // Per-workspace file-count cap. Cheaper to check before we read the
    // upload bytes — saves shoving 50 MiB through the connection only
    // to bounce it at the end.
    const [{ value: total } = { value: 0 }] = await db
      .select({ value: count() })
      .from(schema.files)
    if (total >= MAX_FILES_PER_WORKSPACE) {
      return httpError(c, {
        code: 'validation_failed',
        message:
          `Workspace file cap reached (${MAX_FILES_PER_WORKSPACE}). ` +
          `Delete an existing file before uploading a new one.`,
      })
    }

    let form: Awaited<ReturnType<typeof c.req.parseBody>>
    try {
      form = await c.req.parseBody()
    } catch (err) {
      return httpError(c, {
        code: 'validation_failed',
        message:
          'Could not parse multipart form body. ' +
          (err instanceof Error ? err.message : ''),
      })
    }

    const fileField = form['file']
    if (!(fileField instanceof File)) {
      return httpError(c, {
        code: 'validation_failed',
        message: 'Missing multipart `file` field.',
      })
    }

    const filename = (fileField.name ?? '').trim() || 'untitled'
    const ext = extOf(filename)
    const kind = kindFromExt(ext)
    if (!kind) {
      return httpError(c, {
        code: 'validation_failed',
        message:
          `Unsupported file kind. Phase 1 accepts: ${FILE_KINDS.join(', ')}. ` +
          `(Got extension: ${ext ?? '(none)'}.)`,
      })
    }

    if (fileField.size > MAX_FILE_BYTES) {
      return httpError(c, {
        code: 'validation_failed',
        message: `File exceeds ${MAX_FILE_BYTES}-byte cap.`,
      })
    }

    // Read bytes once, compute hash, write to disk. The hash is the
    // workspace dedup key — same content uploaded twice surfaces the
    // existing row rather than re-ingesting.
    const arrayBuffer = await fileField.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const contentHash = createHash('sha256').update(buffer).digest('hex')

    const existing = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.contentHash, contentHash))
      .limit(1)
    if (existing[0]) {
      // Still honor the chat-scope attach for a deduped upload —
      // operator dragged it into THIS chat, even if a prior chat
      // already added it to the Library. Always non-ephemeral here:
      // the existing Library row predates this turn.
      const threadIdField =
        typeof form['threadId'] === 'string' ? form['threadId'].trim() : ''
      if (threadIdField.length > 0) {
        await db
          .insert(schema.threadFiles)
          .values({
            threadId: threadIdField,
            fileId: existing[0].id,
            ephemeral: false,
          })
          .onConflictDoNothing()
      }
      return c.json(
        {
          ok: true as const,
          file: toFileResponse(existing[0]),
          duplicate: true as const,
        },
        200,
      )
    }

    // Optional rename metadata. Empty / missing → use filename.
    const nameOverride =
      typeof form['name'] === 'string' && form['name'].trim()
        ? form['name'].trim()
        : null
    const displayName = nameOverride ?? filename

    // Contextual Retrieval opt-in from the upload toggle; persisted so
    // ingest and any later reingest pick it up.
    const contextualRetrieval = form['contextualRetrieval'] === 'true'

    // Allocate the row first so we have an `id` to thread into the
    // storage path. We do this BEFORE writing bytes so a partial
    // write (disk full, perms) doesn't leave us with on-disk bytes
    // and no row — the cleanup story is "no row ever existed".
    let row: FileRow | undefined
    try {
      const [inserted] = await db
        .insert(schema.files)
        .values({
          name: displayName,
          filename,
          kind,
          bytes: buffer.byteLength,
          contentHash,
          contextualRetrieval,
          // `storage_path` is NOT NULL; we UPDATE it to the real
          // resolved dir after we have the id. Using a sentinel
          // here is safe: ingest hasn't been scheduled yet, so no
          // other reader observes this row before the UPDATE.
          storagePath: 'pending',
        })
        .returning()
      row = inserted
    } catch (err) {
      return httpError(c, {
        code: 'internal',
        message: `insert failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    if (!row) {
      return httpError(c, {
        code: 'internal',
        message: 'insert returned no rows',
      })
    }

    const fileDir = knowledgeFileDir(row.id)
    const originalPath = knowledgeOriginalPath(row.id, ext ?? kind)

    try {
      await mkdir(fileDir, { recursive: true, mode: 0o700 })
      await writeFile(originalPath, buffer, { mode: 0o600 })
    } catch (err) {
      // Disk write failed — roll back the row so we don't leak a
      // pseudo-pending file. Cleanup is best-effort; if the row
      // delete also fails, the operator can re-upload (sha256 dedup
      // surfaces the existing row).
      await db.delete(schema.files).where(eq(schema.files.id, row.id))
      return httpError(c, {
        code: 'internal',
        message: `failed to write upload to disk: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    const [updated] = await db
      .update(schema.files)
      .set({ storagePath: fileDir })
      .where(eq(schema.files.id, row.id))
      .returning()

    if (!updated) {
      return httpError(c, {
        code: 'internal',
        message: 'storage_path update returned no rows',
      })
    }

    // Optional chat-scope attachment. The composer's drag-drop path
    // passes `threadId` (and `ephemeral=true` when the operator
    // unticks "save to library") so the file gets a `thread_files`
    // row at upload time, without a second round-trip. Ephemeral
    // attachments are GC'd by `deleteAgentThread` (see threads.ts).
    const threadIdField =
      typeof form['threadId'] === 'string' ? form['threadId'].trim() : ''
    const ephemeralField = form['ephemeral'] === 'true'
    if (threadIdField.length > 0) {
      try {
        await db
          .insert(schema.threadFiles)
          .values({
            threadId: threadIdField,
            fileId: updated.id,
            ephemeral: ephemeralField,
          })
          .onConflictDoNothing()
      } catch (err) {
        // Best-effort: the file is uploaded + ingest scheduled.
        // Failing the whole upload because the attach hiccupped is
        // worse than landing a row the operator can attach manually.
        console.warn(
          `[files] thread_files insert failed for ${updated.id} → thread ${threadIdField}:`,
          err,
        )
      }
    }

    // Kick off the ingest pipeline in the background. Errors during
    // ingest don't fail the upload — they land on
    // `files.ingest_status='error'`.
    void scheduleIngest(updated.id)

    return c.json(
      {
        ok: true as const,
        file: toFileResponse(updated),
        duplicate: false as const,
      },
      201,
    )
  })
  // ─── GET /api/files ──────────────────────────────────────────────────────
  .get('/', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select()
      .from(schema.files)
      .orderBy(desc(schema.files.createdAt))
    return c.json({
      ok: true as const,
      files: rows.map(toFileResponse),
    })
  })
  // ─── GET /api/files/:id ──────────────────────────────────────────────────
  .get(
    '/:id',
    zValidator('param', fileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()
      const [row] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, id))
        .limit(1)
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${id} not found`,
        })
      }
      const [{ chunkCount } = { chunkCount: 0 }] = await db
        .select({ chunkCount: count() })
        .from(schema.fileChunks)
        .where(eq(schema.fileChunks.fileId, id))
      return c.json({
        ok: true as const,
        file: toFileResponse(row),
        chunkCount: Number(chunkCount),
      })
    },
  )
  // ─── PATCH /api/files/:id ────────────────────────────────────────────────
  .patch(
    '/:id',
    zValidator('param', fileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', fileUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.files.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description
      // chunkingMode + contextualRetrieval changes only take effect on
      // the next reingest — existing chunks were built under the old
      // settings. The UI surfaces this via the confirm dialog before
      // flipping; we accept the patch unconditionally here and let the
      // operator trigger the reingest separately.
      if ('chunkingMode' in body) patch.chunkingMode = body.chunkingMode
      if ('contextualRetrieval' in body)
        patch.contextualRetrieval = body.contextualRetrieval

      const [row] = await db
        .update(schema.files)
        .set(patch)
        .where(eq(schema.files.id, id))
        .returning()
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${id} not found`,
        })
      }
      return c.json({ ok: true as const, file: toFileResponse(row) })
    },
  )
  // ─── DELETE /api/files/:id ───────────────────────────────────────────────
  .delete(
    '/:id',
    zValidator('param', fileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()
      const [row] = await db
        .delete(schema.files)
        .where(eq(schema.files.id, id))
        .returning({ id: schema.files.id, storagePath: schema.files.storagePath })
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${id} not found`,
        })
      }
      // Cascades clean up `file_chunks`, `agent_files`, `thread_files`
      // via FK ON DELETE CASCADE. We just need to remove the bytes.
      try {
        await rm(row.storagePath, { recursive: true, force: true })
      } catch (err) {
        // Disk cleanup failure isn't fatal — the row is gone, the
        // bytes are now orphaned but harmless. Log loudly so the
        // operator notices a leak.
        console.error(
          `[files] DB delete succeeded but disk cleanup failed for ${id}: ${err}`,
        )
      }
      return c.json({ ok: true as const, id: row.id })
    },
  )
  // ─── POST /api/files/:id/reingest ────────────────────────────────────────
  .post(
    '/:id/reingest',
    zValidator('param', fileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      // Clear chunks + reset pipeline state. The worker picks up
      // `pending` files; setting it here causes the next ingest tick
      // to re-process from chunking (cached `extracted.txt` is
      // reused — see Slice C). chunks_done resets to 0.
      const [row] = await db
        .update(schema.files)
        .set({
          ingestStatus: 'pending',
          ingestError: null,
          chunksDone: 0,
        })
        .where(eq(schema.files.id, id))
        .returning()
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${id} not found`,
        })
      }
      await db
        .delete(schema.fileChunks)
        .where(eq(schema.fileChunks.fileId, id))
      void scheduleIngest(row.id)
      return c.json({ ok: true as const, file: toFileResponse(row) })
    },
  )
  // ─── POST /api/files/re-embed-all ─────────────────────────────────────────
  //
  // Workspace-level "same dim, different model" recovery (Phase 3 of
  // `docs/knowledge-files.md`). Drops every chunk + re-queues every
  // file. The fingerprint check on `file_chunks.embedding_model` is
  // why this action exists: when an operator switches embedding
  // providers (e.g. text-embedding-3-small → bge-large-en, both
  // 1024-dim), retrieval silently refuses queries until the chunks
  // are re-embedded against the new model. This handler is the
  // explicit "yes, re-run everything" trigger.
  //
  // We re-run the FULL pipeline (extract → chunk → embed → describe)
  // rather than skipping ahead to the embed step. v1's
  // `ingestKnowledgeFile` doesn't have a skip-to-embed entry point;
  // for personal-scale corpora (≤500 files) the extra cost is
  // measured in minutes, not hours. Worth optimising later if the
  // pain shows up.
  .post('/re-embed-all', async (c) => {
    const { db } = getDb()
    const rows = await db
      .select({ id: schema.files.id })
      .from(schema.files)
    await db.delete(schema.fileChunks)
    if (rows.length > 0) {
      await db
        .update(schema.files)
        .set({
          ingestStatus: 'pending',
          ingestError: null,
          chunksDone: 0,
        })
    }
    for (const row of rows) {
      void scheduleIngest(row.id)
    }
    return c.json({ ok: true as const, queued: rows.length })
  })
  // ─── POST /api/files/rebuild-index ────────────────────────────────────────
  //
  // Workspace-level destructive rebuild. Same operation the embedding-
  // provider PATCH triggers when the operator confirms a model change
  // (alongside `wipeAllSemanticVectors`) — exposed here as a manual
  // escape hatch when the provider definition is unchanged but the
  // operator wants a clean re-embed (e.g. the upstream model was
  // updated in place by the provider, or the chunks got corrupted).
  //
  // Reads `provider.embeddingDims` as the source of truth (no
  // hard-coded dim). TRUNCATEs `file_chunks`, ALTERs the column type
  // to match, recreates the HNSW index, flips every `files` row to
  // `ingest_status='embedding'`, queues reingest. Retrieval refuses
  // via the fingerprint check until the new chunks land.
  .post('/rebuild-index', async (c) => {
    const handle = getDb()
    const { db } = handle
    const [provider] = await db
      .select()
      .from(schema.llmProviders)
      .where(eq(schema.llmProviders.role, 'embedding'))
      .limit(1)
    if (!provider) {
      return httpError(c, {
        code: 'validation_failed',
        message:
          'no embedding provider configured — add one under Library → Providers (role: embedding) before rebuilding',
      })
    }
    if (provider.embeddingDims == null) {
      return httpError(c, {
        code: 'validation_failed',
        message:
          'embedding provider does not report a `embeddingDims` value — set it under Library → Providers before rebuilding',
      })
    }
    const result = await rebuildFileChunksAndQueueReingest(
      handle,
      provider.embeddingDims,
    )
    return c.json({ ok: true as const, ...result })
  })

export type FilesRouter = typeof filesRouter

// ─── Ingest scheduling ────────────────────────────────────────────────────

/**
 * Stub for Slice C. The eventual implementation will call the inline
 * async ingest pipeline in `@agent-bridge/agents`. For Slice B the
 * row stays in `pending` and a subsequent reingest (or restart) will
 * pick it up once the worker is wired.
 *
 * Why a fire-and-forget stub instead of just `// TODO`: the call
 * shape is settled here at the route boundary so Slice C only has to
 * fill in the function body. No further changes to routes.
 */
async function scheduleIngest(fileId: string): Promise<void> {
  // `getDb()` returns the full `AgentBridgeDb` handle (with `.db`,
  // `.pool`, `.connectionString`); destructuring would give just the
  // drizzle client, which the ingest pipeline can't use.
  const handle = getDb()
  // Telemetry sink for the ingest lifecycle. Ingest runs outside any
  // agent run context, so we publish onto the per-file stream
  // (`file:<id>`) — the Library page subscribes for live status; the
  // ingest pipeline mirrors everything to stderr too for terminal
  // visibility.
  const bus = getEventBus()
  const publish = async (event: RunEvent): Promise<void> => {
    await bus.publish(event)
  }
  try {
    await ingestKnowledgeFile({ db: handle, fileId, publish })
  } catch (err) {
    // `ingestKnowledgeFile` writes `ingest_status='error'` on its own
    // failures and never throws — anything reaching here is a bug in
    // the ingest layer's error handling. Log loud and move on; the
    // file row already exists, so the operator can reingest manually.
    console.error(
      `[files] ingestKnowledgeFile threw unexpectedly for ${fileId}:`,
      err,
    )
  }
}

// ─── Rebuild + reingest ───────────────────────────────────────────────────

/**
 * Destructive rebuild of `file_chunks` plus full re-ingest queue.
 * Shared between this route's `POST /rebuild-index` handler and the
 * `llm-providers` PATCH path (where an embedding-model change has
 * already been confirmed by the operator via `wipeSemanticVectors`).
 *
 * Returns the previous + new column dim so the caller can include them
 * in its 2xx response, and the queued count so the UI can render
 * "re-ingesting 0 / N files" until the rows flip to `ready`.
 */
export async function rebuildFileChunksAndQueueReingest(
  handle: AgentBridgeDb,
  targetDim: number,
): Promise<{
  previousDim: number | null
  currentDim: number
  changed: boolean
  queued: number
}> {
  const dimResult = await rebuildFileChunksAtDim(handle, targetDim)
  const rows = await handle.db
    .update(schema.files)
    .set({
      ingestStatus: 'embedding',
      chunksDone: 0,
      ingestError: null,
    })
    .returning({ id: schema.files.id })
  for (const row of rows) {
    void scheduleIngest(row.id)
  }
  return {
    previousDim: dimResult.previousDim,
    currentDim: dimResult.currentDim,
    changed: dimResult.changed,
    queued: rows.length,
  }
}