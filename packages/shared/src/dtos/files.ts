/**
 * Knowledge file DTOs. Browser-safe.
 *
 * A file is a workspace-wide knowledge document (markdown, text, PDF in
 * later phases). Operators upload via Library → Files; agents attach
 * via `agent_files`; one-off chat uploads land in `thread_files`. The
 * full design (storage layout, ingestion pipeline, retrieval, citation
 * shape) lives in `docs/knowledge-files.md`.
 *
 * Resource boundary:
 *   /api/files                              — workspace CRUD
 *   /api/agents/:agentId/files              — per-agent attachments
 *   /api/agents/:agentId/files/:fileId      — single per-agent attach
 *
 * Worker-owned fields (`ingest_status`, `chunks_done`, `ingest_error`)
 * are write-only from the ingest pipeline. The HTTP PATCH surface
 * deliberately only exposes `name` + `description` — letting the UI
 * mutate ingest state would let it lie about pipeline progress.
 */

import { z } from 'zod'

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Supported upload kinds. Adding a new entry requires (1) an extractor
 * in `knowledge-ingest.ts`, (2) an extension-to-kind mapping in the
 * upload route, and (3) appropriate body-size handling.
 *
 * v1 ships markdown + plain text + PDF. DOCX lands in Phase 3.
 */
export const FILE_KINDS = ['md', 'txt', 'pdf'] as const
export type FileKind = (typeof FILE_KINDS)[number]

/**
 * Ingest pipeline lifecycle. `ready` means embeddings are queryable;
 * `error` means the pipeline bailed (see `ingest_error` for the
 * message). Anything else is in-flight. The UI surfaces these as
 * status pills; the retrieval path refuses to query against files
 * not yet `ready`.
 */
export const FILE_INGEST_STATUSES = [
  'pending',
  'extracting',
  'chunking',
  'embedding',
  'describing',
  'ready',
  'error',
] as const
export type FileIngestStatus = (typeof FILE_INGEST_STATUSES)[number]

/** Operator-visible display name. Defaults to the original filename. */
export const FILE_NAME_MAX = 200

/**
 * Auto-generated description shown in the system-prompt catalog when
 * the file is attached to an agent. Operator-editable. Hard cap is a
 * soft tap on the shoulder — multi-paragraph descriptions waste
 * catalog tokens without helping retrieval quality.
 */
export const FILE_DESCRIPTION_MAX = 500

/**
 * Per-file size cap (`docs/knowledge-files.md`). 50 MiB covers any
 * sane single document; a 200-page PDF is closer to 5 MiB. The cap
 * is a hard-error at the upload boundary so we don't ingest something
 * we can't reasonably embed.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Per-file chunk cap. A 200-page PDF chunked at ~800 tokens produces
 * ~500 chunks; the cap leaves headroom but rejects pathological
 * documents (e.g. a 1 MB single-line markdown file with no paragraph
 * breaks would be either un-chunkable or fragmented).
 */
export const MAX_CHUNKS_PER_FILE = 1000

/**
 * Per-agent attachment cap. Large prompts get incoherent past ~10
 * catalog entries; 50 is a soft ceiling that warns first, hard-stops
 * past that to keep the "Attached files" catalog block from
 * eclipsing the rest of the system prompt.
 */
export const MAX_FILES_PER_AGENT = 50

/**
 * Per-workspace file-count cap. A personal-use ceiling — anyone past
 * 500 docs is using Agent Bridge as a Drive replacement, which it
 * isn't designed for. Warn at 80% (400), hard-error at 100%.
 */
export const MAX_FILES_PER_WORKSPACE = 500

// ─── Field schemas ───────────────────────────────────────────────────────

const fileNameSchema = z
  .string()
  .trim()
  .min(1, 'name cannot be empty')
  .max(FILE_NAME_MAX)
  .refine((v) => !/[\r\n\t]/.test(v), {
    message: 'name cannot contain tabs or newlines',
  })

const fileDescriptionSchema = z
  .string()
  .max(
    FILE_DESCRIPTION_MAX,
    `description exceeds ${FILE_DESCRIPTION_MAX}-byte limit`,
  )
  .refine((v) => !/[\r\n]/.test(v), {
    message: 'description must be a single line',
  })

const fileKindSchema = z.enum(FILE_KINDS)
const fileIngestStatusSchema = z.enum(FILE_INGEST_STATUSES)

// ─── Upload (POST /api/files) ────────────────────────────────────────────

/**
 * The HTTP route handler parses the multipart body — the file bytes
 * come out of `formData.file` and we resolve `kind` from the file's
 * extension. This schema covers the OPTIONAL metadata an operator can
 * send alongside the bytes (typically nothing on first upload; the
 * file's filename becomes the display name).
 *
 * `name` is optional because the dominant flow is "drag a file in and
 * the filename is good enough"; only operators who rename via the
 * upload dialog send it.
 */
export const fileUploadMetaSchema = z
  .object({
    name: fileNameSchema.optional(),
  })
  .strict()
export type FileUploadMeta = z.infer<typeof fileUploadMetaSchema>

// ─── Update (PATCH /api/files/:id) ───────────────────────────────────────

/**
 * Operator-mutable surface. Anything pipeline-owned (`ingest_status`,
 * `chunks_done`, `ingest_error`) is deliberately absent — the worker
 * owns those. Accepting them here would let the UI silently lie about
 * pipeline state.
 */
/** How the ingest pipeline slices the file. `flat` (default) — one
 *  ~800-token chunk per slice, each embedded directly. `hierarchical`
 *  — large ~1500-token parent buckets keyed by section heading +
 *  smaller ~400-token children with embeddings; retrieval matches
 *  children but expands snippets to parent text. Switching modes
 *  requires a reingest (the operator triggers it via the kebab). */
export const fileChunkingModeSchema = z.enum(['flat', 'hierarchical'])
export type FileChunkingMode = z.infer<typeof fileChunkingModeSchema>

export const fileUpdateInputSchema = z
  .object({
    name: fileNameSchema.optional(),
    description: fileDescriptionSchema.optional(),
    chunkingMode: fileChunkingModeSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })
export type FileUpdateInput = z.infer<typeof fileUpdateInputSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const fileResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  filename: z.string(),
  kind: fileKindSchema,
  bytes: z.number().int().nonnegative(),
  description: z.string(),
  contentHash: z.string(),
  pageCount: z.number().int().nullable(),
  ingestStatus: fileIngestStatusSchema,
  /** 0..N. Embedded chunks already written when `ingest_status` is
   *  partway through. Lets the UI render progress, and lets a re-ingest
   *  resume from this offset on retry. */
  chunksDone: z.number().int().nonnegative(),
  ingestError: z.string().nullable(),
  /** Chunking strategy persisted on the row. `flat` (default) for
   *  simple per-chunk retrieval; `hierarchical` for parent-expansion
   *  retrieval. Switching takes effect on the NEXT reingest. */
  chunkingMode: fileChunkingModeSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type FileResponse = z.infer<typeof fileResponseSchema>

// ─── Agent attachments ───────────────────────────────────────────────────

/**
 * POST /api/agents/:agentId/files/:fileId — attach an existing file
 * to an agent. The route validates the file exists + is `ready` (an
 * attachment whose body isn't queryable is a footgun). Position is
 * client-managed; defaults to "append to end" when omitted.
 */
export const agentFileAttachInputSchema = z
  .object({
    position: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()
export type AgentFileAttachInput = z.infer<typeof agentFileAttachInputSchema>

export const agentFileResponseSchema = z.object({
  agentId: z.uuid(),
  fileId: z.uuid(),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
})
export type AgentFileResponse = z.infer<typeof agentFileResponseSchema>

// ─── URL params ──────────────────────────────────────────────────────────

export const fileItemParamSchema = z.object({ id: z.uuid() })
export type FileItemParam = z.infer<typeof fileItemParamSchema>

export const agentFileItemParamSchema = z.object({
  agentId: z.uuid(),
  fileId: z.uuid(),
})
export type AgentFileItemParam = z.infer<typeof agentFileItemParamSchema>

export const filesAgentParamSchema = z.object({ agentId: z.uuid() })
export type FilesAgentParam = z.infer<typeof filesAgentParamSchema>
