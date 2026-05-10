/**
 * `inspect_codebase` MCP tool handler (`docs/ARCHITECTURE.md §10` Phase G G1+G4).
 *
 * Replaces the v1 coding-agent toolkit's six virtual tools + 920-line
 * handler with one entry point. The IDE LLM calls `inspect_codebase`
 * with a free-form `query` plus optional repo hints; the bridge
 * dispatches one Mastra run, lets the agent's wrappers do the work,
 * and wraps the run's accumulated mini-repos into the D17′ envelope.
 *
 * Wire envelope (D17′):
 *
 *   { ok: true,
 *     mini_repos: MiniRepo[],     // from runs.minirepo_json
 *     prose_summary?: string,     // ≤ 1KB; only when no wrapper ran
 *     warnings: string[] }        // populated from inspector telemetry
 *
 * The agent's free-form prose stream is NOT forwarded to the IDE
 * unless no wrapper invocation populated `runs.minirepo_json` — in
 * which case we surface a 1KB summary so chit-chat / clarifications
 * still produce something useful.
 *
 * Phase 7 explicit `bridge_tools` rows wrap their `output_summary` at
 * an 8KB cap (operators authored prose on purpose). Same envelope
 * shape, larger prose budget; mini-repos still ride along when a
 * Phase 7 prompt template causes the agent to call wrappers internally.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { dispatchRun } from '@agent-bridge/agents'
import { runsRepo, schema, type AgentBridgeDb } from '@agent-bridge/db'
import { bridgeStreamId } from '@agent-bridge/shared'
import type { EventBus } from '@agent-bridge/shared/event-bus'

// ─── Public surface ──────────────────────────────────────────────────────

export interface BridgeContext {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  /**
   * One Mastra thread per bridge subprocess so multi-turn IDE chats
   * keep continuity. Sourced from `BRIDGE_THREAD_ID` in the bridge
   * entrypoint.
   */
  readonly threadId: string
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
 * (when no wrapper ran) gets 1 KiB; Phase 7 explicit tools that author
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

  // Optional hint plumbing: the wrappers each accept their own
  // `repo_hint`, but if the IDE supplied one we prepend a one-line
  // hint to the prompt so the agent's LLM picks the right repo on the
  // first try without round-tripping through `list_repos`.
  const hintLine = formatHintLine(rawArgs)
  const prompt = hintLine.length > 0 ? `${hintLine}\n\n${query}` : query

  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: prompt,
    streamId,
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

  const envelope: WireEnvelope = {
    ok: true,
    mini_repos: miniRepos,
    ...(proseSummary.length > 0 ? { prose_summary: proseSummary } : {}),
    warnings: [],
  }
  return jsonEnvelope(envelope)
}

// ─── Phase 7 explicit bridge tool ────────────────────────────────────────

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
 * Phase 7 explicit `bridge_tools` rows continue to work under D17′
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

  const prompt = renderPromptTemplate(bridgeTool.promptTemplate, rawArgs).trim()
  if (prompt.length === 0) {
    return mcpError(
      'Rendered prompt was empty — check that your bridge tool template references args correctly.',
    )
  }

  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)

  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: agent.id,
    inputPrompt: prompt,
    streamId,
    bridgeToolName: bridgeTool.name,
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

  const envelope: WireEnvelope = {
    ok: true,
    mini_repos: miniRepos,
    ...(proseSummary.length > 0 ? { prose_summary: proseSummary } : {}),
    warnings: [],
  }
  return jsonEnvelope(envelope)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface WireEnvelope {
  readonly ok: true
  readonly mini_repos: readonly unknown[]
  readonly prose_summary?: string
  readonly warnings: readonly string[]
}

function formatHintLine(rawArgs: Record<string, unknown>): string {
  const parts: string[] = []
  for (const k of ['repo_hint', 'remote_url', 'local_folder', 'branch'] as const) {
    const v = rawArgs[k]
    if (typeof v === 'string' && v.trim().length > 0) {
      parts.push(`${k}=${v.trim()}`)
    }
  }
  if (parts.length === 0) return ''
  return `[IDE hint: ${parts.join(', ')}]`
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
