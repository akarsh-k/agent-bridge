/**
 * Agent export / import DTOs.
 *
 * The export bundle is a self-contained snapshot of one agent and the
 * resources owned by it: its row, its skills, its native tools, the
 * repos it has attached (referenced by `(remoteUrl, branch)` since IDs
 * differ per install), the directed edges between those repos, and the
 * MCP-tool allowlist (referenced by connection NAME, since connection
 * IDs are also install-local). Anything that lives on a different
 * trust boundary stays out:
 *
 *   - `id`, `createdAt`, `updatedAt` — server-owned, regenerated on import.
 *   - `llmProviderId` — providers carry secrets and credentials. The
 *     importer must reattach a provider after creating the agent.
 *   - `mastraThreadId`, `mastraResourceId` — belong to the source
 *     Mastra installation; importing into a different Mastra install
 *     would point at threads that don't exist there.
 *   - Any `*_envelope` ciphertext — round-tripping plaintext secrets
 *     through JSON is unsafe (operator's filesystem, clipboard, etc.).
 *     Repos requiring a PAT must have it re-attached after import.
 *
 * Why `(remoteUrl, branch)` instead of repo IDs:
 *   - The repo dedupe rule is already `unique(remote_url, branch)`. An
 *     importer running on a fresh DB can find-or-create deterministically
 *     using the same key. If the target install already has the same
 *     repo attached to a different agent, we attach the same row — no
 *     duplicate clones, no wasted disk.
 *
 * Why the MCP allowlist references the connection NAME:
 *   - Connection rows are global (`mcp_connections.name` is unique). If
 *     the target install has a connection with the same name, the
 *     importer attaches the allowlist entry; otherwise the entry is
 *     skipped with a warning. We do NOT import connection rows
 *     themselves — they encode environment-specific config (commands,
 *     URLs, env vars) that probably shouldn't replicate verbatim.
 */

import { z } from 'zod'
import { toolKinds } from '../domain.js'
import { agentMemoryConfigSchema } from './memory.js'

// Local copies of constraints from agents.ts / skills.ts / tools.ts.
// We don't re-import the source schemas because those input/update
// schemas have additional constraints (e.g. `.strict()` on the parent
// object, refinements that reject empty patches) that wouldn't apply
// to an export bundle. The duplication keeps the import-time validator
// authoritative without coupling export evolution to CRUD evolution.
const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'invalid slug')
const remoteUrlSchema = z.string().min(1).max(2_048)
const branchSchema = z.string().min(1).max(255)
const positionSchema = z.number().int().nonnegative().max(1_000_000)
const optionalShortText = z
  .string()
  .max(10_000)
  .nullable()
  .optional()
const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
const configJsonSchema = z.record(z.string(), z.unknown())
const toolKindSchema = z.enum(toolKinds)

// ─── Versioning ──────────────────────────────────────────────────────────

/**
 * Schema version for the export bundle. Bumped on breaking changes; the
 * importer rejects bundles whose `version` it doesn't recognise. Kept
 * separate from `LATEST_VERSION` so the literal isn't accidentally
 * written in a non-bumpable place.
 */
export const AGENT_EXPORT_LATEST_VERSION = 2 as const

/**
 * Older bundles used `version: 1` and didn't have the
 * `bridgeTools` field. We accept both versions on import so older
 * exports keep working — the importer treats a missing `bridgeTools`
 * key as an empty array.
 */
export const AGENT_EXPORT_SUPPORTED_VERSIONS = [1, 2] as const

// ─── Skill / tool / repo / edge sub-shapes ───────────────────────────────

const exportedSkillSchema = z
  .object({
    name: skillNameSchema,
    markdownBody: z.string().max(64_000),
    position: positionSchema,
  })
  .strict()

const exportedToolSchema = z
  .object({
    kind: toolKindSchema,
    name: z.string().min(1).max(120),
    description: optionalShortText,
    configJson: configJsonSchema,
    position: positionSchema,
  })
  .strict()

const exportedRepoAttachmentSchema = z
  .object({
    remoteUrl: remoteUrlSchema,
    branch: branchSchema,
    role: z.string().max(120).nullable().optional(),
    description: optionalShortText,
    positionX: z.number().int(),
    positionY: z.number().int(),
  })
  .strict()

const exportedRepoEdgeSchema = z
  .object({
    fromRemoteUrl: remoteUrlSchema,
    fromBranch: branchSchema,
    toRemoteUrl: remoteUrlSchema,
    toBranch: branchSchema,
    connector: z.string().min(1).max(120),
    description: optionalShortText,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.fromRemoteUrl === v.toRemoteUrl && v.fromBranch === v.toBranch) {
      ctx.addIssue({
        code: 'custom',
        path: ['toRemoteUrl'],
        message: 'edge endpoints must be distinct',
      })
    }
  })

const exportedMcpAllowlistEntrySchema = z
  .object({
    connectionName: z.string().min(1).max(120),
    toolName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/, 'invalid MCP tool name'),
  })
  .strict()

/**
 * An exported `bridge_tools` row. The DB CHECK constraints
 * (reserved-prefix and identifier format) ARE re-applied at the import
 * boundary by the route's INSERT — but we also re-validate here so a
 * bundle hand-edited on disk fails parsing before the DB sees it.
 */
const exportedBridgeToolSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'invalid bridge tool name')
      .refine((v) => !v.startsWith('query_'), {
        message: '"query_" prefix is reserved for the auto-derived default tool',
      }),
    description: z.string().max(1_000),
    inputSchema: z.record(z.string(), z.unknown()),
    promptTemplate: z.string().max(20_000),
    enabled: z.boolean(),
  })
  .strict()

// ─── Agent core ──────────────────────────────────────────────────────────

const exportedAgentCoreSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).nullable().optional(),
    systemPrompt: z.string().max(50_000),
    memoryEnabled: z.boolean(),
    memoryConfig: agentMemoryConfigSchema.nullable().optional(),
  })
  .strict()

// ─── Bundle ──────────────────────────────────────────────────────────────

export const agentExportBundleSchema = z
  .object({
    /**
     * Bundle schema version. Producers always emit
     * `AGENT_EXPORT_LATEST_VERSION`; importers accept any version in
     * `AGENT_EXPORT_SUPPORTED_VERSIONS` for backward compatibility.
     */
    version: z.union([z.literal(1), z.literal(2)]),
    /** ISO-8601 timestamp of when the export was generated. Informational. */
    exportedAt: z.iso.datetime(),
    agent: exportedAgentCoreSchema,
    skills: z.array(exportedSkillSchema).max(1_000),
    tools: z.array(exportedToolSchema).max(1_000),
    repoAttachments: z.array(exportedRepoAttachmentSchema).max(1_000),
    repoEdges: z.array(exportedRepoEdgeSchema).max(10_000),
    mcpAllowlist: z.array(exportedMcpAllowlistEntrySchema).max(1_000),
    /**
     * Outbound bridge tools. Optional in the schema so older bundles
     * still parse; importer treats absence as an empty array.
     */
    bridgeTools: z.array(exportedBridgeToolSchema).max(1_000).optional(),
  })
  .strict()

export type AgentExportBundle = z.infer<typeof agentExportBundleSchema>

// ─── Import-time options ─────────────────────────────────────────────────

/**
 * Knobs the operator can flip when uploading a bundle. Currently the
 * only knob is `slugOverride` so an import doesn't conflict with an
 * existing agent on the same slug.
 */
export const agentImportInputSchema = z
  .object({
    bundle: agentExportBundleSchema,
    /**
     * Override the bundle's slug at import time. Useful when re-importing
     * an agent into the same install or when the bundle's slug is already
     * taken. Must satisfy the same slug rule as `agents.slug`.
     */
    slugOverride: slugSchema.optional(),
  })
  .strict()

export type AgentImportInput = z.infer<typeof agentImportInputSchema>

// ─── Import response ─────────────────────────────────────────────────────

export const agentImportResponseSchema = z.object({
  ok: z.literal(true),
  agentId: z.uuid(),
  /**
   * Per-section import counts. `skipped` rows are non-fatal: the
   * importer logs them on stderr, returns the structured warnings, and
   * still imports the rest. Typical reason: an MCP allowlist entry
   * pointed at a connection name that doesn't exist on the target
   * install. The operator can re-add it manually after creating the
   * connection.
   */
  summary: z.object({
    skills: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    repoAttachments: z.number().int().nonnegative(),
    repoEdges: z.number().int().nonnegative(),
    mcpAllowlist: z.number().int().nonnegative(),
    bridgeTools: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()).max(100),
})

export type AgentImportResponse = z.infer<typeof agentImportResponseSchema>
