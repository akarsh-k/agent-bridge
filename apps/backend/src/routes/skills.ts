/**
 * `/api/agents/:agentId/skills` — nested CRUD for agent skills.
 *
 * Agent-scoping invariant (critical):
 *   Every per-item query MUST filter by BOTH `agentId` (from URL) AND `id`
 *   (from URL). Otherwise a caller could PATCH a skill owned by agent-A
 *   via URL `/api/agents/B/skills/<A's skill id>`. A mismatch resolves to
 *   "not found" — same response as a truly missing row, so we don't leak
 *   cross-agent existence.
 *
 * Deleting the parent agent cascades to skills via FK (`onDelete: 'cascade'`).
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  PER_AGENT_SKILL_BUDGET_BYTES,
  skillAgentParamSchema,
  skillCreateInputSchema,
  skillItemParamSchema,
  skillResponseSchema,
  skillUpdateInputSchema,
  type SkillResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import type { Context } from 'hono'
import { getDb } from '../db.js'
import { publishAgentConfig } from '../lib/agent-events.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

type SkillRow = typeof schema.skills.$inferSelect

function toSkillResponse(row: SkillRow): SkillResponse {
  return skillResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    markdownBody: row.markdownBody,
    alwaysInclude: row.alwaysInclude,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

/**
 * Per-agent skill body budget enforcement (`docs/ARCHITECTURE.md §10`).
 *
 * Sums `markdownBody.length` across the agent's existing skills,
 * optionally excluding one skill id (the one being PATCHed — its old
 * body is being replaced). Returns a `Overflow` handle when adding
 * `incomingBytes` would exceed `PER_AGENT_SKILL_BUDGET_BYTES`; null
 * when there's room.
 *
 * Race-safe enough for a single-operator app: between this check and
 * the INSERT/UPDATE, another concurrent skill add could push us over,
 * but that requires two operators clicking save inside the same
 * couple of ms. Postgres-level enforcement (CHECK constraint over a
 * subquery) is non-trivial; the application-level check is the right
 * trade-off.
 */
async function wouldExceedAgentSkillBudget(
  agentId: string,
  incomingBytes: number,
  excludeSkillId: string | null,
): Promise<Overflow | null> {
  const { db } = getDb()
  const rows = await db
    .select({
      id: schema.skills.id,
      bytes: schema.skills.markdownBody,
    })
    .from(schema.skills)
    .where(eq(schema.skills.agentId, agentId))

  let existing = 0
  for (const r of rows) {
    if (excludeSkillId && r.id === excludeSkillId) continue
    existing += r.bytes.length
  }
  const total = existing + incomingBytes
  if (total <= PER_AGENT_SKILL_BUDGET_BYTES) return null
  return new Overflow(existing, incomingBytes, total)
}

class Overflow {
  // Frontend's tsconfig sets `erasableSyntaxOnly: true`, which forbids
  // TypeScript parameter properties (`constructor(private readonly x)`).
  // Explicit field declarations keep monorepo typecheck clean even from
  // backend code.
  private readonly existing: number
  private readonly incoming: number
  private readonly total: number
  constructor(existing: number, incoming: number, total: number) {
    this.existing = existing
    this.incoming = incoming
    this.total = total
  }
  toResponse(c: Context) {
    return httpError(c, {
      code: 'validation_failed',
      message:
        `Per-agent skill body budget exceeded: ` +
        `existing ${this.existing} bytes + incoming ${this.incoming} bytes = ${this.total} bytes ` +
        `> cap ${PER_AGENT_SKILL_BUDGET_BYTES} bytes. ` +
        `Trim or remove an existing skill before adding more.`,
    })
  }
}

export const skillsRouter = new Hono()
  // ─── POST /api/agents/:agentId/skills ────────────────────────────────────
  .post(
    '/',
    zValidator('param', skillAgentParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', skillCreateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      if (!(await agentExists(agentId))) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${agentId} not found`,
        })
      }

      // Per-agent total skill body cap. Sum the existing
      // skills' bytes against the incoming body. exceeding the cap
      // returns 422 with a clear message rather than letting it land
      // and pollute the system prompt of every chat turn.
      const incomingBytes = (body.markdownBody ?? '').length
      const overflow = await wouldExceedAgentSkillBudget(
        agentId,
        incomingBytes,
        null,
      )
      if (overflow) return overflow.toResponse(c)

      try {
        const [row] = await db
          .insert(schema.skills)
          .values({
            agentId,
            name: body.name,
            description: body.description ?? '',
            markdownBody: body.markdownBody ?? '',
            alwaysInclude: body.alwaysInclude ?? false,
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
          resource: 'skill',
          label: row.name,
        })
        return c.json(
          { ok: true as const, skill: toSkillResponse(row) },
          201,
        )
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `skill name "${body.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── GET /api/agents/:agentId/skills ─────────────────────────────────────
  .get(
    '/',
    zValidator('param', skillAgentParamSchema, (result, c) => {
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
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.agentId, agentId))
        .orderBy(asc(schema.skills.position), asc(schema.skills.createdAt))

      return c.json({
        ok: true as const,
        skills: rows.map(toSkillResponse),
      })
    },
  )
  // ─── PATCH /api/agents/:agentId/skills/:id ───────────────────────────────
  .patch(
    '/:id',
    zValidator('param', skillItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('json', skillUpdateInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const body = c.req.valid('json')
      const { db } = getDb()

      const patch: Partial<typeof schema.skills.$inferInsert> = {}
      if ('name' in body) patch.name = body.name
      if ('description' in body) patch.description = body.description
      if ('markdownBody' in body) patch.markdownBody = body.markdownBody
      if ('alwaysInclude' in body) patch.alwaysInclude = body.alwaysInclude
      if ('position' in body) patch.position = body.position

      // Per-agent total cap on PATCH too. We exclude the
      // skill being updated from the existing-bytes sum (its old body
      // is being replaced). PATCHes that don't touch markdownBody skip
      // the check entirely.
      if ('markdownBody' in body) {
        const incomingBytes = (body.markdownBody ?? '').length
        const overflow = await wouldExceedAgentSkillBudget(
          agentId,
          incomingBytes,
          id,
        )
        if (overflow) return overflow.toResponse(c)
      }

      try {
        // Double-filter on (id, agentId) enforces cross-agent isolation.
        const [row] = await db
          .update(schema.skills)
          .set(patch)
          .where(
            and(
              eq(schema.skills.id, id),
              eq(schema.skills.agentId, agentId),
            ),
          )
          .returning()

        if (!row) {
          return httpError(c, {
            code: 'not_found',
            message: `skill ${id} not found on agent ${agentId}`,
          })
        }

        publishAgentConfig({
          agentId,
          action: 'updated',
          resource: 'skill',
          label: row.name,
        })
        return c.json({ ok: true as const, skill: toSkillResponse(row) })
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `skill name "${patch.name}" is already in use on this agent`,
          })
        }
        throw err
      }
    },
  )
  // ─── DELETE /api/agents/:agentId/skills/:id ──────────────────────────────
  .delete(
    '/:id',
    zValidator('param', skillItemParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { agentId, id } = c.req.valid('param')
      const { db } = getDb()

      const [row] = await db
        .delete(schema.skills)
        .where(
          and(
            eq(schema.skills.id, id),
            eq(schema.skills.agentId, agentId),
          ),
        )
        .returning({ id: schema.skills.id, name: schema.skills.name })

      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `skill ${id} not found on agent ${agentId}`,
        })
      }

      publishAgentConfig({
        agentId,
        action: 'removed',
        resource: 'skill',
        label: row.name,
      })
      return c.json({ ok: true as const, id: row.id })
    },
  )

export type SkillsRouter = typeof skillsRouter
