/**
 * Read operator-curated cross-repo relationships for an agent
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Used by `assess_change_impact` to fan blast-radius analysis from a
 * change's primary repo into related repos. Relationships are agent-scoped —
 * two agents can model the same repo pair differently — so the lookup
 * is keyed by `(agentId, fromRepoId)`.
 *
 * Read-only; mutations live in `apps/backend/src/routes/repo-relationships.ts`.
 */

import { and, eq } from 'drizzle-orm'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import type { AttachedRepo } from '@agent-bridge/shared'

import type { CodebaseInspectionReportCrossRepoRelationship } from './types.js'

// Re-export so wrappers don't have to import both modules.
export type { CodebaseInspectionReportCrossRepoRelationship } from './types.js'

export interface LoadOutgoingRelationshipsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Source repo id. Returns relationships where `from_repo_id = fromRepoId`.
   * `assess_change_impact` uses outgoing relationships to find repos the
   * change explicitly points TO (consumers it deploys to, services it
   * mirrors a type into).
   */
  readonly fromRepoId: string
  /**
   * Restrict the result to attached repos in `attached`. Filters out
   * relationships that point to repos no longer attached to the agent (the
   * `agent_repos` row could have been detached without cleaning up
   * relationships, though the cascade FK normally prevents that).
   */
  readonly attached: readonly AttachedRepo[]
}

export interface LoadIncomingRelationshipsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Target repo id. Returns relationships where `to_repo_id = toRepoId`.
   * `assess_change_impact` uses incoming relationships to find repos that
   * point AT the changed repo (callers, importers, type mirrors). An
   * asymmetric relationship `frontend --calls--> backend` is invisible to
   * `loadOutgoingRepoRelationships({fromRepoId: backend.id})`; this loader
   * fills that gap.
   */
  readonly toRepoId: string
  readonly attached: readonly AttachedRepo[]
}

export interface LoadAllRepoRelationshipsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Restrict the result to relationships whose BOTH endpoints are attached to
   * the agent today. Same filtering rationale as the per-endpoint
   * loaders — an orphaned relationship to a detached repo is just noise.
   */
  readonly attached: readonly AttachedRepo[]
}

/** @deprecated Use {@link LoadOutgoingRelationshipsInput}. Re-exported for callers
 *  that imported the original name; remove once no caller references it. */
export type LoadRelationshipsInput = LoadOutgoingRelationshipsInput

export interface CrossRepoRelationshipWithTarget {
  readonly edge: CodebaseInspectionReportCrossRepoRelationship
  readonly target: AttachedRepo
}

/**
 * Load relationships originating from `fromRepoId` and resolve their `to`
 * endpoint against the agent's attached repos. Relationships that point to a
 * repo the agent isn't currently attached to are dropped (edge case;
 * see docstring above).
 *
 * Returns `[]` when the agent has no relationships or none originate from
 * `fromRepoId`. Wrappers treat that as "no cross-repo expansion
 * applicable" rather than an error.
 */
export async function loadOutgoingRepoRelationships(
  input: LoadOutgoingRelationshipsInput,
): Promise<CrossRepoRelationshipWithTarget[]> {
  const { db, agentId, fromRepoId, attached } = input

  const rows = await db.db
    .select({
      toRepoId: schema.repoRelationships.toRepoId,
      connector: schema.repoRelationships.connector,
      description: schema.repoRelationships.description,
    })
    .from(schema.repoRelationships)
    .where(
      and(
        eq(schema.repoRelationships.agentId, agentId),
        eq(schema.repoRelationships.fromRepoId, fromRepoId),
      ),
    )

  if (rows.length === 0) return []

  const attachedById = new Map(attached.map((r) => [r.repo_id, r]))
  const out: CrossRepoRelationshipWithTarget[] = []
  for (const r of rows) {
    const target = attachedById.get(r.toRepoId)
    if (!target) continue
    out.push({
      target,
      edge: {
        from_repo: fromRepoId,
        to_repo: r.toRepoId,
        connector: r.connector,
        description: r.description,
      } satisfies CodebaseInspectionReportCrossRepoRelationship,
    })
  }
  return out
}

/**
 * Mirror of {@link loadOutgoingRepoRelationships} that walks the other side of
 * the relationship. Returns each relationship along with the SOURCE repo (the one that
 * points at `toRepoId`). The two loaders together give the wrapper
 * symmetric blast-radius coverage even though the underlying relationships are
 * directional.
 */
export async function loadIncomingRepoRelationships(
  input: LoadIncomingRelationshipsInput,
): Promise<CrossRepoRelationshipWithTarget[]> {
  const { db, agentId, toRepoId, attached } = input

  const rows = await db.db
    .select({
      fromRepoId: schema.repoRelationships.fromRepoId,
      connector: schema.repoRelationships.connector,
      description: schema.repoRelationships.description,
    })
    .from(schema.repoRelationships)
    .where(
      and(
        eq(schema.repoRelationships.agentId, agentId),
        eq(schema.repoRelationships.toRepoId, toRepoId),
      ),
    )

  if (rows.length === 0) return []

  const attachedById = new Map(attached.map((r) => [r.repo_id, r]))
  const out: CrossRepoRelationshipWithTarget[] = []
  for (const r of rows) {
    const target = attachedById.get(r.fromRepoId)
    if (!target) continue
    out.push({
      target,
      edge: {
        from_repo: r.fromRepoId,
        to_repo: toRepoId,
        connector: r.connector,
        description: r.description,
      } satisfies CodebaseInspectionReportCrossRepoRelationship,
    })
  }
  return out
}

/**
 * Load every cross-repo relationship declared on the agent, filtered to relationships
 * whose both endpoints are currently attached. Used by the bridge's
 * `inspect_codebase` envelope so the IDE always sees the full repo
 * topology — not just the slice an individual wrapper expanded.
 */
export async function loadAllRepoRelationships(
  input: LoadAllRepoRelationshipsInput,
): Promise<CodebaseInspectionReportCrossRepoRelationship[]> {
  const { db, agentId, attached } = input

  const rows = await db.db
    .select({
      fromRepoId: schema.repoRelationships.fromRepoId,
      toRepoId: schema.repoRelationships.toRepoId,
      connector: schema.repoRelationships.connector,
      description: schema.repoRelationships.description,
    })
    .from(schema.repoRelationships)
    .where(eq(schema.repoRelationships.agentId, agentId))

  if (rows.length === 0) return []

  const attachedIds = new Set(attached.map((r) => r.repo_id))
  const out: CodebaseInspectionReportCrossRepoRelationship[] = []
  for (const r of rows) {
    if (!attachedIds.has(r.fromRepoId) || !attachedIds.has(r.toRepoId)) continue
    out.push({
      from_repo: r.fromRepoId,
      to_repo: r.toRepoId,
      connector: r.connector,
      description: r.description,
    })
  }
  return out
}
