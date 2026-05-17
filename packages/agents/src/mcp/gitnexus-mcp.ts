/**
 * GitNexus MCP adapter.
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
 *     root ESLint guard rail).
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import { decryptSecret } from '@agent-bridge/shared/crypto'
import {
  assertExpectedGitnexusVersion,
  EXPECTED_GITNEXUS_VERSION,
} from '@agent-bridge/shared/gitnexus'
import { repoDirName } from '@agent-bridge/shared/paths'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import { normalizeRemoteUrl } from '../inspector/url-normalize.js'
import { MCPClient } from '@mastra/mcp'
import type { Tool } from '@mastra/core/tools'
import { and, eq } from 'drizzle-orm'

import type { LlmProviderRow } from '@agent-bridge/db/schema'

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
   * (`inspector/repo-resolve.ts`) and rendered into the system prompt's
   * repo inventory so the LLM can map idiomatic names to the right
   * repo.
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

  // Forward the workspace embedding provider's `GITNEXUS_EMBEDDING_*`
  // env vars to the long-lived `gitnexus mcp` subprocess so query-time
  // embedding matches index-time embedding (the worker's `analyze`
  // path forwards the same vars). Without this, `gitnexus_query`'s
  // semantic arm uses gitnexus's default 384-dim local embedder, which
  // produces vectors that don't match the (e.g. 1024-dim) store the
  // analyze pass populated → semantic search returns 0 hits regardless
  // of how relevant the query actually is.
  //
  // Best-effort: missing/misconfigured embedding provider is non-fatal
  // (D1 boot-fail in `buildAgent` already gates that; here we just
  // omit the env vars and gitnexus falls back to its default). Decrypt
  // failure throws and bubbles up (caller treats as misconfiguration).
  const embeddingProvider = await loadWorkspaceEmbeddingProvider(db)
  if (embeddingProvider) {
    const embeddingEnv = buildEmbeddingEnv(embeddingProvider)
    for (const [k, v] of Object.entries(embeddingEnv)) env[k] = v
  }

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

  // Ask gitnexus what it has actually got registered. The `name` it
  // returns for each entry is what `resolveRepo` matches against —
  // could be the bridge's `--name <slug>` (when this repo was indexed
  // through the worker job) or the URL-tail (when the operator ran
  // `gitnexus analyze` themselves on a manual clone, no `--name`). We
  // can only translate the LLM's label arg to whatever string is
  // actually keyed in gitnexus's registry, so we read it live rather
  // than assume. Failures fall back to the slug guess so a flaky
  // gitnexus call doesn't take agent startup down with it.
  const liveEntries = await fetchGitnexusList(tools, log)
  const enriched = enrichWithCanonicalName(readyRepos, liveEntries)

  // Translate friendly labels / aliases the LLM passes into the canonical
  // gitnexus registry name before forwarding to the subprocess. Without
  // this, an operator's role label (e.g. "payment repo") reaches
  // gitnexus, which knows the same repo only as either its URL-tail
  // form or `<owner>__<name>__<branch>__<shortId>` (depending on how
  // it was registered) and rejects with "Repository not found". See
  // `wrapToolsWithRepoArgRewriter` below.
  const wrappedTools = wrapToolsWithRepoArgRewriter(tools, enriched)

  return {
    client,
    tools: wrappedTools,
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
  /**
   * The exact registry name `gitnexus analyze --name <slug>` was invoked
   * with at index time — `<owner>__<repo>__<branch>__<shortId>`. This is
   * what gitnexus's `resolveRepo` matches by (name, case-insensitive),
   * so it's the only string the LLM's `repo: …` arg can be safely
   * rewritten to. Computed via `repoDirName` so the worker job and the
   * MCP wrapper stay in lockstep — if we ever change the slug rules,
   * one helper changes and both sides follow.
   */
  readonly canonicalName: string
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
    // canonicalName is left at the slug guess here. The mount-time
    // `enrichWithCanonicalName` step replaces it with whatever
    // gitnexus_list_repos actually reports for this remoteUrl, when
    // available. The slug remains as a fallback for repos that aren't
    // in gitnexus's registry yet (or whose live lookup failed).
    return {
      repoId: r.repoId,
      remoteUrl: r.remoteUrl,
      branch: r.branch,
      label: r.role?.trim() || guessLabelFromUrl(r.remoteUrl),
      aliases: r.aliases ?? [],
      canonicalName: repoDirName({
        id: r.repoId,
        remoteUrl: r.remoteUrl,
        branch: r.branch,
      }),
      ...(desc ? { description: desc } : {}),
    }
  })
}

interface GitnexusListEntry {
  readonly name: string
  readonly remoteUrl?: string
  readonly path?: string
}

/**
 * Call `gitnexus_list_repos` once at mount time to learn what gitnexus
 * has *actually* registered. We need the live name string to translate
 * the LLM's label arg into something `resolveRepo` will match — bridge-
 * indexed repos are keyed by the `--name <slug>` we passed to
 * `analyze`, but operator-indexed repos (manual `gitnexus analyze`)
 * are keyed by the URL-tail. Only the live registry knows which.
 *
 * Best-effort: any failure (tool missing, parse error, subprocess hiccup)
 * returns an empty list and we fall back to the slug guess. Don't take
 * agent startup down for a hint that's only used to improve grounding.
 */
async function fetchGitnexusList(
  tools: Record<string, Tool<any, any, any, any>>,
  log: ((line: string) => void) | undefined,
): Promise<GitnexusListEntry[]> {
  const tool = tools['gitnexus_list_repos']
  if (!tool || !tool.execute) return []
  try {
    const raw = await tool.execute({} as never, {} as never)
    return parseGitnexusList(raw)
  } catch (err) {
    const msg = `[gitnexus-mcp] gitnexus_list_repos pre-fetch failed; using slug fallback for repo arg rewriting: ${errMsg(err)}`
    if (log) log(msg)
    else console.warn(msg)
    return []
  }
}

/**
 * Pull `[{ name, remoteUrl?, path? }]` out of whatever shape gitnexus
 * returned. Mastra's MCP wrapper either hands us the structuredContent
 * directly (an array, ideally) or the full CallToolResult envelope
 * (`{ content: [{ type: 'text', text: '<json>' }] }`) when there's no
 * structured shape. We accept both, plus a `{ repos: [...] }` wrapper
 * for forward-compat. Anything we can't recognise comes back as `[]`.
 */
function parseGitnexusList(raw: unknown): GitnexusListEntry[] {
  const candidates: unknown[] = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      candidates.push(...value)
      return
    }
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    if (Array.isArray(obj['repos'])) candidates.push(...(obj['repos'] as unknown[]))
    if (Array.isArray(obj['content'])) {
      for (const c of obj['content'] as unknown[]) {
        if (!c || typeof c !== 'object') continue
        const part = c as Record<string, unknown>
        if (part['type'] === 'text' && typeof part['text'] === 'string') {
          const parsed = parseTextPayload(part['text'] as string)
          if (parsed !== undefined) collect(parsed)
        }
      }
    }
  }
  collect(raw)

  const out: GitnexusListEntry[] = []
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = typeof o['name'] === 'string' ? o['name'] : null
    if (!name) continue
    const remoteUrl =
      typeof o['remoteUrl'] === 'string' ? o['remoteUrl'] : undefined
    const repoPath = typeof o['path'] === 'string' ? o['path'] : undefined
    out.push({
      name,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(repoPath ? { path: repoPath } : {}),
    })
  }
  return out
}

/**
 * Pull JSON out of the `text` part of an MCP `CallToolResult`. Gitnexus's
 * MCP server (`mcp/server.js:142`) emits `JSON.stringify(result)` then
 * appends a markdown "next-step hint" (default divider `\n\n---\n**Next:** …`).
 *
 * We try three strategies in order, returning the first one that parses:
 *
 *   1. Strip on the known divider, parse the prefix.
 *   2. Parse the full text — covers the case where the hint is dropped
 *      in a future gitnexus version.
 *   3. Slice up to the last top-level `]` or `}` and parse that — covers
 *      the case where the divider format changes (e.g. `---` → `***`).
 *
 * On total failure we log a warning instead of swallowing silently, so a
 * future gitnexus format change shows up in the worker's stderr rather
 * than as a mysterious slug-fallback regression.
 */
function parseTextPayload(text: string): unknown | undefined {
  const candidates: string[] = []

  const dividerIdx = text.indexOf('\n\n---\n')
  if (dividerIdx >= 0) candidates.push(text.slice(0, dividerIdx))

  candidates.push(text)

  const lastBracket = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  if (lastBracket >= 0 && lastBracket < text.length - 1) {
    candidates.push(text.slice(0, lastBracket + 1))
  }

  for (const c of candidates) {
    const trimmed = c.trim()
    if (trimmed.length === 0) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      /* try next strategy */
    }
  }

  console.warn(
    `[gitnexus-mcp] could not parse list_repos text payload ` +
      `(length=${text.length}, first 80=${JSON.stringify(text.slice(0, 80))}); ` +
      `falling back to slug-based repo arg rewriting. ` +
      `Likely gitnexus output format change — re-check the parser strategies.`,
  )
  return undefined
}

/**
 * Replace each `ReadyRepo`'s slug-guess `canonicalName` with the live
 * gitnexus name, matched by normalised `remoteUrl`. Repos with no live
 * match keep the slug — they may have been indexed under that name by
 * the bridge's worker, or simply not be in gitnexus's registry yet
 * (in which case the LLM's call will fail with gitnexus's own
 * "Available: ..." error, which is informative enough).
 */
function enrichWithCanonicalName(
  readyRepos: ReadonlyArray<ReadyRepo>,
  liveEntries: ReadonlyArray<GitnexusListEntry>,
): ReadyRepo[] {
  if (liveEntries.length === 0) return readyRepos.map((r) => ({ ...r }))

  const byNormalisedUrl = new Map<string, GitnexusListEntry>()
  for (const e of liveEntries) {
    if (!e.remoteUrl) continue
    const key = normalizeRemoteUrl(e.remoteUrl)
    if (!key || byNormalisedUrl.has(key)) continue
    byNormalisedUrl.set(key, e)
  }

  return readyRepos.map((r) => {
    const key = normalizeRemoteUrl(r.remoteUrl)
    const live = key ? byNormalisedUrl.get(key) : undefined
    if (!live) return { ...r }
    return { ...r, canonicalName: live.name }
  })
}

/**
 * Wrap each MCP tool so any `repo` argument the LLM sends gets translated
 * from a friendly label / alias / URL-tail into the canonical gitnexus
 * registry name we passed to `gitnexus analyze --name <slug>`.
 *
 * The LLM keeps reasoning in the operator's role labels (what shows up
 * in the system-prompt inventory) while gitnexus only ever sees the
 * names it has actually indexed. Tools whose input schema doesn't
 * include a `repo` field pass through unchanged.
 *
 * Ambiguous lookup keys (same label spelled across two repos) are
 * deleted from the map and pass through to gitnexus, which will then
 * surface its own disambiguation error — better than silently picking
 * the wrong repo.
 */
function wrapToolsWithRepoArgRewriter(
  tools: Record<string, Tool<any, any, any, any>>,
  readyRepos: ReadonlyArray<ReadyRepo>,
): Record<string, Tool<any, any, any, any>> {
  const rewrite = buildRepoArgRewriter(readyRepos)
  if (!rewrite) return tools
  const out: Record<string, Tool<any, any, any, any>> = {}
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapToolExecute(tool, rewrite)
  }
  return out
}

/**
 * Build the label → canonical-name map and return a pure function that
 * rewrites a tool-call input's `repo` field when it matches. Returns
 * `null` when there's nothing to rewrite (no repos, or every label is
 * already canonical), so the caller can short-circuit.
 */
function buildRepoArgRewriter(
  readyRepos: ReadonlyArray<ReadyRepo>,
): ((input: unknown) => unknown) | null {
  if (readyRepos.length === 0) return null

  const map = new Map<string, string>()
  const ambiguous = new Set<string>()

  const claim = (key: string | undefined | null, canonical: string): void => {
    if (!key) return
    const k = key.toLowerCase()
    if (k.length === 0) return
    if (k === canonical.toLowerCase()) return // already canonical, nothing to do
    const prior = map.get(k)
    if (prior && prior !== canonical) {
      ambiguous.add(k)
      return
    }
    map.set(k, canonical)
  }

  for (const r of readyRepos) {
    const canonical = r.canonicalName
    claim(r.label, canonical)
    claim(guessLabelFromUrl(r.remoteUrl), canonical)
    for (const alias of r.aliases) claim(alias, canonical)
  }
  for (const k of ambiguous) map.delete(k)

  if (map.size === 0) return null

  return (input: unknown): unknown => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return input
    }
    const obj = input as Record<string, unknown>
    // Two shapes Mastra passes execute() args in: the parsed input
    // directly, or `{ context: <input>, ... }` from the agent runtime.
    // Try the direct case first; fall back to context.
    const direct = rewriteRepoField(obj, map)
    if (direct !== obj) return direct
    if (obj['context'] && typeof obj['context'] === 'object') {
      const ctx = obj['context'] as Record<string, unknown>
      const rewritten = rewriteRepoField(ctx, map)
      if (rewritten !== ctx) return { ...obj, context: rewritten }
    }
    return input
  }
}

function rewriteRepoField(
  obj: Record<string, unknown>,
  map: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const repo = obj['repo']
  if (typeof repo !== 'string') return obj
  const canonical = map.get(repo.toLowerCase())
  if (!canonical) return obj
  return { ...obj, repo: canonical }
}

/**
 * Replace a tool's `execute` with a version that runs `rewrite` over the
 * input first. Tools without an `execute` (rare, but allowed by the
 * type) pass through. The wrapped tool keeps every other field
 * identical so Mastra's downstream wiring (id, schema, requireApproval,
 * mcpMetadata) is preserved verbatim.
 */
function wrapToolExecute(
  tool: Tool<any, any, any, any>,
  rewrite: (input: unknown) => unknown,
): Tool<any, any, any, any> {
  const original = tool.execute
  if (!original) return tool
  return {
    ...tool,
    execute: ((input: unknown, context: unknown) =>
      original(rewrite(input) as never, context as never)) as typeof original,
  }
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

// ─── Embedding env forwarding (gitnexus mcp parity with worker analyze) ──

/**
 * Vendor base URL fallbacks for `role='embedding'` providers. Mirrors the
 * worker's `EMBEDDING_VENDOR_BASE_URL` map in `apps/worker/src/jobs/index-repo.ts`.
 * Drift between the two is a bug — keep them in sync.
 */
const EMBEDDING_VENDOR_BASE_URL: Partial<
  Record<NonNullable<LlmProviderRow['kind']>, string>
> = {
  openai: 'https://api.openai.com',
}

/**
 * Read the singleton `role='embedding'` provider row. Returns `null`
 * when none is configured. The `D1` boot-fail check in `buildAgent`
 * already enforces "must exist" when the agent has any attached repo,
 * so a `null` here means we're inside the LLM-only path (which we'd
 * already have short-circuited above) or a misconfigured edge case.
 */
async function loadWorkspaceEmbeddingProvider(
  db: AgentBridgeDb,
): Promise<LlmProviderRow | null> {
  const [row] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'embedding'))
    .limit(1)
  return row ?? null
}

/**
 * Build the `GITNEXUS_EMBEDDING_*` env tuple gitnexus reads (per the
 * gitnexus 1.6.3 README "Remote Embeddings"). Mirrors
 * `apps/worker/src/jobs/index-repo.ts:buildEmbeddingEnv` so query-time
 * matches index-time. Drift = silent semantic-search failure.
 *
 * Empty when the provider lacks a `defaultModel` (gitnexus would 400
 * on the first request anyway). Decrypted apiKey lives in the env
 * dict; the parent process never logs it (the only consumer is
 * gitnexus's child process via `StdioServerDefinition.env`).
 */
function buildEmbeddingEnv(provider: LlmProviderRow): Record<string, string> {
  if (!provider.defaultModel) return {}
  const raw =
    provider.baseUrl ?? EMBEDDING_VENDOR_BASE_URL[provider.kind] ?? null
  if (!raw) return {}
  const trimmed = raw.replace(/\/+$/, '')
  const url = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`

  const env: Record<string, string> = {
    GITNEXUS_EMBEDDING_URL: url,
    GITNEXUS_EMBEDDING_MODEL: provider.defaultModel,
  }
  if (provider.embeddingDims != null) {
    env['GITNEXUS_EMBEDDING_DIMS'] = String(provider.embeddingDims)
  }
  if (provider.apiKeyEnvelope) {
    env['GITNEXUS_EMBEDDING_API_KEY'] = decryptSecret(provider.apiKeyEnvelope)
  }
  return env
}
