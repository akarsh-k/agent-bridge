/**
 * Read operator-curated cross-repo edges for an agent
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Used by `assess_change_impact` to fan blast-radius analysis from a
 * change's primary repo into related repos. Edges are agent-scoped —
 * two agents can model the same repo pair differently — so the lookup
 * is keyed by `(agentId, fromRepoId)`.
 *
 * Read-only; mutations live in `apps/backend/src/routes/repo-edges.ts`.
 */

import { and, eq } from 'drizzle-orm'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import type { AttachedRepo } from '@agent-bridge/shared'

import type { MiniRepoCrossRepoEdge } from './types.js'

// Re-export so wrappers don't have to import both modules.
export type { MiniRepoCrossRepoEdge } from './types.js'

export interface LoadOutgoingEdgesInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Source repo id. Returns edges where `from_repo_id = fromRepoId`.
   * `assess_change_impact` uses outgoing edges to find repos the
   * change explicitly points TO (consumers it deploys to, services it
   * mirrors a type into).
   */
  readonly fromRepoId: string
  /**
   * Restrict the result to attached repos in `attached`. Filters out
   * edges that point to repos no longer attached to the agent (the
   * `agent_repos` row could have been detached without cleaning up
   * edges, though the cascade FK normally prevents that).
   */
  readonly attached: readonly AttachedRepo[]
}

export interface LoadIncomingEdgesInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Target repo id. Returns edges where `to_repo_id = toRepoId`.
   * `assess_change_impact` uses incoming edges to find repos that
   * point AT the changed repo (callers, importers, type mirrors). An
   * asymmetric edge `frontend --calls--> backend` is invisible to
   * `loadOutgoingRepoEdges({fromRepoId: backend.id})`; this loader
   * fills that gap.
   */
  readonly toRepoId: string
  readonly attached: readonly AttachedRepo[]
}

/** @deprecated Use {@link LoadOutgoingEdgesInput}. Re-exported for callers
 *  that imported the original name; remove once no caller references it. */
export type LoadEdgesInput = LoadOutgoingEdgesInput

export interface CrossRepoEdgeWithTarget {
  readonly edge: MiniRepoCrossRepoEdge
  readonly target: AttachedRepo
}

/**
 * Load edges originating from `fromRepoId` and resolve their `to`
 * endpoint against the agent's attached repos. Edges that point to a
 * repo the agent isn't currently attached to are dropped (edge case;
 * see docstring above).
 *
 * Returns `[]` when the agent has no edges or none originate from
 * `fromRepoId`. Wrappers treat that as "no cross-repo expansion
 * applicable" rather than an error.
 */
export async function loadOutgoingRepoEdges(
  input: LoadOutgoingEdgesInput,
): Promise<CrossRepoEdgeWithTarget[]> {
  const { db, agentId, fromRepoId, attached } = input

  const rows = await db.db
    .select({
      toRepoId: schema.repoEdges.toRepoId,
      connector: schema.repoEdges.connector,
      description: schema.repoEdges.description,
    })
    .from(schema.repoEdges)
    .where(
      and(
        eq(schema.repoEdges.agentId, agentId),
        eq(schema.repoEdges.fromRepoId, fromRepoId),
      ),
    )

  if (rows.length === 0) return []

  const attachedById = new Map(attached.map((r) => [r.repo_id, r]))
  const out: CrossRepoEdgeWithTarget[] = []
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
      } satisfies MiniRepoCrossRepoEdge,
    })
  }
  return out
}

/**
 * Mirror of {@link loadOutgoingRepoEdges} that walks the other side of
 * the edge. Returns each edge along with the SOURCE repo (the one that
 * points at `toRepoId`). The two loaders together give the wrapper
 * symmetric blast-radius coverage even though the underlying edges are
 * directional.
 */
export async function loadIncomingRepoEdges(
  input: LoadIncomingEdgesInput,
): Promise<CrossRepoEdgeWithTarget[]> {
  const { db, agentId, toRepoId, attached } = input

  const rows = await db.db
    .select({
      fromRepoId: schema.repoEdges.fromRepoId,
      connector: schema.repoEdges.connector,
      description: schema.repoEdges.description,
    })
    .from(schema.repoEdges)
    .where(
      and(
        eq(schema.repoEdges.agentId, agentId),
        eq(schema.repoEdges.toRepoId, toRepoId),
      ),
    )

  if (rows.length === 0) return []

  const attachedById = new Map(attached.map((r) => [r.repo_id, r]))
  const out: CrossRepoEdgeWithTarget[] = []
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
      } satisfies MiniRepoCrossRepoEdge,
    })
  }
  return out
}
