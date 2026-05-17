/**
 * Agent export / import routes (Phase 6e).
 *
 *   - `GET  /api/agents/:id/export`   — returns a JSON bundle of the agent
 *     and its owned resources, suitable for re-import on another install.
 *   - `POST /api/agents/import`        — accepts a bundle and creates the
 *     agent + skills + tools + repo attachments + relationships + MCP allowlist
 *     in one transaction.
 *
 * Bundle shape lives in `@agent-bridge/shared` → `agentExportBundleSchema`.
 * That schema is also the source of truth for what's safe to round-trip
 * (no ciphertexts, no IDs, no Mastra thread/resource ids).
 *
 * Import semantics:
 *   - Slug uniqueness is enforced at the DB layer; the route surfaces
 *     `23505` as a 409 with a hint to pass `slugOverride`.
 *   - Repos are looked up via the existing dedupe rule
 *     (`unique(remote_url, branch)`) and created lazily when missing.
 *     The created row has no PAT — public repos clone fine; private
 *     repos require the operator to attach a PAT post-import.
 *   - MCP allowlist entries reference connection NAMES (since IDs are
 *     install-local). Missing names are skipped with a warning rather
 *     than failing the whole import — partial connectivity is more
 *     useful than no agent.
 */

import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  AGENT_EXPORT_LATEST_VERSION,
  agentExportBundleSchema,
  agentIdParamSchema,
  agentImportInputSchema,
  type AgentExportBundle,
  type AgentImportResponse,
} from '@agent-bridge/shared'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { isPostgresErrorWithCode, PG } from '../lib/pg-errors.js'

export const agentExportRouter = new Hono()
  // ─── GET /api/agents/:id/export ──────────────────────────────────────────
  .get(
    '/:id/export',
    zValidator('param', agentIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { db } = getDb()

      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, id))
        .limit(1)

      if (!agent) {
        return httpError(c, {
          code: 'not_found',
          message: `agent ${id} not found`,
        })
      }

      // Walk skills, tools, attached repos, relationships, MCP allowlist, and
      // Phase 7 bridge tools in parallel — each is independent. We
      // deliberately do NOT pull `llm_providers`: providers carry
      // encrypted secrets and the operator must reattach one after
      // import (see DTO docstring for rationale).
      const [skills, tools, attachedRepos, repoRelationships, mcpAllowlist, bridgeTools] =
        await Promise.all([
          db
            .select({
              name: schema.skills.name,
              markdownBody: schema.skills.markdownBody,
              position: schema.skills.position,
            })
            .from(schema.skills)
            .where(eq(schema.skills.agentId, id))
            .orderBy(asc(schema.skills.position), asc(schema.skills.createdAt)),
          db
            .select({
              kind: schema.tools.kind,
              name: schema.tools.name,
              description: schema.tools.description,
              configJson: schema.tools.configJson,
              position: schema.tools.position,
            })
            .from(schema.tools)
            .where(eq(schema.tools.agentId, id))
            .orderBy(asc(schema.tools.position), asc(schema.tools.createdAt)),
          db
            .select({
              remoteUrl: schema.repos.remoteUrl,
              branch: schema.repos.branch,
              role: schema.agentRepos.role,
              description: schema.agentRepos.description,
              positionX: schema.agentRepos.positionX,
              positionY: schema.agentRepos.positionY,
            })
            .from(schema.agentRepos)
            .innerJoin(
              schema.repos,
              eq(schema.agentRepos.repoId, schema.repos.id),
            )
            .where(eq(schema.agentRepos.agentId, id))
            .orderBy(asc(schema.agentRepos.createdAt)),
          db
            .select({
              fromRemoteUrl: schema.repos.remoteUrl,
              fromBranch: schema.repos.branch,
              connector: schema.repoRelationships.connector,
              description: schema.repoRelationships.description,
              toRepoId: schema.repoRelationships.toRepoId,
            })
            .from(schema.repoRelationships)
            .innerJoin(
              schema.repos,
              eq(schema.repoRelationships.fromRepoId, schema.repos.id),
            )
            .where(eq(schema.repoRelationships.agentId, id))
            .orderBy(asc(schema.repoRelationships.createdAt)),
          db
            .select({
              connectionName: schema.mcpConnections.name,
              toolName: schema.agentMcpTools.toolName,
            })
            .from(schema.agentMcpTools)
            .innerJoin(
              schema.mcpConnections,
              eq(
                schema.agentMcpTools.mcpConnectionId,
                schema.mcpConnections.id,
              ),
            )
            .where(eq(schema.agentMcpTools.agentId, id)),
          db
            .select({
              name: schema.bridgeTools.name,
              description: schema.bridgeTools.description,
              inputSchema: schema.bridgeTools.inputSchema,
              promptTemplate: schema.bridgeTools.promptTemplate,
              enabled: schema.bridgeTools.enabled,
            })
            .from(schema.bridgeTools)
            .where(eq(schema.bridgeTools.agentId, id))
            .orderBy(asc(schema.bridgeTools.name)),
        ])

      // The relationships query above only resolved the `from` side via the
      // join — we still need to map `toRepoId` to `(remoteUrl, branch)`.
      // Cheap second SELECT for the unique repo ids encountered, then a
      // post-process to expand each relationship.
      const toRepoIds = Array.from(new Set(repoRelationships.map((e) => e.toRepoId)))
      const toRepos =
        toRepoIds.length > 0
          ? await db
              .select({
                id: schema.repos.id,
                remoteUrl: schema.repos.remoteUrl,
                branch: schema.repos.branch,
              })
              .from(schema.repos)
              .where(inArray(schema.repos.id, toRepoIds))
          : []
      const toRepoById = new Map(toRepos.map((r) => [r.id, r] as const))

      const expandedRelationships = repoRelationships
        .map((e) => {
          const target = toRepoById.get(e.toRepoId)
          if (!target) return null // FK is `cascade`; missing is unreachable
          return {
            fromRemoteUrl: e.fromRemoteUrl,
            fromBranch: e.fromBranch,
            toRemoteUrl: target.remoteUrl,
            toBranch: target.branch,
            connector: e.connector,
            description: e.description,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)

      const bundle: AgentExportBundle = {
        version: AGENT_EXPORT_LATEST_VERSION,
        exportedAt: new Date().toISOString(),
        agent: {
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          memoryEnabled: agent.memoryEnabled,
          memoryConfig: agent.memoryConfig,
        },
        skills,
        tools: tools.map((t) => ({
          ...t,
          configJson: t.configJson as Record<string, unknown>,
        })),
        repoAttachments: attachedRepos,
        repoRelationships: expandedRelationships,
        mcpAllowlist,
        bridgeTools: bridgeTools.map((t) => ({
          ...t,
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
      }

      // Validate before returning so a schema drift between the DB shape
      // and `agentExportBundleSchema` surfaces here instead of being
      // caught only by a downstream importer.
      const parsed = agentExportBundleSchema.safeParse(bundle)
      if (!parsed.success) {
        return httpError(c, {
          code: 'internal',
          message: `export bundle validation failed: ${parsed.error.message}`,
        })
      }

      // `Content-Disposition` so a curl operator gets a sensible filename.
      // The frontend's download flow doesn't rely on this — it builds the
      // filename from the agent slug client-side.
      c.header(
        'content-disposition',
        `attachment; filename="agent-${agent.slug}.json"`,
      )
      return c.json({ ok: true as const, bundle: parsed.data })
    },
  )
  // ─── POST /api/agents/import ─────────────────────────────────────────────
  .post(
    '/import',
    zValidator('json', agentImportInputSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { bundle, slugOverride } = c.req.valid('json')
      const { db } = getDb()

      const slug = slugOverride ?? bundle.agent.slug
      const warnings: string[] = []

      // The whole import runs in one transaction — partial state on a
      // mid-import failure would leave orphan rows that the operator
      // would have to clean up by hand. Drizzle's `db.transaction`
      // shares the same handle so all reads inside see uncommitted
      // writes, which we need for the foreign-key chain (agent → its
      // skills/tools, repo find-or-create → attachment, etc.).
      try {
        const result = await db.transaction(async (tx) => {
          // 1. Create the agent row.
          const [agent] = await tx
            .insert(schema.agents)
            .values({
              slug,
              name: bundle.agent.name,
              description: bundle.agent.description ?? null,
              systemPrompt: bundle.agent.systemPrompt,
              llmProviderId: null, // intentional — see DTO docstring
              memoryEnabled: bundle.agent.memoryEnabled,
              memoryConfig: bundle.agent.memoryConfig ?? null,
            })
            .returning({ id: schema.agents.id })
          if (!agent) throw new Error('insert returned no rows for agent')

          // 2. Skills.
          if (bundle.skills.length > 0) {
            await tx.insert(schema.skills).values(
              bundle.skills.map((s) => ({
                agentId: agent.id,
                name: s.name,
                markdownBody: s.markdownBody,
                position: s.position,
              })),
            )
          }

          // 3. Native tools.
          if (bundle.tools.length > 0) {
            await tx.insert(schema.tools).values(
              bundle.tools.map((t) => ({
                agentId: agent.id,
                kind: t.kind,
                name: t.name,
                description: t.description ?? null,
                configJson: t.configJson,
                position: t.position,
              })),
            )
          }

          // 4. Repo attachments. Find-or-create per `(remoteUrl, branch)`.
          //    Map kept so step 5 (relationships) can resolve from-id and to-id
          //    without re-querying.
          const repoIdByKey = new Map<string, string>()
          const keyOf = (url: string, branch: string) => `${url} ${branch}`
          for (const att of bundle.repoAttachments) {
            const key = keyOf(att.remoteUrl, att.branch)
            let repoId = repoIdByKey.get(key)
            if (!repoId) {
              const [existing] = await tx
                .select({ id: schema.repos.id })
                .from(schema.repos)
                .where(
                  and(
                    eq(schema.repos.remoteUrl, att.remoteUrl),
                    eq(schema.repos.branch, att.branch),
                  ),
                )
                .limit(1)
              if (existing) {
                repoId = existing.id
              } else {
                const [created] = await tx
                  .insert(schema.repos)
                  .values({
                    remoteUrl: att.remoteUrl,
                    branch: att.branch,
                  })
                  .returning({ id: schema.repos.id })
                if (!created) throw new Error('insert returned no rows for repo')
                repoId = created.id
              }
              repoIdByKey.set(key, repoId)
            }
            await tx.insert(schema.agentRepos).values({
              agentId: agent.id,
              repoId,
              role: att.role ?? null,
              description: att.description ?? null,
              positionX: att.positionX,
              positionY: att.positionY,
            })
          }

          // 5. Repo relationships. Both endpoints must already be in our
          //    attachment map (the export endpoint only emits relationships
          //    rooted in attached repos). If not, skip with a warning —
          //    a torn export is partial-import-friendly.
          let relationshipImported = 0
          for (const edge of bundle.repoRelationships) {
            const fromKey = keyOf(edge.fromRemoteUrl, edge.fromBranch)
            const toKey = keyOf(edge.toRemoteUrl, edge.toBranch)
            const fromId = repoIdByKey.get(fromKey)
            const toId = repoIdByKey.get(toKey)
            if (!fromId || !toId) {
              warnings.push(
                `skipping repo relationship ${edge.fromRemoteUrl}#${edge.fromBranch} → ` +
                  `${edge.toRemoteUrl}#${edge.toBranch}: endpoint not attached`,
              )
              continue
            }
            await tx.insert(schema.repoRelationships).values({
              agentId: agent.id,
              fromRepoId: fromId,
              toRepoId: toId,
              connector: edge.connector,
              description: edge.description ?? null,
            })
            relationshipImported++
          }

          // 6. MCP allowlist. Look up each connection by NAME on this
          //    install; missing names are skipped with a warning. We
          //    intentionally don't auto-create connection rows — they
          //    encode environment-specific config (commands, URLs, env
          //    vars) that should be set up explicitly by the operator.
          let mcpImported = 0
          if (bundle.mcpAllowlist.length > 0) {
            const wantedNames = Array.from(
              new Set(bundle.mcpAllowlist.map((e) => e.connectionName)),
            )
            const conns = await tx
              .select({
                id: schema.mcpConnections.id,
                name: schema.mcpConnections.name,
              })
              .from(schema.mcpConnections)
              .where(inArray(schema.mcpConnections.name, wantedNames))
            const idByName = new Map(conns.map((c) => [c.name, c.id] as const))
            for (const entry of bundle.mcpAllowlist) {
              const connId = idByName.get(entry.connectionName)
              if (!connId) {
                warnings.push(
                  `skipping mcp allowlist entry "${entry.connectionName}::${entry.toolName}": ` +
                    `no connection named "${entry.connectionName}" on this install`,
                )
                continue
              }
              await tx.insert(schema.agentMcpTools).values({
                agentId: agent.id,
                mcpConnectionId: connId,
                toolName: entry.toolName,
                enabled: true,
              })
              mcpImported++
            }
          }

          // 7. Phase 7 bridge tools. Optional — v1 bundles don't carry
          //    them. Names are GLOBALLY unique on `bridge_tools.name`
          //    (MCP spec: per-server uniqueness), so we pre-check for
          //    collisions and skip them with a warning. A throw inside
          //    the transaction would abort the whole import; pre-
          //    checking is the correct way to "partial-import" here.
          const bridgeToolsToImport = bundle.bridgeTools ?? []
          let bridgeToolsImported = 0
          if (bridgeToolsToImport.length > 0) {
            const wantedNames = bridgeToolsToImport.map((bt) => bt.name)
            const existing = await tx
              .select({ name: schema.bridgeTools.name })
              .from(schema.bridgeTools)
              .where(inArray(schema.bridgeTools.name, wantedNames))
            const taken = new Set(existing.map((r) => r.name))

            const acceptable = bridgeToolsToImport.filter((bt) => {
              if (taken.has(bt.name)) {
                warnings.push(
                  `skipping bridge tool "${bt.name}": name already in use on this install`,
                )
                return false
              }
              return true
            })

            if (acceptable.length > 0) {
              await tx.insert(schema.bridgeTools).values(
                acceptable.map((bt) => ({
                  agentId: agent.id,
                  name: bt.name,
                  description: bt.description,
                  inputSchema: bt.inputSchema,
                  promptTemplate: bt.promptTemplate,
                  enabled: bt.enabled,
                })),
              )
              bridgeToolsImported = acceptable.length
            }
          }

          return {
            agentId: agent.id,
            summary: {
              skills: bundle.skills.length,
              tools: bundle.tools.length,
              repoAttachments: bundle.repoAttachments.length,
              repoRelationships: relationshipImported,
              mcpAllowlist: mcpImported,
              bridgeTools: bridgeToolsImported,
            },
          }
        })

        const response: AgentImportResponse = {
          ok: true,
          agentId: result.agentId,
          summary: result.summary,
          warnings,
        }
        return c.json(response, 201)
      } catch (err) {
        if (isPostgresErrorWithCode(err, PG.UNIQUE_VIOLATION)) {
          return httpError(c, {
            code: 'conflict',
            message: `slug "${slug}" is already in use — pass slugOverride to import under a different slug`,
          })
        }
        throw err
      }
    },
  )

export type AgentExportRouter = typeof agentExportRouter
