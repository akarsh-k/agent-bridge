/**
 * Repo CRUD + agent-attachment + relationship DTOs. Browser-safe.
 *
 * The resource boundary is deliberately split three ways:
 *
 *   /api/repos                              — global deduped store of (url, branch)
 *   /api/agents/:agentId/repos              — per-agent attachments (role / position)
 *   /api/agents/:agentId/repo-relationships — per-agent directed relationships
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
import {
  repoStatuses,
  repoWikiStatuses,
  type RepoIndexSummary,
} from '../domain.js'
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

/**
 * Operator-curated extra names for an attached repo. Used by the
 * inspector toolkit's `resolveRepoHint` to fuzzy-match an IDE coding
 * agent's `repo_hint` / `local_folder` against synonyms the operator
 * knows about (folder names, short codes, legacy names).
 *
 * Validation: per-entry trim + lowercase + non-empty + max 60 chars,
 * dedupe across the array, max 20 aliases per repo. The
 * lower-casing happens at the DTO so the column stores a canonical
 * form. the resolver already lower-cases its inputs, so keeping
 * the storage lowered means equal-string comparisons line up.
 */
const aliasesSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(20, 'at most 20 aliases per repo')
  .transform((list) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of list) {
      const lowered = raw.toLowerCase()
      if (seen.has(lowered)) continue
      seen.add(lowered)
      out.push(lowered)
    }
    return out
  })

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
 * Structured `details` payload returned alongside a `validation_failed`
 * error from `POST /api/repos` when the requested branch doesn't exist
 * on the remote. The frontend narrows on `kind` to decide whether to
 * render a branch picker or a "repo unreachable" message.
 *
 *   branch_not_found  — `git ls-remote` succeeded but the chosen branch
 *                       isn't in the response. `branches` lists every
 *                       remote head; `suggestedBranch` is the remote's
 *                       default (HEAD symref target) when available.
 *   repo_unreachable  — `git ls-remote` failed before we could read any
 *                       branches. `reason` is one of auth | not_found |
 *                       network | timeout | unknown; `stderr` carries
 *                       the redacted git error for diagnostics.
 */
export const repoBranchValidationFailureSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('branch_not_found'),
      requestedBranch: z.string(),
      /**
       * Branch names visible to the operator, sorted with the remote's
       * default + common conventions first then alphabetical. Capped at
       * a fixed size (see `truncated`/`total`) so the response stays
       * bounded for mirror-style repos with thousands of branches.
       */
      branches: z.array(z.string()),
      /** True when the remote has more branches than `branches.length`. */
      truncated: z.boolean(),
      /** Total branches advertised by the remote, regardless of cap. */
      total: z.number().int().nonnegative(),
      suggestedBranch: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('repo_unreachable'),
      reason: z.enum(['auth', 'not_found', 'network', 'timeout', 'unknown']),
      stderr: z.string(),
    })
    .strict(),
])

export type RepoBranchValidationFailure = z.infer<
  typeof repoBranchValidationFailureSchema
>

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
  /**
   * Wiki state — orthogonal to `status`, so a repo stays `ready` for
   * agents while its wiki regenerates. `wikiStatus` drives the inspector
   * dot + button enablement; the other three fields fill the wiki summary
   * card. `wikiPages` is parsed from `gitnexus wiki` stdout on the
   * success path — `null` when the last run was a no-op
   * (`Mode: up-to-date`) or when the parser couldn't find the count.
   */
  wikiStatus: z.enum(repoWikiStatuses),
  wikiGeneratedAt: z.iso.datetime().nullable(),
  wikiPages: z.number().int().nullable(),
  wikiLastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type RepoResponse = z.infer<typeof repoResponseSchema>

export const repoIdParamSchema = z.object({ id: z.uuid() })
export type RepoIdParam = z.infer<typeof repoIdParamSchema>

/**
 * POST /api/repos/:id/index body. Optional `force` flag (default `false`).
 * `false` → "Update index": gitnexus's incremental analyze re-parses only
 * changed files. `true` → "Rebuild from scratch": passes `-f` to gitnexus,
 * which blows away the graph + embeddings store before re-walking the tree.
 * See `docs/ARCHITECTURE.md §10` D16/A5 for why incremental is the default.
 */
export const indexRepoBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict()
export type IndexRepoBody = z.infer<typeof indexRepoBodySchema>

/**
 * POST /api/repos/:id/wiki body. The caller picks which LLM provider
 * pays for the run via `llmProviderId`; the backend resolves the row,
 * checks it has an `apiKey` envelope (or is local-only) and a
 * `default_model` set, and forwards the decrypted credentials to the
 * worker via the queue. `force` maps to `gitnexus wiki --force` and
 * skips the up-to-date short-circuit.
 *
 * Provider owns the model identity: there is no per-request model
 * override. If the operator wants a different model for wiki gen,
 * they configure it on the provider row.
 */
export const repoWikiInputSchema = z
  .object({
    llmProviderId: z.uuid(),
    force: z.boolean().optional(),
  })
  .strict()

export type RepoWikiInput = z.infer<typeof repoWikiInputSchema>

// ─── /api/repos/:id/graph ────────────────────────────────────────────────

/**
 * Read-only graph extracted from `gitnexus analyze`'s Kuzu store via
 * `gitnexus cypher`. The endpoint serves three orthogonal slices of
 * the same knowledge graph:
 *
 *   - `structure` — directory tree (Folder + File nodes, CONTAINS).
 *   - `symbols`   — top-degree Functions / Classes / Methods linked by
 *                   CALLS. The closest approximation to "the semantic
 *                   graph" the operator usually wants when they say
 *                   "show me the graph".
 *   - `imports`   — File-level IMPORTS graph (module dependencies).
 *
 * Each mode returns the same wire shape; the `kind` column on nodes +
 * edges lets the UI colour by category without duplicating endpoints.
 */
export const repoGraphModes = [
  'network',
  'processes',
  'communities',
] as const
export type RepoGraphMode = (typeof repoGraphModes)[number]

export const repoGraphNodeKinds = [
  'folder',
  'file',
  'function',
  'class',
  'method',
  /** A `Process` cluster node — an LLM-flagged execution flow. Only
   *  appears as the focal node in `processes` mode. */
  'process',
  /** A `Community` cluster node — a heuristic semantic grouping.
   *  Only appears as the focal node in `communities` mode. */
  'community',
] as const
export type RepoGraphNodeKind = (typeof repoGraphNodeKinds)[number]

export const repoGraphEdgeKinds = [
  'contains',
  'calls',
  'imports',
  /** STEP_IN_PROCESS — orders the members of a Process. The frontend
   *  pulls `step` off the DTO to draw the flow left-to-right. */
  'step',
  /** MEMBER_OF — Community → its members. */
  'member',
] as const
export type RepoGraphEdgeKind = (typeof repoGraphEdgeKinds)[number]

export const repoGraphNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(repoGraphNodeKinds),
  /**
   * Edge degree (incoming + outgoing) at extraction time. Optional so
   * the structure mode (where all nodes have a single CONTAINS parent)
   * doesn't waste bytes on a uniform value. Used by `symbols` mode to
   * size the most-connected functions visibly larger.
   */
  degree: z.number().int().nonnegative().nullable().optional(),
  /**
   * Repo-relative path to the source file where this node is defined.
   * Set for `function` / `method` / `class` / `file`; null for synthetic
   * `folder` rows. The path comes from the indexed cypher row, not
   * derived from the id — folder names contain unsafe characters and
   * the id format has shifted across gitnexus versions.
   */
  filePath: z.string().nullable().optional(),
  /** 1-based inclusive line range in `filePath`. Both null for `folder`
   *  and many `file` rows; symbols always have both. Allows 0 because
   *  some gitnexus rows emit a placeholder 0 for module-level
   *  pseudo-symbols. */
  startLine: z.number().int().nonnegative().nullable().optional(),
  endLine: z.number().int().nonnegative().nullable().optional(),
})

export type RepoGraphNode = z.infer<typeof repoGraphNodeSchema>

export const repoGraphEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(repoGraphEdgeKinds),
  /** For `kind: 'step'` only — the 1-based order of this member
   *  within the process. The UI uses it to draw the flow in
   *  execution order and to label the edges. */
  step: z.number().int().positive().nullable().optional(),
})

export type RepoGraphEdge = z.infer<typeof repoGraphEdgeSchema>

export const repoGraphSchema = z.object({
  /** Mode that produced this payload. Echoed so the UI can compare
   *  against its current selection without bookkeeping the request. */
  mode: z.enum(repoGraphModes),
  /** Sorted by id so two calls against the same index produce the same
   *  shape. */
  nodes: z.array(repoGraphNodeSchema),
  edges: z.array(repoGraphEdgeSchema),
  /**
   * Pre-cap totals keyed by node kind so the UI can render a
   * "showing X of N" hint when truncation kicks in. `null` when the
   * underlying count(*) query couldn't be run; the UI silently skips
   * the hint in that case.
   */
  totals: z
    .object({
      folders: z.number().int().nonnegative().nullable(),
      files: z.number().int().nonnegative().nullable(),
      functions: z.number().int().nonnegative().nullable(),
      classes: z.number().int().nonnegative().nullable(),
      methods: z.number().int().nonnegative().nullable(),
    })
    .partial()
    .strict(),
  /** Soft cap applied during extraction. */
  limits: z.object({
    nodes: z.number().int().positive(),
    edges: z.number().int().positive(),
  }),
})

export type RepoGraph = z.infer<typeof repoGraphSchema>

/**
 * Query string for `GET /api/repos/:id/graph`. Optional everywhere so a
 * cold-loaded modal hits the default mode without manufacturing a
 * client-side default.
 */
export const repoGraphQuerySchema = z
  .object({
    mode: z.enum(repoGraphModes).optional(),
    /** Required for `mode=processes` and `mode=communities` — the id
     *  of the Process / Community whose member-subgraph to extract.
     *  Ignored for the other modes. */
    selection: z.string().min(1).optional(),
  })
  .strict()
export type RepoGraphQuery = z.infer<typeof repoGraphQuerySchema>

// ─── /api/repos/:id/processes and /communities — list endpoints ──────────

/** Compact summary of a `Process` node — feeds the picker sidebar in
 *  the modal's processes tab. */
export const repoProcessSummarySchema = z.object({
  id: z.string().min(1),
  /** Step count from the indexed `Process` row — how many ordered
   *  members make up this flow. */
  stepCount: z.number().int().nonnegative().nullable(),
  /** 'intra_community' or 'cross_community'. Gitnexus labels flows
   *  that stay within a single community vs. ones that hop across
   *  several. Surface as a chip. */
  processType: z.string().nullable(),
  /** Pretty derived label — the entry-point function's name, when
   *  available. Falls back to the id. The backend resolves the
   *  entryPointId for the operator-facing string so the frontend
   *  doesn't re-parse symbol ids. */
  label: z.string(),
})
export type RepoProcessSummary = z.infer<typeof repoProcessSummarySchema>

export const repoProcessListResponseSchema = z.object({
  processes: z.array(repoProcessSummarySchema),
  total: z.number().int().nonnegative().nullable(),
})
export type RepoProcessListResponse = z.infer<
  typeof repoProcessListResponseSchema
>

/** Compact summary of a `Community` node — same idea, different
 *  cluster kind. Cohesion is in [0, 1]. */
export const repoCommunitySummarySchema = z.object({
  id: z.string().min(1),
  /** Heuristic label gitnexus assigns ('Components', 'Utilities', …).
   *  Falls back to id when missing. */
  label: z.string(),
  cohesion: z.number().min(0).max(1).nullable(),
  symbolCount: z.number().int().nonnegative().nullable(),
})
export type RepoCommunitySummary = z.infer<typeof repoCommunitySummarySchema>

export const repoCommunityListResponseSchema = z.object({
  communities: z.array(repoCommunitySummarySchema),
  total: z.number().int().nonnegative().nullable(),
})
export type RepoCommunityListResponse = z.infer<
  typeof repoCommunityListResponseSchema
>

// ─── /api/repos/:id/file — source preview slice ──────────────────────────

/**
 * Query for `GET /api/repos/:id/file`. The path is repo-relative
 * (forward-slashes); `..` traversal is rejected at the route layer.
 * The line range is optional — when both ends are present we return
 * a slice with `contextLines` of padding on each side; when absent
 * we return the file's first chunk (up to a hard cap).
 */
export const repoFileSliceQuerySchema = z
  .object({
    path: z.string().min(1),
    startLine: z.coerce.number().int().positive().optional(),
    endLine: z.coerce.number().int().positive().optional(),
    contextLines: z.coerce.number().int().min(0).max(50).optional(),
  })
  .strict()
export type RepoFileSliceQuery = z.infer<typeof repoFileSliceQuerySchema>

export const repoFileSliceResponseSchema = z.object({
  /** Repo-relative path (echoed for sanity). */
  path: z.string(),
  /** Inclusive 1-based line where the returned slice begins. May be
   *  less than the requested startLine because of context padding. */
  startLine: z.number().int().positive(),
  /** Inclusive 1-based line where the slice ends. */
  endLine: z.number().int().positive(),
  /** The slice, one entry per line. UTF-8 only. */
  lines: z.array(z.string()),
  /** Total lines in the file. The UI uses this to show
   *  "showing 12–48 of 199" hints. */
  totalLines: z.number().int().nonnegative(),
  /** Best-effort language guess derived from the extension. The UI
   *  passes it to its highlighter; we don't validate the value. */
  language: z.string().nullable(),
})
export type RepoFileSliceResponse = z.infer<typeof repoFileSliceResponseSchema>

// ─── /api/repos/:id/graph/neighbors ──────────────────────────────────────

/**
 * Symbol-neighborhood payload — one hop in each direction from the
 * selected node. Powers the details panel's "callers / callees /
 * parent / children" sections so the operator can navigate the graph
 * without leaving the modal.
 */
export const repoGraphNeighborKinds = [
  'caller',
  'callee',
  'parent',
  'child',
] as const
export type RepoGraphNeighborKind = (typeof repoGraphNeighborKinds)[number]

export const repoGraphNeighborSchema = repoGraphNodeSchema.extend({
  /** What this neighbor represents relative to the queried node. */
  relation: z.enum(repoGraphNeighborKinds),
})
export type RepoGraphNeighbor = z.infer<typeof repoGraphNeighborSchema>

export const repoGraphNeighborsResponseSchema = z.object({
  nodeId: z.string().min(1),
  neighbors: z.array(repoGraphNeighborSchema),
  /** Pre-cap counts so the UI can render "16 of 42 callers". */
  totals: z.object({
    callers: z.number().int().nonnegative().nullable(),
    callees: z.number().int().nonnegative().nullable(),
    parents: z.number().int().nonnegative().nullable(),
    children: z.number().int().nonnegative().nullable(),
  }),
  /** Per-relation cap applied to the cypher query. */
  limit: z.number().int().positive(),
})
export type RepoGraphNeighborsResponse = z.infer<
  typeof repoGraphNeighborsResponseSchema
>

export const repoGraphNeighborsQuerySchema = z
  .object({
    nodeId: z.string().min(1),
  })
  .strict()
export type RepoGraphNeighborsQuery = z.infer<
  typeof repoGraphNeighborsQuerySchema
>

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
    aliases: aliasesSchema.optional(),
    positionX: positionSchema.optional(),
    positionY: positionSchema.optional(),
  })
  .strict()

export type AttachRepoInput = z.infer<typeof attachRepoInputSchema>

/**
 * PATCH /api/agents/:agentId/repos/:repoId — update only the per-attachment
 * fields (role / description / aliases / position). The global repo
 * resource stays untouched.
 */
export const attachRepoUpdateInputSchema = z
  .object({
    role: roleSchema.nullable().optional(),
    description: descriptionSchema.nullable().optional(),
    aliases: aliasesSchema.optional(),
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
  aliases: z.array(z.string()),
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

// ─── /api/agents/:agentId/repo-relationships ─────────────────────────────

/**
 * Create a directed relationship between two repos attached to the same agent.
 * Invariants enforced server-side:
 *   - Both `fromRepoId` and `toRepoId` must already be in `agent_repos`
 *     for this agent (membership check in a transaction).
 *   - `fromRepoId !== toRepoId` (DB-level CHECK AND Zod refine).
 *
 * No uniqueness constraint on (from, to, connector): the UI may legitimately
 * want multiple parallel relationships between the same pair with different
 * connector labels ("reads", "writes").
 */
export const repoRelationshipCreateInputSchema = z
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

export type RepoRelationshipCreateInput = z.infer<typeof repoRelationshipCreateInputSchema>

export const repoRelationshipUpdateInputSchema = z
  .object({
    connector: connectorSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })

export type RepoRelationshipUpdateInput = z.infer<typeof repoRelationshipUpdateInputSchema>

export const repoRelationshipResponseSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  fromRepoId: z.uuid(),
  toRepoId: z.uuid(),
  connector: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type RepoRelationshipResponse = z.infer<typeof repoRelationshipResponseSchema>

export const repoRelationshipParamSchema = z.object({
  agentId: z.uuid(),
  relationshipId: z.uuid(),
})
export type RepoRelationshipParam = z.infer<typeof repoRelationshipParamSchema>
