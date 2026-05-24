/**
 * `/api/agents/:agentId/files` — per-agent attachments to the global
 * knowledge file store.
 *
 * Each row in `agent_files` gives one agent access to one file via
 * `search_knowledge` and adds the file to that agent's system-prompt
 * catalog. Files themselves are workspace-scoped (see `routes/files.ts`);
 * attaching is cheap (just a join-table insert).
 *
 * Attach / detach actions are audited via `publishAgentConfig` so they
 * appear in the Activity timeline alongside skill / repo / MCP changes.
 *
 * Design: see `docs/knowledge-files.md`.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  MAX_FILES_PER_AGENT,
  agentFileAttachInputSchema,
  agentFileItemParamSchema,
  agentFileResponseSchema,
  filesAgentParamSchema,
  type AgentFileResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'
import { toFileResponse } from '../lib/file-converter.js'

type AgentFileRow = typeof schema.agentFiles.$inferSelect

function toAgentFileResponse(row: AgentFileRow): AgentFileResponse {
  return agentFileResponseSchema.parse({
    agentId: row.agentId,
    fileId: row.fileId,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  })
}

async function agentExists(agentId: string): Promise<boolean> {
  const { db } = getDb()
  const [row] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return Boolean(row)
}

export const agentFilesRouter = new Hono()
  // ─── GET /api/agents/:agentId/files ──────────────────────────────────────
  .get(
    '/',
    zValidator('param', filesAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const { db } = getDb()

      if (!(await agentExists(agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const rows = await db
        .select({ attach: schema.agentFiles, file: schema.files })
        .from(schema.agentFiles)
        .innerJoin(schema.files, eq(schema.agentFiles.fileId, schema.files.id))
        .where(eq(schema.agentFiles.agentId, agentId))
        .orderBy(asc(schema.agentFiles.position), asc(schema.agentFiles.createdAt))

      return c.json({
        ok: true as const,
        attachments: rows.map((r) => ({
          attachment: toAgentFileResponse(r.attach),
          file: toFileResponse(r.file),
        })),
      })
    },
  )
  // ─── POST /api/agents/:agentId/files/:fileId ─────────────────────────────
  .post(
    '/:fileId',
    zValidator('param', agentFileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', agentFileAttachInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, fileId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      if (!(await agentExists(agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      const [file] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, fileId))
        .limit(1)
      if (!file) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${fileId} not found`,
        })
      }

      // Per-agent attachment cap. Counted before insert because the
      // unique-violation path below can't tell us the existing count.
      const [{ value: attached } = { value: 0 }] = await db
        .select({ value: count() })
        .from(schema.agentFiles)
        .where(eq(schema.agentFiles.agentId, agentId))
      if (attached >= MAX_FILES_PER_AGENT) {
        return httpError(c, {
          code: 'validation_failed',
          message:
            `Agent already has ${MAX_FILES_PER_AGENT} files attached. ` +
            `Detach one before adding another.`,
        })
      }

      try {
        const [row] = await db
          .insert(schema.agentFiles)
          .values({
            agentId,
            fileId,
            position: body.position ?? 0,
          })
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'internal',
            message: 'insert returned no rows',
          })
        }

        publishAgentConfig({
          agentId,
          action: 'added',
          resource: 'file',
          label: file.name,
        })
        return c.json(
          {
            ok: true as const,
            attachment: toAgentFileResponse(row),
            file: toFileResponse(file),
          },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `file ${fileId} is already attached to agent ${agentId}`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:agentId/files/:fileId ───────────────────────────
  .delete(
    '/:fileId',
    zValidator('param', agentFileItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, fileId } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.agentFiles)
        .where(
          and(
            eq(schema.agentFiles.agentId, agentId),
            eq(schema.agentFiles.fileId, fileId),
          ),
        )
        .returning()

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `file ${fileId} is not attached to agent ${agentId}`,
        })
      }

      // Read the file row for the audit label. Fine if the file was
      // deleted between attach and detach — we still emit the event,
      // labeled with the file id.
      const [file] = await db
        .select({ name: schema.files.name })
        .from(schema.files)
        .where(eq(schema.files.id, fileId))
        .limit(1)
      publishAgentConfig({
        agentId,
        action: 'removed',
        resource: 'file',
        label: file?.name ?? fileId,
      })

      return c.json({ ok: true as const, agentId, fileId })
    },
  )

export type AgentFilesRouter = typeof agentFilesRouter
