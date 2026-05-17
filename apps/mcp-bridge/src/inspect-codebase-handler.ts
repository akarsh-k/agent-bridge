/**
 * `inspect_codebase` MCP tool handler (`docs/ARCHITECTURE.md §10`).
 *
 * One entry point. The IDE LLM calls `inspect_codebase` with a
 * free-form `query` plus optional repo hints; the bridge dispatches
 * one Mastra run, lets the agent's wrappers do the work, and wraps
 * the run's accumulated mini-repos into the D17′ envelope.
 *
 * Wire envelope (D17′):
 *
 *   { ok: true,
 *     mini_repos: MiniRepo[],         // from runs.minirepo_json
 *     prose_summary?: string,         // ≤ 1KB; only when no wrapper ran
 *     agent_repos: AgentRepoSummary[],// every repo attached to the agent
 *     repo_edges: CrossRepoEdge[],    // operator-curated edges between them
 *     warnings: string[] }            // populated from inspector telemetry
 *
 * `agent_repos` + `repo_edges` are included on every call so the IDE
 * can prompt the user with "you asked about X; also connected: Y
 * (calls), Z (deploys-to) — want to ask about those too?" without
 * needing a separate `list_repos` round-trip.
 *
 * The agent's free-form prose stream is NOT forwarded to the IDE
 * unless no wrapper invocation populated `runs.minirepo_json` — in
 * which case we surface a 1KB summary so chit-chat / clarifications
 * still produce something useful.
 *
 * Explicit `bridge_tools` rows wrap their `output_summary` at
 * an 8KB cap (operators authored prose on purpose). Same envelope
 * shape, larger prose budget; mini-repos still ride along when an
 * explicit prompt template causes the agent to call wrappers internally.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import {
  dispatchRun,
  loadAllRepoEdges,
  loadAttachedRepos,
  resolveRepoFromHint,
  type IdePreResolvedRepo,
  type MiniRepoCrossRepoEdge,
  type MultiSignalHint,
  type RepoResolveResult,
  type SuggestedReply,
} from '@agent-bridge/agents'
import { runsRepo, schema, type AgentBridgeDb } from '@agent-bridge/db'
import {
  bridgeStreamId,
  formatCallsiteBlock,
  type Callsite,
} from '@agent-bridge/shared'
import type { EventBus } from '@agent-bridge/shared/event-bus'

// ─── Public surface ──────────────────────────────────────────────────────

/**
 * Negotiated `clientInfo` from the MCP `initialize` handshake, captured
 * once at session start by the bridge process. Surfaced through
 * `BridgeContext.getClientInfo()` so each handler can stamp the
 * captured identity onto its `Callsite` without the SDK reaching into
 * its internals from multiple files.
 */
export interface IdeClientInfo {
  readonly name: string
  readonly version: string | null
}

export interface BridgeContext {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  /**
   * One Mastra thread per bridge subprocess so multi-turn IDE chats
   * keep continuity. Sourced from `BRIDGE_THREAD_ID` in the bridge
   * entrypoint.
   */
  readonly threadId: string
  /**
   * Returns the IDE's negotiated MCP `clientInfo` (name + version) or
   * `null` if the handshake hasn't completed yet. Read lazily so
   * late-binding works if the IDE re-initializes mid-session.
   */
  readonly getClientInfo: () => IdeClientInfo | null
}

export interface AgentRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly llmProviderId: string | null
}

export interface InspectCodebaseEntry {
  readonly kind: 'inspect'
  readonly agent: AgentRecord
}

export interface BridgeToolEntry {
  readonly kind: 'phase7'
  readonly agent: AgentRecord
  readonly bridgeTool: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
    readonly promptTemplate: string
  }
}

export type ToolEntry = InspectCodebaseEntry | BridgeToolEntry

// ─── inspect_codebase ────────────────────────────────────────────────────

/**
 * Maximum prose payload per envelope kind. Inspect-codebase fallback
 * (when no wrapper ran) gets 1 KiB; explicit tools that author
 * prose on purpose get 8 KiB. mini-repos themselves are bounded by
 * `runsRepo.appendMinirepo`'s 14 KiB cap.
 */
const PROSE_CAP_INSPECT_FALLBACK = 1024
const PROSE_CAP_PHASE7 = 8 * 1024

/**
 * Execute one `inspect_codebase` call. Validates the agent + provider
 * still exist (the registry was built once at boot; rows can change
 * between then and now), dispatches the user query through the
 * standard run pipeline, then wraps the run's outputs into the wire
 * envelope. Always returns `ok: true` — chit-chat is a valid response,
 * and the IDE LLM decides what to do with what we hand back.
 */
export async function executeInspectCodebase(
  ctx: BridgeContext,
  agent: AgentRecord,
  rawArgs: Record<string, unknown>,
) {
  const fresh = await refreshAgent(ctx.db, agent.id)
  if (!fresh) {
    return mcpError(
      `Agent "${agent.slug}" was deleted between tool listing and this call.`,
    )
  }
  if (!fresh.llmProviderId) {
    return mcpError(
      `Agent "${agent.slug}" no longer has an LLM provider configured.`,
    )
  }

  const query =
    typeof rawArgs['query'] === 'string' ? (rawArgs['query'] as string).trim() : ''
  if (query.length === 0) {
    return mcpError('Missing required arg "query" — pass a question or instruction.')
  }

  const withTopology = rawArgs['with_topology'] === true

  // ─── Pre-resolve the IDE's structured hint ─────────────────────────
  // Cursor / Claude Code / Codex pass `remote_url` (from `git remote
  // get-url origin`), `local_folder`, and a free-form `repo_hint`.
  // We resolve once here, BEFORE dispatching a run, so:
  //   1. The most reliable signal (`remote_url`) drives the choice
  //      without the inspector agent's LLM having to re-extract it
  //      from a prose hint block (which is where the historical
  //      quote-mangling failure mode came from).
  //   2. If the hint is ambiguous in a multi-repo agent, we can
  //      short-circuit with a structured `clarification` envelope so
  //      the IDE LLM gets a pre-baked picker instead of watching the
  //      agent retry the same wrong wrapper call until its step
  //      budget runs out.
  const warnings: string[] = []
  const attached = await loadAttachedReposWithWarning(ctx.db, agent.id, warnings)
  const ideHint = readIdeHint(rawArgs)
  let preResolved: IdePreResolvedRepo | null = null

  if (hasAnyHintSignal(ideHint)) {
    const resolution = resolveRepoFromHint({
      repos: attached,
      hint: ideHint,
      allowAll: false,
    })
    if (resolution.ok === 'clarify') {
      // Short-circuit: don't dispatch a run. Return a clarification
      // envelope the IDE LLM can act on directly. Topology is always
      // included on clarification (the IDE needs the full inventory to
      // render the picker).
      const topology = await loadAgentTopology(ctx.db, agent.id, warnings)
      const envelope: WireEnvelope = {
        ok: true,
        mini_repos: [],
        clarification: {
          kind: resolution.kind,
          candidates: resolution.candidates.map((r) => agentRepoSummaryFromAttached(r)),
          allow_all_repos: resolution.allow_all_repos,
          message: resolution.message,
          suggested_replies: resolution.suggested_replies,
        },
        agent_repos: topology.agent_repos,
        repo_edges: topology.repo_edges,
        warnings,
      }
      return jsonEnvelope(envelope)
    }
    if (resolution.ok === false) {
      // Only `no_repos` lands here (the resolver promotes `not_found`
      // / `ambiguous` to `clarify` when a multi-repo agent has any
      // candidates). `no_repos` is unrecoverable for this call.
      return mcpError(resolution.message)
    }
    if (resolution.ok === true) {
      preResolved = {
        repo: resolution.repo,
        matched_signal: resolution.matched_signal,
      }
    }
    // `resolution.ok === 'all'` is impossible here: we pass
    // `allowAll: false` because `inspect_codebase` is a coordinator,
    // not a wrapper. Wrappers themselves opt in to fan-out.
  }

  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)

  const callsite = buildCallsite({
    clientInfo: ctx.getClientInfo(),
    agent,
    toolName: 'inspect_codebase',
    rawArgs,
  })

  // Prepend the `_Request origin: …_` metadata line here (not in the
  // dispatcher) so the persisted `runs.input_prompt` matches what the
  // LLM actually sees. The dispatcher is a dumb transport — it
  // forwards `prompt` verbatim to Mastra. Format intentionally subtle
  // (one italic line, no headings, no `tool:` field) to avoid weak
  // local models misreading it as "tool already invoked, just answer."
  //
  // Note: we no longer prepend `[IDE hint: …]` to the prompt. The
  // structured hint flows through `idePreResolvedRepo` on the
  // dispatcher input — wrappers consume it directly when the LLM
  // doesn't supply its own `repo_hint`, so the LLM never has to
  // re-translate the IDE's signal. The historical quote-mangling
  // failure mode (`"\"react-stripe-js\""`) goes away.
  const prompt = formatCallsiteBlock(callsite) + query

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: prompt,
    streamId,
    callsite,
  })

  try {
    await dispatchRun({
      db: ctx.db,
      eventBus: ctx.eventBus,
      agentId: agent.id,
      runId,
      streamId,
      prompt,
      threadId: ctx.threadId,
      idePreResolvedRepo: preResolved,
    })
  } catch (err) {
    return mcpError(err instanceof Error ? err.message : 'Bridge dispatch failed')
  }

  const finalRow = await runsRepo.getRun(ctx.db, runId)
  if (!finalRow) {
    return mcpError(
      `Run ${runId} disappeared after dispatch. likely a row was deleted mid-flight.`,
    )
  }
  if (finalRow.status === 'error') {
    return mcpError(finalRow.errorMessage ?? 'Run failed')
  }

  const miniRepos = Array.isArray(finalRow.minirepoJson)
    ? (finalRow.minirepoJson as unknown[])
    : []
  const proseSummary =
    miniRepos.length === 0
      ? truncate(finalRow.outputSummary?.trim() ?? '', PROSE_CAP_INSPECT_FALLBACK)
      : ''

  // Decide the focal repo for `next_actions`. The bridge's pre-resolved
  // repo wins; failing that, the repo that contributed the most files
  // across all mini-repos (a stand-in for "the call's primary subject"
  // in fan-out mode). Returns `null` when nothing ran or no files
  // were surfaced.
  const focalRepo = pickFocalRepo(preResolved, attached, miniRepos)

  // Always load edges so we can compute `next_actions`. The cost is
  // one query; the win is the IDE getting structured handoffs without
  // a `with_topology: true` round-trip.
  let allEdges: readonly MiniRepoCrossRepoEdge[] = []
  try {
    allEdges = await loadAllRepoEdges({ db: ctx.db, agentId: agent.id, attached })
  } catch (err) {
    warnings.push(
      `loadAllRepoEdges failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const nextActions = focalRepo
    ? computeNextActions(focalRepo, attached, allEdges)
    : []

  const envelope: WireEnvelope = {
    ok: true,
    mini_repos: miniRepos,
    ...(proseSummary.length > 0 ? { prose_summary: proseSummary } : {}),
    ...(focalRepo
      ? {
          resolved_repo: {
            repo_id: focalRepo.repo_id,
            label: focalRepo.label,
            matched_signal:
              preResolved?.matched_signal ?? 'fallback_single_repo',
          },
        }
      : {}),
    ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    ...(withTopology
      ? {
          agent_repos: attached.map(agentRepoSummaryFromAttached),
          repo_edges: allEdges,
        }
      : {}),
    warnings,
  }
  return jsonEnvelope(envelope)
}

// ─── Explicit bridge tool ────────────────────────────────────────────────

/**
 * Render an operator-authored prompt template against the IDE's args.
 * `{{ name }}` placeholders match `[a-zA-Z_][a-zA-Z0-9_]*`. Unknown
 * placeholders interpolate as the empty string — the operator can see
 * the rendered prompt in `runs.input_prompt` and fix the template.
 */
function renderPromptTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_match, name: string) => {
      const v = args[name]
      if (v === undefined || v === null) return ''
      if (typeof v === 'string') return v
      try {
        return JSON.stringify(v)
      } catch {
        return String(v)
      }
    },
  )
}

/**
 * Explicit `bridge_tools` rows continue to work under D17′
 * (`docs/ARCHITECTURE.md §10` G5). The bridge dispatches the rendered template
 * and wraps the result in the same envelope shape — operator-authored
 * prose gets an 8 KiB cap; any mini-repos the agent's wrappers
 * accumulated during the run also ride along.
 */
export async function executePhase7Tool(
  ctx: BridgeContext,
  agent: AgentRecord,
  bridgeTool: BridgeToolEntry['bridgeTool'],
  rawArgs: Record<string, unknown>,
) {
  const fresh = await refreshAgent(ctx.db, agent.id)
  if (!fresh) {
    return mcpError(
      `Agent "${agent.slug}" was deleted between tool listing and this call.`,
    )
  }
  if (!fresh.llmProviderId) {
    return mcpError(
      `Agent "${agent.slug}" no longer has an LLM provider configured.`,
    )
  }

  const renderedPrompt = renderPromptTemplate(bridgeTool.promptTemplate, rawArgs).trim()
  if (renderedPrompt.length === 0) {
    return mcpError(
      'Rendered prompt was empty — check that your bridge tool template references args correctly.',
    )
  }

  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)

  const callsite = buildCallsite({
    clientInfo: ctx.getClientInfo(),
    agent,
    toolName: bridgeTool.name,
    rawArgs,
  })

  // Same callsite-prepend convention as `executeInspectCodebase` —
  // the persisted prompt matches what the LLM saw.
  const prompt = formatCallsiteBlock(callsite) + renderedPrompt

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: prompt,
    streamId,
    bridgeToolName: bridgeTool.name,
    callsite,
  })

  try {
    await dispatchRun({
      db: ctx.db,
      eventBus: ctx.eventBus,
      agentId: agent.id,
      runId,
      streamId,
      prompt,
      threadId: ctx.threadId,
    })
  } catch (err) {
    return mcpError(err instanceof Error ? err.message : 'Bridge dispatch failed')
  }

  const finalRow = await runsRepo.getRun(ctx.db, runId)
  if (!finalRow) {
    return mcpError(`Run ${runId} disappeared after dispatch.`)
  }
  if (finalRow.status === 'error') {
    return mcpError(finalRow.errorMessage ?? 'Run failed')
  }

  const miniRepos = Array.isArray(finalRow.minirepoJson)
    ? (finalRow.minirepoJson as unknown[])
    : []
  const proseSummary = truncate(
    finalRow.outputSummary?.trim() ?? '',
    PROSE_CAP_PHASE7,
  )

  const warnings: string[] = []
  const topology = await loadAgentTopology(ctx.db, agent.id, warnings)

  const envelope: WireEnvelope = {
    ok: true,
    mini_repos: miniRepos,
    ...(proseSummary.length > 0 ? { prose_summary: proseSummary } : {}),
    agent_repos: topology.agent_repos,
    repo_edges: topology.repo_edges,
    warnings,
  }
  return jsonEnvelope(envelope)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface WireEnvelope {
  readonly ok: true
  readonly mini_repos: readonly unknown[]
  readonly prose_summary?: string
  /**
   * The single repo the bridge resolved from the IDE's structured hint
   * (`remote_url` / `local_folder` / `repo_hint`). Present whenever the
   * IDE supplied at least one signal AND it resolved to a unique repo,
   * OR the agent has a single attached repo. The IDE can render "asked
   * about X" without re-deriving from `mini_repos`.
   */
  readonly resolved_repo?: ResolvedRepoSlice
  /**
   * Set when the IDE's hint was ambiguous in a multi-repo agent. The
   * bridge skips the run dispatch and surfaces a pre-baked picker so
   * the IDE LLM can either ask the human or pick a `suggested_replies`
   * entry and retry. Mutually exclusive with `mini_repos.length > 0`
   * in practice (we short-circuit before dispatch).
   */
  readonly clarification?: ClarificationSlice
  /**
   * Pre-baked follow-up actions for connected repos. Surfaced post-
   * dispatch when at least one cross-repo edge touches the focal repo
   * (the one the bridge resolved, or the most-evidenced repo when the
   * call fanned out). Each entry carries an `args_patch` the IDE LLM
   * can fire verbatim into a follow-up `inspect_codebase` call. ≤ 3
   * entries, outgoing edges (focal as `from_repo`) before incoming.
   * Omitted when there are no relevant edges.
   */
  readonly next_actions?: readonly NextAction[]
  /**
   * Full repo inventory. Only included when the IDE passed
   * `with_topology: true` (default false). Same shape as before;
   * gated to keep the default payload focused on the resolved repo.
   */
  readonly agent_repos?: readonly AgentRepoSummary[]
  /**
   * Full operator-curated edge list. Same gating as `agent_repos`.
   */
  readonly repo_edges?: readonly MiniRepoCrossRepoEdge[]
  readonly warnings: readonly string[]
}

interface ResolvedRepoSlice {
  readonly repo_id: string
  readonly label: string
  /** Which IDE-supplied signal produced the match (`remote_url` / `role` / etc.). */
  readonly matched_signal: string
}

interface ClarificationSlice {
  readonly kind: 'repo_or_all' | 'single_repo_required'
  readonly candidates: readonly AgentRepoSummary[]
  readonly allow_all_repos: boolean
  readonly message: string
  readonly suggested_replies: readonly SuggestedReply[]
}

/**
 * One pre-baked follow-up the IDE LLM can fire to drill into a
 * connected repo. `args_patch` is shaped to be the exact `inspect_codebase`
 * args (modulo `query`) the IDE re-issues. `meta` exposes structured
 * fields so the IDE can filter / sort programmatically; `reason` is
 * the same info in one human-readable line.
 */
interface NextAction {
  /** Human-facing label the IDE can render as a button or chip. */
  readonly label: string
  /** One-line prose explaining the relationship. */
  readonly reason: string
  /** Structured form of `reason`. Same data, machine-friendly. */
  readonly meta: NextActionMeta
  /**
   * Patch the IDE LLM applies to its next `inspect_codebase` call to
   * follow this edge. Carries both `repo_hint` (label) and `remote_url`
   * so the bridge's pre-resolver picks the connected repo by URL — no
   * label-mangling round-trip through the IDE LLM.
   */
  readonly args_patch: {
    readonly repo_hint: string
    readonly remote_url: string
  }
}

interface NextActionMeta {
  /** Edge `connector` field (e.g. `calls`, `imports`, `deploys-to`). */
  readonly connector: string
  /** Operator-authored description of the edge; `null` when unset. */
  readonly edge_description: string | null
  /** Source endpoint of the edge. */
  readonly from_repo: { readonly repo_id: string; readonly label: string }
  /** Target endpoint. */
  readonly to_repo: { readonly repo_id: string; readonly label: string }
}

interface AgentRepoSummary {
  readonly repo_id: string
  readonly label: string
  readonly role: string | null
  readonly description: string | null
  readonly status: string
}

interface AgentTopology {
  readonly agent_repos: readonly AgentRepoSummary[]
  readonly repo_edges: readonly MiniRepoCrossRepoEdge[]
}

/**
 * Fetch the agent's repo inventory + cross-repo edges for inclusion in
 * the response envelope. Failures fold into `warnings` rather than
 * killing the call — the IDE still gets `mini_repos`, just without the
 * topology affordance for this turn.
 */
async function loadAgentTopology(
  db: AgentBridgeDb,
  agentId: string,
  warnings: string[],
): Promise<AgentTopology> {
  try {
    const attached = await loadAttachedRepos({ db, agentId })
    let edges: readonly MiniRepoCrossRepoEdge[] = []
    try {
      edges = await loadAllRepoEdges({ db, agentId, attached })
    } catch (err) {
      warnings.push(
        `loadAllRepoEdges failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return {
      agent_repos: attached.map((r) => ({
        repo_id: r.repo_id,
        label: r.label,
        role: r.role,
        description: r.description,
        status: r.status,
      })),
      repo_edges: edges,
    }
  } catch (err) {
    warnings.push(
      `loadAttachedRepos failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { agent_repos: [], repo_edges: [] }
  }
}

/**
 * Assemble a `Callsite` from the bridge's per-call inputs. Used by both
 * `executeInspectCodebase` and `executePhase7Tool` so every bridge-
 * originated run carries identical provenance.
 *
 * `repo` is populated only when at least one repo hint was in `rawArgs`
 * — for chat-style tools that don't supply hints this returns `null`,
 * which is honest about the tool not being repo-aware.
 */
export function buildCallsite(input: {
  readonly clientInfo: IdeClientInfo | null
  readonly agent: AgentRecord
  readonly toolName: string
  readonly rawArgs: Record<string, unknown>
}): Callsite {
  const { clientInfo, agent, toolName, rawArgs } = input
  const repo = extractRepoCallsite(rawArgs)
  return {
    client: clientInfo
      ? {
          name: clientInfo.name,
          ...(clientInfo.version ? { version: clientInfo.version } : {}),
        }
      : { name: 'unknown-mcp-client' },
    agent: { slug: agent.slug, name: agent.name },
    tool: { name: toolName },
    ...(repo ? { repo } : {}),
    started_at: new Date().toISOString(),
  }
}

function extractRepoCallsite(
  rawArgs: Record<string, unknown>,
): NonNullable<Callsite['repo']> | null {
  const label = stringArg(rawArgs, 'repo_hint')
  const remote_url = stringArg(rawArgs, 'remote_url')
  const branch = stringArg(rawArgs, 'branch')
  const local_folder = stringArg(rawArgs, 'local_folder')
  if (!label && !remote_url && !branch && !local_folder) return null
  return {
    ...(label ? { label } : {}),
    ...(remote_url ? { remote_url } : {}),
    ...(branch ? { branch } : {}),
    ...(local_folder ? { local_folder } : {}),
  }
}

function stringArg(
  rawArgs: Record<string, unknown>,
  key: string,
): string | null {
  const v = rawArgs[key]
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Pull the four structured-hint fields off the IDE's tool args. Returns
 * a `MultiSignalHint` ready to pass to `resolveRepoFromHint`. Trimming
 * + emptiness handling is done inside the resolver.
 */
function readIdeHint(rawArgs: Record<string, unknown>): MultiSignalHint {
  return {
    repo_hint: stringArg(rawArgs, 'repo_hint'),
    remote_url: stringArg(rawArgs, 'remote_url'),
    local_folder: stringArg(rawArgs, 'local_folder'),
    branch: stringArg(rawArgs, 'branch'),
  }
}

function hasAnyHintSignal(h: MultiSignalHint): boolean {
  return (
    (h.repo_hint?.length ?? 0) > 0 ||
    (h.remote_url?.length ?? 0) > 0 ||
    (h.local_folder?.length ?? 0) > 0
  )
}

/**
 * `loadAttachedRepos` wrapped so a DB failure doesn't kill the call.
 * The pre-resolution step needs the repo list; if loading fails we
 * push a warning and return an empty list so the caller's resolver
 * short-circuits on `no_repos`.
 */
async function loadAttachedReposWithWarning(
  db: AgentBridgeDb,
  agentId: string,
  warnings: string[],
) {
  try {
    return await loadAttachedRepos({ db, agentId })
  } catch (err) {
    warnings.push(
      `loadAttachedRepos failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

function agentRepoSummaryFromAttached(r: {
  readonly repo_id: string
  readonly label: string
  readonly role: string | null
  readonly description: string | null
  readonly status: string
}): AgentRepoSummary {
  return {
    repo_id: r.repo_id,
    label: r.label,
    role: r.role,
    description: r.description,
    status: r.status,
  }
}

interface AttachedRepoLike {
  readonly repo_id: string
  readonly label: string
  readonly remote_url: string
  readonly role: string | null
  readonly description: string | null
  readonly status: string
  readonly aliases?: readonly string[]
}

/**
 * Decide which repo a call's `next_actions` should be computed against.
 *
 * Priority:
 *   1. The bridge's pre-resolved repo (the IDE explicitly named one).
 *   2. The repo with the most files across all mini-repos (fan-out
 *      mode — pick the call's "primary subject" by evidence weight).
 *   3. `null` when no files surfaced (chit-chat / empty result).
 *
 * `null` means no next_actions: there's no clear focal repo to compute
 * cross-repo follow-ups from.
 */
function pickFocalRepo(
  preResolved: IdePreResolvedRepo | null,
  attached: readonly AttachedRepoLike[],
  miniRepos: readonly unknown[],
): AttachedRepoLike | null {
  if (preResolved) {
    return (
      attached.find((r) => r.repo_id === preResolved.repo.repo_id) ?? null
    )
  }
  // Walk mini_repos[*].files[*].repo_id and tally per-repo file counts.
  // Mini-repos are operator-trusted JSON from `runs.minirepo_json`; we
  // still read defensively (unknown[] → narrow before indexing) so a
  // future shape drift doesn't crash the handler.
  const fileCounts = new Map<string, number>()
  for (const m of miniRepos) {
    if (!m || typeof m !== 'object') continue
    const files = (m as { files?: unknown }).files
    if (!Array.isArray(files)) continue
    for (const f of files) {
      if (!f || typeof f !== 'object') continue
      const id = (f as { repo_id?: unknown }).repo_id
      if (typeof id !== 'string') continue
      fileCounts.set(id, (fileCounts.get(id) ?? 0) + 1)
    }
  }
  if (fileCounts.size === 0) {
    // No evidence. Fall through to the single-repo case: when the
    // agent has exactly one attached repo, it's trivially the focal.
    return attached.length === 1 ? attached[0]! : null
  }
  let topId = ''
  let topCount = -1
  for (const [id, count] of fileCounts) {
    if (count > topCount) {
      topId = id
      topCount = count
    }
  }
  return attached.find((r) => r.repo_id === topId) ?? null
}

/**
 * Build `next_actions` from operator-curated cross-repo edges touching
 * the focal repo. Outgoing edges first (focal as `from_repo`: "what
 * does X reach?") since they answer "where does this code go from
 * here?" — the most common follow-up. Incoming as fallback.
 *
 * Capped at 3 entries. Deduped per connected repo: if multiple edges
 * touch the same other repo, keep the first one encountered (which is
 * outgoing if any exists, by the iteration order).
 */
const NEXT_ACTIONS_CAP = 3

function computeNextActions(
  focal: AttachedRepoLike,
  attached: readonly AttachedRepoLike[],
  edges: readonly MiniRepoCrossRepoEdge[],
): NextAction[] {
  const attachedById = new Map(attached.map((r) => [r.repo_id, r]))

  const outgoing: MiniRepoCrossRepoEdge[] = []
  const incoming: MiniRepoCrossRepoEdge[] = []
  for (const e of edges) {
    if (e.from_repo === focal.repo_id && e.to_repo !== focal.repo_id) {
      outgoing.push(e)
    } else if (e.to_repo === focal.repo_id && e.from_repo !== focal.repo_id) {
      incoming.push(e)
    }
  }

  const seen = new Set<string>()
  const out: NextAction[] = []
  for (const e of [...outgoing, ...incoming]) {
    const otherId = e.from_repo === focal.repo_id ? e.to_repo : e.from_repo
    if (seen.has(otherId)) continue
    const other = attachedById.get(otherId)
    if (!other) continue
    seen.add(otherId)
    out.push(buildNextAction(focal, other, e))
    if (out.length >= NEXT_ACTIONS_CAP) break
  }
  return out
}

function buildNextAction(
  focal: AttachedRepoLike,
  other: AttachedRepoLike,
  edge: MiniRepoCrossRepoEdge,
): NextAction {
  // `label` mirrors the connector direction so the IDE can render it
  // verbatim ("Check frontend usage" / "What backend calls this?").
  const focalIsSource = edge.from_repo === focal.repo_id
  const label = focalIsSource
    ? `Ask about ${other.label} (${edge.connector})`
    : `Ask about ${other.label} (which ${edge.connector} ${focal.label})`
  const reasonDesc = edge.description ? `: ${edge.description}` : ''
  const reason = focalIsSource
    ? `${focal.label} --${edge.connector}--> ${other.label}${reasonDesc}`
    : `${other.label} --${edge.connector}--> ${focal.label}${reasonDesc}`
  return {
    label,
    reason,
    meta: {
      connector: edge.connector,
      edge_description: edge.description,
      from_repo: {
        repo_id: focalIsSource ? focal.repo_id : other.repo_id,
        label: focalIsSource ? focal.label : other.label,
      },
      to_repo: {
        repo_id: focalIsSource ? other.repo_id : focal.repo_id,
        label: focalIsSource ? other.label : focal.label,
      },
    },
    args_patch: {
      repo_hint: other.label,
      remote_url: other.remote_url,
    },
  }
}

async function refreshAgent(
  db: AgentBridgeDb,
  agentId: string,
): Promise<{ id: string; llmProviderId: string | null } | null> {
  const [fresh] = await db.db
    .select({
      id: schema.agents.id,
      llmProviderId: schema.agents.llmProviderId,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  return fresh ?? null
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s
  return s.slice(0, Math.max(cap - 1, 0)) + '…'
}

function jsonEnvelope(envelope: WireEnvelope) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
    ],
  }
}

function mcpError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}
