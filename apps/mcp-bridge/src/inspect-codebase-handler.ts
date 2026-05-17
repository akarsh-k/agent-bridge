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
      // envelope the IDE LLM can act on directly.
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

  const topology = await loadAgentTopology(ctx.db, agent.id, warnings)

  const envelope: WireEnvelope = {
    ok: true,
    mini_repos: miniRepos,
    ...(proseSummary.length > 0 ? { prose_summary: proseSummary } : {}),
    ...(preResolved
      ? {
          resolved_repo: {
            repo_id: preResolved.repo.repo_id,
            label: preResolved.repo.label,
            matched_signal: preResolved.matched_signal,
          },
        }
      : {}),
    agent_repos: topology.agent_repos,
    repo_edges: topology.repo_edges,
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
   * IDE supplied at least one signal AND it resolved to a unique repo.
   * The IDE can render "asked about X" without re-deriving from
   * `mini_repos`. Omitted when no hint was supplied or the agent has a
   * single repo and no hint was needed.
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
   * All repos attached to this agent. Included on every call so the IDE
   * can show the user "you searched X; also connected: Y, Z" and offer
   * a follow-up. Not scoped to the repos the wrappers actually touched
   * (cross-reference `mini_repos[*].files[*].repo_id` for that).
   */
  readonly agent_repos: readonly AgentRepoSummary[]
  /**
   * Operator-curated directed edges between attached repos. Lets the IDE
   * surface the relationship ("frontend --calls--> backend") so the user
   * can decide whether to ask about the other side.
   */
  readonly repo_edges: readonly MiniRepoCrossRepoEdge[]
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
