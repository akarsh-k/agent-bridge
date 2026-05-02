/**
 * GitNexus MCP adapter — Phase 3c.
 *
 * Spawns a single sandboxed `gitnexus mcp` subprocess per agent and hands
 * Mastra a tool dict keyed by `gitnexus_*` names (`gitnexus_list_repos`,
 * `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`,
 * `gitnexus_detect_changes`, `gitnexus_cypher`, `gitnexus_rename`).
 *
 * Why one subprocess per agent (not per indexed repo):
 *   The gitnexus CLI's `mcp` command is already multi-repo by design — it
 *   reads the global registry under `$HOME/.gitnexus/` (clamped to our
 *   isolated `gitnexus-home` dir) and exposes every indexed repo via a
 *   `repo` argument on each tool call. Spawning one subprocess per repo
 *   would (a) quadruple the footprint, (b) force us to stitch results back
 *   together, and (c) duplicate the LadybugDB process inside each child.
 *
 * Lifecycle contract:
 *   - `mountGitnexusMcp(...)` returns `null` when the agent has zero
 *     ready-to-serve repos. No subprocess is spawned in that case.
 *   - Otherwise it returns `{ client, tools, meta }`. The caller passes
 *     `tools` into `new Agent({ tools })` and retains `client` so it can
 *     call `client.disconnect()` when the agent run is done.
 *   - `listTools()` connects eagerly so we can report an accurate tool
 *     count in the returned meta. A connection failure throws — we want
 *     loud failures when gitnexus is misconfigured, not an agent that
 *     silently can't see its own codebase.
 *
 * Sandbox parity:
 *   MCPClient spawns via `@modelcontextprotocol/sdk`'s
 *   `StdioClientTransport`, which honours the `env` dict as a full env
 *   replacement (not a merge). We feed it the same baseline our own
 *   `spawnSandboxed` produces (`buildSandboxedEnv({ sandbox: 'default' })`)
 *   so HOME is clamped, SSH/GPG auth sockets are stripped, and the child's
 *   per-user registry lands inside `gitnexus-home/`.
 *
 * Guard rails honoured:
 *   - Pinned gitnexus version is checked at mount time via
 *     `assertExpectedGitnexusVersion(...)` — a drifted CLI never gets to
 *     talk to a Mastra agent.
 *   - No `@mastra/*` imports leak outside this package (enforced by the
 *     root ESLint guard rail from Phase 3a-lint).
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import {
  assertExpectedGitnexusVersion,
  EXPECTED_GITNEXUS_VERSION,
} from '@agent-bridge/shared/gitnexus'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import { MCPClient } from '@mastra/mcp'
import type { Tool } from '@mastra/core/tools'
import { and, eq } from 'drizzle-orm'

// ─── Public surface ──────────────────────────────────────────────────────

export interface MountGitnexusMcpInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * When `true`, short-circuit and return `null` regardless of how many
   * repos the agent has. The smoke script + future debug UI uses this to
   * reproduce an "LLM-only" agent without editing the DB.
   */
  readonly disabled?: boolean
  /**
   * Per-call log sink — when provided, gitnexus's stderr banner and any
   * MCPClient log lines route through it instead of the default logger.
   * Kept structural so callers don't have to import a logger interface.
   */
  readonly log?: (line: string) => void
}

export interface GitnexusMountMeta {
  /** `true` iff the subprocess was spawned and at least one tool was registered. */
  readonly mounted: boolean
  /** Count of `status='ready'` repos attached to the agent. */
  readonly repoCount: number
  /** Count of MCP tools loaded (post-`listTools()`). Zero when `mounted=false`. */
  readonly toolCount: number
  /** CLI version actually in use — echoes `EXPECTED_GITNEXUS_VERSION`. */
  readonly cliVersion: string
  /** The attached repos' role labels for logs/UX. */
  readonly repoLabels: readonly GitnexusRepoLabel[]
}

export interface GitnexusRepoLabel {
  /** `agent_repos.role` if set, otherwise the remote URL's last segment. */
  readonly label: string
  readonly remoteUrl: string
  readonly branch: string
  /**
   * `agent_repos.description` — operator-supplied "what this repo gives
   * the agent visibility into" hint. Surfaced inline in the system
   * prompt so the LLM can pick the right repo for a question without
   * having to introspect file trees.
   */
  readonly description?: string
  /**
   * Operator-curated extra names this repo answers to: local folder
   * names, short codes, legacy names. Read by the resolver
   * (`coding-agent/repo-resolver.ts`) and rendered into the system
   * prompt's repo inventory so the LLM can map idiomatic names to
   * the right repo. Always `[]` until the P5 migration adds
   * `agent_repos.aliases`; the field is plumbed through ahead of
   * time so P5 is a one-line swap.
   */
  readonly aliases?: readonly string[]
}

export interface MountedGitnexus {
  readonly client: MCPClient
  readonly tools: Record<string, Tool<any, any, any, any>>
  readonly meta: GitnexusMountMeta
}

/**
 * Build the empty meta returned when we intentionally skipped mounting
 * (agent has no indexed repos, or caller passed `disabled: true`).
 * Kept as a helper so `buildAgent`'s `BuiltAgentMeta.gitnexus` always has
 * the same shape whether or not the MCP ran.
 */
export function emptyGitnexusMountMeta(
  repoCount: number,
): GitnexusMountMeta {
  return {
    mounted: false,
    repoCount,
    toolCount: 0,
    cliVersion: EXPECTED_GITNEXUS_VERSION,
    repoLabels: [],
  }
}

/**
 * Query the agent's attached repos and, if any are ready, spawn a
 * sandboxed `gitnexus mcp` subprocess and pull its tools through
 * `MCPClient.listTools()`.
 *
 * Returns `null` when there's nothing to mount (no repos, or `disabled:
 * true`). Throws when there ARE repos but the subprocess can't start —
 * that's user-visible misconfiguration, not a soft degradation.
 */
export async function mountGitnexusMcp(
  input: MountGitnexusMcpInput,
): Promise<MountedGitnexus | null> {
  const { db, agentId, disabled = false, log } = input

  // Always compute the repo list first: even when `disabled` we want an
  // accurate count for `emptyGitnexusMountMeta` in the caller.
  const readyRepos = await loadReadyRepos(db, agentId)

  if (disabled) return null
  if (readyRepos.length === 0) return null

  // Loud version-pin check. If the installed CLI ever drifts, surface the
  // mismatch right at spawn time rather than at first tool call.
  const resolved = assertExpectedGitnexusVersion(import.meta.url)

  // `StdioServerDefinition.env` is typed `Record<string, string>`, so we
  // must drop `undefined` values from `buildSandboxedEnv`'s `ProcessEnv`
  // baseline. Anything undefined there means "the parent has no such var"
  // — identical semantics to omitting the key.
  const env = compactEnv(
    buildSandboxedEnv({
      sandbox: 'default',
      allowHostHome: false,
    }),
  )

  // Per-agent ID so multiple agents running in the same process don't
  // collide in MCPClient's internal instance cache (it hashes on config).
  // Without this, two agents with identical server configs would share
  // one subprocess, and tearing one down would kill the other's tools.
  const client = new MCPClient({
    id: `gitnexus-${agentId}`,
    servers: {
      gitnexus: {
        command: resolved.nodeBin,
        args: [resolved.cliEntry, 'mcp'],
        env,
        // `inherit` lets gitnexus's startup banner ("MCP server starting
        // with N repo(s): …") reach the operator's terminal during local
        // dev. Worker/backend deployments can flip this to `ignore` once
        // we wire `log` through the MCPClient's own logger.
        stderr: 'inherit',
      },
    },
    // Give gitnexus a generous first-connect budget: LadybugDB warms up
    // its native addon on first use, and a cold `mcp` call can push past
    // the default 60s when the index is large.
    timeout: 90_000,
  })

  let tools: Record<string, Tool<any, any, any, any>>
  try {
    tools = await client.listTools()
  } catch (err) {
    // Make sure a half-started subprocess can't leak if the handshake
    // fell over mid-flight.
    await safeDisconnect(client, log)
    throw new Error(
      `[gitnexus-mcp] failed to load tools from \`gitnexus mcp\` ` +
        `(subprocess: ${resolved.cliEntry}): ${errMsg(err)}`,
    )
  }

  const toolCount = Object.keys(tools).length
  if (toolCount === 0) {
    // Shouldn't happen in practice — gitnexus always advertises at least
    // list_repos. Treat zero as a broken install and bail loudly.
    await safeDisconnect(client, log)
    throw new Error(
      `[gitnexus-mcp] gitnexus ${resolved.packageVersion} returned an ` +
        `empty tool list; refusing to mount.`,
    )
  }

  return {
    client,
    tools,
    meta: {
      mounted: true,
      repoCount: readyRepos.length,
      toolCount,
      cliVersion: resolved.packageVersion,
      repoLabels: readyRepos.map((r) => ({
        label: r.label,
        remoteUrl: r.remoteUrl,
        branch: r.branch,
        aliases: r.aliases,
        ...(r.description ? { description: r.description } : {}),
      })),
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface ReadyRepo {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
  readonly label: string
  readonly description?: string
  /** Empty until P5 wires `agent_repos.aliases jsonb`. */
  readonly aliases: readonly string[]
}

/**
 * Return every `agent_repos` row for `agentId` whose underlying repo is
 * `status='ready'`. The label prefers `agent_repos.role` (author intent,
 * "frontend" / "backend") and falls back to the last path segment of the
 * remote URL so the LLM always has some human string to anchor on.
 */
async function loadReadyRepos(
  db: AgentBridgeDb,
  agentId: string,
): Promise<ReadyRepo[]> {
  const rows = await db.db
    .select({
      repoId: schema.repos.id,
      remoteUrl: schema.repos.remoteUrl,
      branch: schema.repos.branch,
      role: schema.agentRepos.role,
      description: schema.agentRepos.description,
      aliases: schema.agentRepos.aliases,
    })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(
      and(
        eq(schema.agentRepos.agentId, agentId),
        eq(schema.repos.status, 'ready'),
      ),
    )

  return rows.map((r) => {
    const desc = r.description?.trim()
    return {
      repoId: r.repoId,
      remoteUrl: r.remoteUrl,
      branch: r.branch,
      label: r.role?.trim() || guessLabelFromUrl(r.remoteUrl),
      aliases: r.aliases ?? [],
      ...(desc ? { description: desc } : {}),
    }
  })
}

/**
 * Best-effort human label from a clone URL. Matches the style of the
 * filesystem slug we use under `.agent-bridge-data/repos/` so terminal
 * output and on-disk paths read the same.
 */
function guessLabelFromUrl(remoteUrl: string): string {
  const clean = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const segments = clean.split(/[/:]/).filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? 'repo'
}

/**
 * Narrow `ProcessEnv` (which allows `undefined`) into the
 * `Record<string, string>` shape MCPClient's stdio server config requires.
 * Undefined entries are dropped — that's semantically equivalent to not
 * setting the variable at all.
 */
function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Swallow disconnect errors so the ORIGINAL failure (e.g. a bad
 * `listTools()` call) reaches the caller instead of getting overwritten
 * by whatever went sideways on the way down.
 */
async function safeDisconnect(
  client: MCPClient,
  log: ((line: string) => void) | undefined,
): Promise<void> {
  try {
    await client.disconnect()
  } catch (err) {
    const msg = `[gitnexus-mcp] disconnect after failure threw: ${errMsg(err)}`
    if (log) log(msg)
    else console.warn(msg)
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
