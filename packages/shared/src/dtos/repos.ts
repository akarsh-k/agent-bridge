/**
 * Repo CRUD + agent-attachment + edge DTOs. Browser-safe.
 *
 * The resource boundary is deliberately split three ways:
 *
 *   /api/repos                         — global deduped store of (url, branch)
 *   /api/agents/:agentId/repos         — per-agent attachments (role / position)
 *   /api/agents/:agentId/repo-edges    — per-agent directed graph edges
 *
 * This matches the schema's Option-B dedupe: a single clone/index pass
 * benefits every agent that attaches the same (url, branch). The connector
 * labels are per-agent so two agents can model the same pair differently.
 *
 * User-facing update surface on `/api/repos/:id` is deliberately minimal:
 * only `gitPat` flips through the secret pipeline. `status`, `localPath`,
 * `lastIndexedAt`, `lastError` are worker-owned fields and must not be
 * mutated via the HTTP API — accepting them here would let the UI lie about
 * index state.
 */

import { z } from 'zod'
import { repoStatuses, type RepoIndexSummary } from '../domain.js'
import { secretInputSchema, secretSentinelSchema } from './secrets.js'

// ─── Shared fragments ────────────────────────────────────────────────────

/**
 * Git remote URL. We deliberately DON'T use `z.url()` — that rejects
 * SSH-style `git@host:owner/repo.git` and `ssh://…` forms. Accept any
 * non-empty printable string and let git's own parser yell at clone time.
 */
const remoteUrlSchema = z
  .string()
  .trim()
  .min(1, 'remoteUrl cannot be empty')
  .max(500)

/**
 * Git branch name. We enforce only the obvious anti-footgun rules; the full
 * ref-format spec is too exotic to mirror in Zod.
 */
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !v.includes('..'), {
    message: 'branch cannot contain ".."',
  })
  .refine((v) => !v.startsWith('.') && !v.startsWith('/'), {
    message: 'branch cannot start with "." or "/"',
  })
  .refine((v) => !v.endsWith('/') && !v.endsWith('.lock'), {
    message: 'branch cannot end with "/" or ".lock"',
  })

const roleSchema = z.string().trim().max(60)
const descriptionSchema = z.string().trim().max(500)
const connectorSchema = z.string().trim().min(1).max(60)

/** React-Flow canvas coordinates. Signed 32-bit range is plenty for UI pans. */
const positionSchema = z
  .number()
  .int()
  .min(-1_000_000)
  .max(1_000_000)

// ─── /api/repos ──────────────────────────────────────────────────────────

/**
 * POST /api/repos body. Dedupe semantics:
 *   - If (remoteUrl, branch) already exists, `gitPat` is IGNORED and the
 *     existing row is returned (HTTP 200, `existed: true`). Use PATCH to
 *     update a secret on an existing repo.
 *   - If new, row is created with the PAT applied (HTTP 201, `existed: false`).
 */
export const repoCreateInputSchema = z
  .object({
    remoteUrl: remoteUrlSchema,
    branch: branchSchema.optional(),
    gitPat: secretInputSchema.optional(),
  })
  .strict()

export type RepoCreateInput = z.infer<typeof repoCreateInputSchema>

/**
 * PATCH /api/repos/:id body. Only the secret is user-editable. Everything
 * else (status/paths/index timestamps) belongs to the worker.
 */
export const repoUpdateInputSchema = z
  .object({
    gitPat: secretInputSchema,
  })
  .strict()

export type RepoUpdateInput = z.infer<typeof repoUpdateInputSchema>

/**
 * Structural counts from the most recent successful `gitnexus analyze` pass.
 * Mirrors `RepoIndexSummary` from ../domain.js — we redeclare here so Zod
 * owns the wire-format shape on the HTTP boundary.
 */
export const repoIndexSummarySchema = z.object({
  indexedAt: z.iso.datetime(),
  indexedCommitSha: z.string().nullable(),
  files: z.number().int().nullable(),
  nodes: z.number().int().nullable(),
  edges: z.number().int().nullable(),
  communities: z.number().int().nullable(),
  processes: z.number().int().nullable(),
  embeddings: z.number().int().nullable(),
}) satisfies z.ZodType<RepoIndexSummary>

export const repoResponseSchema = z.object({
  id: z.uuid(),
  remoteUrl: z.string(),
  branch: z.string(),
  localPath: z.string().nullable(),
  status: z.enum(repoStatuses),
  lastIndexedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  gitPat: secretSentinelSchema,
  /**
   * Summary counts from the last successful analyze, read lazily by the
   * backend from `<source>/.gitnexus/meta.json` via
   * `@agent-bridge/shared/gitnexus`:`readIndexSummary`. `null` when the
   * repo has never been successfully indexed (e.g. still
   * `pending`/`cloning`/`cloned` pre-index, or a fresh clone whose
   * index job hasn't landed yet) or when the source tree has been wiped.
   */
  indexSummary: repoIndexSummarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type RepoResponse = z.infer<typeof repoResponseSchema>

export const repoIdParamSchema = z.object({ id: z.uuid() })
export type RepoIdParam = z.infer<typeof repoIdParamSchema>

// ─── /api/agents/:agentId/repos (attachments) ────────────────────────────

/**
 * Attach an existing (pre-deduped) repo to an agent. The caller typically
 * POSTs `/api/repos` first to get an id, then POSTs here. Two-step on
 * purpose — it keeps the atomic primitives composable.
 */
export const attachRepoInputSchema = z
  .object({
    repoId: z.uuid(),
    role: roleSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    positionX: positionSchema.optional(),
    positionY: positionSchema.optional(),
  })
  .strict()

export type AttachRepoInput = z.infer<typeof attachRepoInputSchema>

/**
 * PATCH /api/agents/:agentId/repos/:repoId — update only the per-attachment
 * fields (role / description / position). The global repo resource stays
 * untouched.
 */
export const attachRepoUpdateInputSchema = z
  .object({
    role: roleSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    positionX: positionSchema.optional(),
    positionY: positionSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type AttachRepoUpdateInput = z.infer<typeof attachRepoUpdateInputSchema>

/**
 * Response envelope: the global repo AND the per-attachment fields side by
 * side. Nested rather than flattened so the frontend never confuses the
 * global `createdAt` (when the repo entered the store) with the
 * `attachedAt` (when this agent linked to it).
 */
export const attachedRepoResponseSchema = z.object({
  repo: repoResponseSchema,
  role: z.string().nullable(),
  description: z.string().nullable(),
  positionX: z.number().int(),
  positionY: z.number().int(),
  attachedAt: z.iso.datetime(),
  attachmentUpdatedAt: z.iso.datetime(),
})

export type AttachedRepoResponse = z.infer<typeof attachedRepoResponseSchema>

export const agentRepoParamSchema = z.object({
  agentId: z.uuid(),
  repoId: z.uuid(),
})
export type AgentRepoParam = z.infer<typeof agentRepoParamSchema>

export const agentIdOnlyParamSchema = z.object({ agentId: z.uuid() })
export type AgentIdOnlyParam = z.infer<typeof agentIdOnlyParamSchema>

// ─── /api/agents/:agentId/repo-edges ─────────────────────────────────────

/**
 * Create a directed edge between two repos attached to the same agent.
 * Invariants enforced server-side:
 *   - Both `fromRepoId` and `toRepoId` must already be in `agent_repos`
 *     for this agent (membership check in a transaction).
 *   - `fromRepoId !== toRepoId` (DB-level CHECK AND Zod refine).
 *
 * No uniqueness constraint on (from, to, connector): the UI may legitimately
 * want multiple parallel edges between the same pair with different
 * connector labels ("reads", "writes").
 */
export const repoEdgeCreateInputSchema = z
  .object({
    fromRepoId: z.uuid(),
    toRepoId: z.uuid(),
    connector: connectorSchema,
    description: descriptionSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.fromRepoId !== v.toRepoId, {
    path: ['toRepoId'],
    message: 'toRepoId must differ from fromRepoId',
  })

export type RepoEdgeCreateInput = z.infer<typeof repoEdgeCreateInputSchema>

export const repoEdgeUpdateInputSchema = z
  .object({
    connector: connectorSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type RepoEdgeUpdateInput = z.infer<typeof repoEdgeUpdateInputSchema>

export const repoEdgeResponseSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  fromRepoId: z.uuid(),
  toRepoId: z.uuid(),
  connector: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type RepoEdgeResponse = z.infer<typeof repoEdgeResponseSchema>

export const repoEdgeParamSchema = z.object({
  agentId: z.uuid(),
  edgeId: z.uuid(),
})
export type RepoEdgeParam = z.infer<typeof repoEdgeParamSchema>
