/**
 * Single source of truth for `files` row → `FileResponse` mapping.
 *
 * Both `routes/files.ts` (workspace CRUD) and `routes/agent-files.ts`
 * (per-agent attach/detach) used to maintain their own copies of this
 * converter. The two diverged when `chunkingMode` was added to the
 * DTO — `files.ts` was updated, `agent-files.ts` wasn't, the agent's
 * attached-files endpoint started 500ing on every file with a non-flat
 * mode, and `fetchAgentResources` on the frontend (which `Promise.all`s
 * over six per-resource endpoints) tipped the whole Resources panel
 * into "everything empty" mode.
 *
 * One converter, both routes import it. Any new column added to
 * `fileResponseSchema` only needs to be threaded here once.
 */

import { schema } from '@agent-bridge/db'
import {
  fileResponseSchema,
  type FileIngestStatus,
  type FileKind,
  type FileResponse,
} from '@agent-bridge/shared'

type FileRow = typeof schema.files.$inferSelect

export function toFileResponse(row: FileRow): FileResponse {
  return fileResponseSchema.parse({
    id: row.id,
    name: row.name,
    filename: row.filename,
    kind: row.kind as FileKind,
    bytes: row.bytes,
    description: row.description,
    contentHash: row.contentHash,
    pageCount: row.pageCount,
    ingestStatus: row.ingestStatus as FileIngestStatus,
    chunksDone: row.chunksDone,
    ingestError: row.ingestError,
    // Persisted as text in the DB (drizzle DSL has no enum type for
    // this column). Narrow at the boundary so the response type stays
    // strict; an unrecognised value would surface as a Zod parse
    // error here rather than silently flowing to the UI.
    chunkingMode: row.chunkingMode as FileResponse['chunkingMode'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
