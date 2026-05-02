/**
 * Process-level `BuiltAgent` cache. Mirrors the way IDE-side MCP clients
 * (Cursor, Claude Code, Claude Desktop) keep MCP subprocesses alive across
 * tool calls — spawn once, reuse for the rest of the session. Without
 * this, every chat turn pays the full cold-start tax: spawn the MCP
 * subprocess, run `initialize`, call `tools/list`, then tear it down
 * after the run. On a Notion-attached agent that was 4–6 seconds before
 * the LLM saw the prompt.
 *
 * Design:
 *   - Cache key: `agentId`. One cached `BuiltAgent` per agent at a time.
 *   - Invalidation: a content hash over the relevant `updated_at` columns
 *     (agent + skills + tools + repos + repo_edges + mcp_connections +
 *     allowlist + provider) is recomputed on every `getOrBuild`. If the
 *     hash drifts from the cached entry's, we tear the entry down and
 *     build fresh. Cheap (single SQL round-trip with mostly-aggregate
 *     LEFT JOINs); shifts the entire invalidation surface from "every
 *     mutating route remembers to call invalidate()" to "the database
 *     is the source of truth" — which is the only honest choice for a
 *     repo where mutations also flow in via worker jobs (clone/index
 *     status, wiki regen) and direct SQL.
 *   - In-flight de-dup: two concurrent `getOrBuild` calls for the same
 *     agent share one build promise. Otherwise a chat-tool-call burst
 *     could spawn N parallel Notion subprocesses for the same agent.
 *   - Eviction: LRU with `MAX_ENTRIES`; idle entries past `TTL_MS` are
 *     also dropped on every access. Both bounds are conservative — a
 *     single-operator dev box rarely has more than a handful of agents
 *     active concurrently, and idle cleanup keeps the MCP subprocess
 *     pool from accumulating zombies during a long uptime.
 *   - Process exit: backend's graceful-shutdown path calls `dispose()`
 *     to disconnect every cached MCP subprocess. Skipping this leaks
 *     children when the tsx watcher restarts.
 *
 * Security note: each cached `BuiltAgent` carries decrypted plaintext
 * secrets in memory (provider apiKey, MCP env/header values) for the
 * lifetime of the cache entry. That's the same trust boundary as the
 * master key file on disk — the backend process is trusted; if it isn't,
 * losing the master key already loses everything. Worth flagging if we
 * ever expose this beyond a single-operator local app.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'

import { EXPECTED_GITNEXUS_VERSION } from '@agent-bridge/shared/gitnexus'
import { buildAgent, type BuildAgentInput, type BuiltAgent } from './build-agent.js'
import { CODING_AGENT_SYSTEM_SKILL_VERSION } from './coding-agent/system-skill.js'

const MAX_ENTRIES = 8
const TTL_MS = 30 * 60_000

interface CacheEntry {
  built: BuiltAgent
  /**
   * Snapshot of the version hash at build time. We compare against a
   * freshly-computed hash on every `getOrBuild` to decide whether the
   * cache entry is still valid. If anything changes (skill edit, MCP
   * allowlist update, repo clone status, etc.) the hash drifts and we
   * rebuild.
   */
  version: string
  lastUsed: number
}

class BuiltAgentCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<BuiltAgent>>()

  async getOrBuild(input: BuildAgentInput): Promise<BuiltAgent> {
    const { db, agentId } = input
    const version = await computeAgentVersion(db, agentId)

    const cached = this.entries.get(agentId)
    if (cached && cached.version === version) {
      cached.lastUsed = Date.now()
      this.evictExpired(Date.now())
      return cached.built
    }

    // De-dup concurrent builds for the same agent. Two chat turns
    // (or a chat + a bridge call) racing the cache see the same
    // promise, and only one MCP subprocess is spawned.
    const existing = this.inFlight.get(agentId)
    if (existing) return existing

    const pending = this.buildAndInsert(input, version, cached)
    this.inFlight.set(agentId, pending)
    pending.finally(() => {
      this.inFlight.delete(agentId)
    })
    return pending
  }

  /**
   * Forcibly evict a single agent — used by the rare paths that mutate
   * cached state out-of-band. The version-hash check covers most
   * invalidation already; this is the escape hatch.
   */
  async invalidate(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId)
    if (!entry) return
    this.entries.delete(agentId)
    try {
      await entry.built.disconnect()
    } catch (err) {
      console.error(
        `[built-agent-cache] disconnect during invalidate(${agentId}) failed:`,
        err,
      )
    }
  }

  /**
   * Tear every cached agent down. Wired into the backend's graceful
   * shutdown so MCP subprocesses don't outlive the parent.
   */
  async dispose(): Promise<void> {
    const tasks = Array.from(this.entries.values()).map((e) =>
      e.built.disconnect().catch((err) => {
        console.error('[built-agent-cache] disconnect during dispose failed:', err)
      }),
    )
    this.entries.clear()
    await Promise.allSettled(tasks)
  }

  /** Snapshot for /health-style introspection. Cheap. */
  size(): number {
    return this.entries.size
  }

  private async buildAndInsert(
    input: BuildAgentInput,
    version: string,
    stale: CacheEntry | undefined,
  ): Promise<BuiltAgent> {
    // Drop the stale entry FIRST so the new MCP subprocess doesn't
    // briefly coexist with the old one for the same agent — that would
    // confuse `LogBroker` subscribers and potentially double-publish
    // stderr lines.
    if (stale) {
      this.entries.delete(input.agentId)
      try {
        await stale.built.disconnect()
      } catch (err) {
        console.error(
          `[built-agent-cache] disconnect of stale entry for ${input.agentId} failed:`,
          err,
        )
      }
    }

    const built = await buildAgent(input)
    this.entries.set(input.agentId, {
      built,
      version,
      lastUsed: Date.now(),
    })
    this.evictIfFull()
    this.evictExpired(Date.now())
    return built
  }

  private evictIfFull(): void {
    while (this.entries.size > MAX_ENTRIES) {
      let oldestId: string | null = null
      let oldestTs = Infinity
      for (const [id, entry] of this.entries) {
        if (entry.lastUsed < oldestTs) {
          oldestTs = entry.lastUsed
          oldestId = id
        }
      }
      if (oldestId === null) break
      const victim = this.entries.get(oldestId)
      this.entries.delete(oldestId)
      if (victim) {
        victim.built.disconnect().catch((err) => {
          console.error(
            `[built-agent-cache] LRU disconnect for ${oldestId} failed:`,
            err,
          )
        })
      }
    }
  }

  private evictExpired(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsed > TTL_MS) {
        this.entries.delete(id)
        entry.built.disconnect().catch((err) => {
          console.error(`[built-agent-cache] TTL disconnect for ${id} failed:`, err)
        })
      }
    }
  }
}

// Module-level singleton — there is exactly one cache per backend
// process. Bridge + UI dispatchers share it because they both run in
// the same node process today. The module-level export lives outside
// the class so test harnesses can construct their own isolated cache
// without fighting with the singleton.
export const builtAgentCache = new BuiltAgentCache()

/**
 * Compute a content-hash that drifts whenever anything that affects the
 * BuiltAgent's runtime config changes. Includes:
 *   - The agent's own row (`updated_at`, `llm_provider_id`).
 *   - Max(updated_at) across the agent's skills, tools, attached
 *     `agent_repos` rows, and `repo_edges`.
 *   - Max(updated_at) across the `repos` rows the agent attaches —
 *     critical for the gitnexus mount, which only fires when at least
 *     one repo is `status='ready'`. A clone/index transition flips that
 *     status so the cache must rebuild.
 *   - Max(updated_at) across `mcp_connections` referenced in the
 *     agent's allowlist (so editing a connection's env/headers/auth
 *     drops the cached subprocess).
 *   - Max(created_at) across `agent_mcp_tools` (the join table itself
 *     has no updated_at; rows are insert/delete-only via PUT).
 *   - The provider row's `updated_at` (model id, base URL, embedding
 *     model — all live in the BuiltAgent).
 *
 * Returns an empty string when the agent doesn't exist; the caller
 * surfaces "agent not found" via `buildAgent` in that case.
 *
 * Implementation uses raw `pg.Pool` rather than Drizzle: the query
 * is straightforward SQL with cross-table aggregates, and writing it
 * via Drizzle's relational query builder would dwarf the SQL itself.
 */
async function computeAgentVersion(
  db: AgentBridgeDb,
  agentId: string,
): Promise<string> {
  const result = await db.pool.query<{
    agent_updated: string | null
    skills_updated: string | null
    tools_updated: string | null
    agent_repos_updated: string | null
    repo_edges_updated: string | null
    repos_updated: string | null
    mcp_tools_updated: string | null
    mcp_connections_updated: string | null
    provider_updated: string | null
  }>(
    `
    SELECT
      to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS agent_updated,
      (SELECT to_char(MAX(s.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM skills s WHERE s.agent_id = a.id) AS skills_updated,
      (SELECT to_char(MAX(t.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM tools t WHERE t.agent_id = a.id) AS tools_updated,
      (SELECT to_char(MAX(ar.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM agent_repos ar WHERE ar.agent_id = a.id) AS agent_repos_updated,
      (SELECT to_char(MAX(re.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM repo_edges re WHERE re.agent_id = a.id) AS repo_edges_updated,
      (SELECT to_char(MAX(r.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM repos r
         INNER JOIN agent_repos ar2 ON ar2.repo_id = r.id
         WHERE ar2.agent_id = a.id) AS repos_updated,
      (SELECT to_char(MAX(amt.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM agent_mcp_tools amt WHERE amt.agent_id = a.id) AS mcp_tools_updated,
      (SELECT to_char(MAX(mc.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM mcp_connections mc
         INNER JOIN agent_mcp_tools amt2 ON amt2.mcp_connection_id = mc.id
         WHERE amt2.agent_id = a.id) AS mcp_connections_updated,
      (SELECT to_char(lp.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US')
         FROM llm_providers lp WHERE lp.id = a.llm_provider_id) AS provider_updated
    FROM agents a
    WHERE a.id = $1
    `,
    [agentId],
  )

  const row = result.rows[0]
  if (!row) return ''
  // Concatenate with a separator that can't appear inside a timestamp
  // string. Hashing isn't necessary — equality on the joined text is
  // O(constant length) and the consumer just compares strings.
  //
  // The trailing `skill:<version>` segment makes the coding-agent
  // system skill body part of the cache identity. When we bump
  // `CODING_AGENT_SYSTEM_SKILL_VERSION` (after editing
  // `system-skill.md`), every cached BuiltAgent invalidates on next
  // access. long-running backend processes pick up the new body
  // without an explicit redeploy hook.
  return [
    row.agent_updated ?? '',
    row.skills_updated ?? '',
    row.tools_updated ?? '',
    row.agent_repos_updated ?? '',
    row.repo_edges_updated ?? '',
    row.repos_updated ?? '',
    row.mcp_tools_updated ?? '',
    row.mcp_connections_updated ?? '',
    row.provider_updated ?? '',
    `skill:${CODING_AGENT_SYSTEM_SKILL_VERSION}`,
    `gitnexus:${EXPECTED_GITNEXUS_VERSION}`,
  ].join('|')
}
