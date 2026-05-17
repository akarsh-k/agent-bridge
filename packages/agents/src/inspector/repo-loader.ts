/**
 * Single source of truth for "what repos does this agent see?". Used
 * by the inspector toolkit (`list_repos` wrapper) and the resolver
 * (`resolveRepoHint`). One query per tool call; the result is the
 * candidate set for `resolveRepoHint` AND the user-facing repo list
 * for `list_repos`.
 *
 * Returns the AttachedRepo wire shape (from `@agent-bridge/shared`) so
 * the bridge handler can serialise it without re-massaging fields.
 *
 * Repos in any status are returned. the resolver downgrades non-ready
 * repos to a `repo_not_ready` outcome rather than dropping them, so an
 * IDE call against a repo that's still indexing surfaces a clear
 * error instead of "repo not found".
 */

import { and, eq } from 'drizzle-orm'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import type { AttachedRepo } from '@agent-bridge/shared'

import { urlTail } from './url-normalize.js'

export interface LoadAttachedReposInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * When `true`, only return rows whose underlying `repos.status` is
   * `'ready'`. The bridge's `list_repos` tool sets this `false` (the
   * IDE benefits from seeing pending/erroring repos so the user
   * understands why a question can't be answered yet); the resolver
   * pre-filter sets it `false` too and uses the `status` field to
   * branch.
   */
  readonly readyOnly?: boolean
}

/**
 * One join over `agent_repos` × `repos`. Stable ordering by `label`
 * so the IDE list and the resolver's `score_table` read the same way
 * across calls.
 */
export async function loadAttachedRepos(
  input: LoadAttachedReposInput,
): Promise<AttachedRepo[]> {
  const { db, agentId, readyOnly = false } = input

  const baseWhere = readyOnly
    ? and(
        eq(schema.agentRepos.agentId, agentId),
        eq(schema.repos.status, 'ready'),
      )
    : eq(schema.agentRepos.agentId, agentId)

  const rows = await db.db
    .select({
      repoId: schema.repos.id,
      remoteUrl: schema.repos.remoteUrl,
      branch: schema.repos.branch,
      status: schema.repos.status,
      role: schema.agentRepos.role,
      description: schema.agentRepos.description,
      aliases: schema.agentRepos.aliases,
    })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(baseWhere)

  const out: AttachedRepo[] = rows.map((r) => {
    const role = r.role?.trim() || null
    const description = r.description?.trim() || null
    return {
      repo_id: r.repoId,
      remote_url: r.remoteUrl,
      branch: r.branch,
      label: role ?? urlTail(r.remoteUrl) ?? 'repo',
      role,
      description,
      // DTO has already trimmed/lowercased/de-duped these on the
      // write path (`aliasesSchema` in `dtos/repos.ts`); the column
      // is `not null default '[]'` so the `?? []` belt-and-braces
      // is just for the TS type narrowing, not a behavior fallback.
      aliases: r.aliases ?? [],
      status: r.status,
    }
  })

  // Sort by label so consumers don't have to. Stable + cheap; postgres
  // doesn't have a free index on this synthesised field.
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}
