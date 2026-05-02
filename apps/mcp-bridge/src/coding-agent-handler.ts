/**
 * Coding-agent toolkit handler. the bridge-side entry point for every
 * virtual coding-agent tool call.
 *
 * Inbound: the MCP `tools/call` request handler in `index.ts` routes
 * any `entry.source.kind === 'virtual'` to `executeCodingAgentTool`.
 * Outbound: an MCP `content: [{ type: 'text', text: <json> }]` payload
 * the IDE coding agent will JSON-parse client-side.
 *
 * Three execution branches:
 *
 *   1. Synchronous (`list_repos` only): runs the resolver-loader,
 *      formats the attached repos, returns without calling the LLM.
 *      No `runs` row is written. `list_repos` is a metadata read,
 *      not a "task" worth auditing on the chat-history timeline.
 *
 *   2. Resolver short-circuit: when `resolveRepoHint` returns a
 *      `clarification` or hard `error` outcome, we serialise the
 *      result into the wire envelope WITHOUT invoking the LLM. The
 *      IDE either re-prompts the user (for `needs_clarification`) or
 *      surfaces the error message. No `runs` row either. the LLM
 *      never ran.
 *
 *   3. Resolver hit (`single` or `all`): builds the structured
 *      `<coding_agent_call>...</coding_agent_call>` preamble from the
 *      resolver's output, renders the operator-defined prompt template
 *      with IDE-supplied args, concatenates the two as the LLM prompt,
 *      then calls `dispatchRun` to completion. Reads
 *      `runs.output_summary`, JSON-parses it, builds the success
 *      envelope. JSON-parse failure downgrades to
 *      `{ schema_unmatched: true, confidence: 'low' }` with the raw
 *      text inside `answer.text` so the IDE has SOMETHING to render.
 *
 * Hallucination defence enforced by the bridge (not the LLM):
 *
 *   - The resolved `repo_id` / `label` / `remote_url` is in the
 *     preamble. The LLM cannot retroactively pretend a different repo
 *     was targeted; the wire envelope's `resolved_repo` field is set
 *     by the bridge from the resolver, not from anything the LLM
 *     emitted.
 *   - `tool` and `agent` on the wire envelope are bridge-derived.
 *   - The prompt template is rendered against the IDE's args first,
 *     then prepended with the preamble. placeholders cannot be
 *     used to inject preamble fields.
 *
 * See `docs/ARCHITECTURE.md` §10 for the full coding-agent toolkit
 * design (envelope, resolver, system skill, telemetry).
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import {
  dispatchRun,
  isClarification,
  isResolvedAll,
  isResolvedSingle,
  isResolverError,
  loadAttachedRepos,
  resolveRelatedRepos,
  resolveRepoHint,
  type VirtualBridgeToolDefinition,
} from '@agent-bridge/agents'
import { runsRepo, schema, type AgentBridgeDb } from '@agent-bridge/db'
import {
  ALL_REPOS_SENTINEL,
  agentStreamId,
  bridgeStreamId,
  codingAgentHintSchema,
  type AttachedRepo,
  type CodingAgentEnvelope,
  type CodingAgentEventConfidence,
  type CodingAgentEventScope,
  type CodingAgentEventToolName,
  type CodingAgentRepoClarificationPayload,
  type CodingAgentRepoResolvedPayload,
  type CodingAgentToolCompletedPayload,
  type CodingAgentToolName,
  type RepoResolution,
  type ResolvedAllRepos,
  type ResolvedSingleRepo,
  type RunEvent,
} from '@agent-bridge/shared'
import type { EventBus } from '@agent-bridge/shared/event-bus'

// ─── Public surface ──────────────────────────────────────────────────────

export interface CodingAgentHandlerCtx {
  readonly db: AgentBridgeDb
  readonly eventBus: EventBus
  /**
   * One Mastra thread per bridge subprocess so multi-turn IDE chats
   * keep continuity. Sourced from `BRIDGE_THREAD_ID` in the bridge
   * entrypoint.
   */
  readonly threadId: string
}

export interface CodingAgentHandlerEntry {
  readonly name: string
  readonly agent: { readonly id: string; readonly slug: string }
  readonly def: VirtualBridgeToolDefinition
}

/**
 * The handler returns a structurally-shaped MCP `tools/call` result
 * (`{ isError?, content: [{ type: 'text', text }] }`). We don't
 * declare a named type. the MCP SDK's `ServerResult` union is built
 * from Zod schemas and naming our return type forces TS into
 * widening fights with the SDK's variants. Each `return` builds
 * the literal shape (using `as const` on `type: 'text'`) so the
 * inferred union slots cleanly into the SDK's expected return.
 */

/**
 * Top-level entry point. Validates the IDE's args, branches on the
 * tool kind, and returns an MCP `content` payload. Errors that
 * prevent a run from starting (deleted agent, missing provider,
 * malformed args) become MCP-level `isError: true` results;
 * resolver-level outcomes (`clarification` / `error`) are returned
 * as plain JSON envelopes so the IDE can parse them as data.
 */
export async function executeCodingAgentTool(
  ctx: CodingAgentHandlerCtx,
  entry: CodingAgentHandlerEntry,
  rawArgs: Record<string, unknown>,
) {
  // ── Validate the agent + provider haven't been deleted between
  //    `tools/list` and this `tools/call`. (Same defence the
  //    Phase-5/7 path does. keeps FK errors from surfacing as
  //    confusing 23503s.)
  const [fresh] = await ctx.db.db
    .select({
      id: schema.agents.id,
      llmProviderId: schema.agents.llmProviderId,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, entry.agent.id))
    .limit(1)
  if (!fresh) {
    return mcpError(
      `Agent "${entry.agent.slug}" was deleted between tool listing and this call.`,
    )
  }
  if (entry.def.name !== 'list_repos' && !fresh.llmProviderId) {
    // list_repos is the only tool that doesn't need an LLM; the
    // others all dispatchRun.
    return mcpError(
      `Agent "${entry.agent.slug}" no longer has an LLM provider configured.`,
    )
  }

  // ── Pull the hint object out of the IDE args. The codingAgentHintSchema
  //    is permissive (every field optional) so we can validate without
  //    rejecting tool-specific args we'll consume later.
  const hintParse = codingAgentHintSchema.safeParse(pickHintFields(rawArgs))
  if (!hintParse.success) {
    return jsonEnvelope(buildErrorEnvelope(entry, {
      code: 'missing_input',
      message: `Invalid hint object: ${hintParse.error.message}`,
    }))
  }
  const hint = hintParse.data

  // ── Branch on tool kind.
  if (entry.def.synchronous) {
    return handleListRepos(ctx, entry)
  }

  // ── Load candidates (one DB hit, shared with the resolver and
  //    later with `related_repos` resolution).
  const repos = await loadAttachedRepos({
    db: ctx.db,
    agentId: entry.agent.id,
    readyOnly: false,
  })

  const resolution = resolveRepoHint({
    repos,
    hint,
    allowAllRepos: entry.def.allowAllRepos,
  })

  // ── Resolver short-circuit: clarification or error → wire envelope
  //    immediately, no LLM call, no `runs` row.
  if (isClarification(resolution)) {
    // Fan-out only. there's no `runs` row yet (and never will be
    // for this call), so persisting an audit row would orphan it.
    void publishCodingAgentEvent({
      eventBus: ctx.eventBus,
      agentId: entry.agent.id,
      runId: null,
      kind: 'coding-agent.repo.clarification_requested',
      payload: {
        tool: entry.def.name,
        kind: resolution.kind,
        candidate_count: resolution.candidates.length,
        allow_all_repos: resolution.allow_all_repos,
      } satisfies CodingAgentRepoClarificationPayload,
    })
    return jsonEnvelope({
      ok: false,
      code: 'needs_clarification',
      message: resolution.message,
      clarification: {
        kind: resolution.kind,
        candidates: resolution.candidates,
        allow_all_repos: resolution.allow_all_repos,
        suggested_replies: resolution.suggested_replies,
      },
    } satisfies CodingAgentEnvelope)
  }
  if (isResolverError(resolution)) {
    return jsonEnvelope(
      buildErrorEnvelope(entry, {
        code: resolution.code,
        message: resolution.message,
        candidates: resolution.candidates,
      }),
    )
  }

  // ── Resolver hit. Resolve any `related_repos` the IDE passed, build
  //    the preamble, render the template, dispatch.
  const relatedHints = parseRelatedRepoHints(rawArgs)
  const related = relatedHints.length > 0
    ? resolveRelatedRepos({ repos, hints: relatedHints })
    : { resolved: [], unresolved: [] }

  const strictness = pickStrictness(rawArgs)

  const preamble = buildResolutionPreamble({
    tool: entry.def.name,
    agent: entry.agent,
    resolution,
    related: related.resolved,
    strictness,
  })

  const renderedTemplate = renderPromptTemplate(
    entry.def.promptTemplate,
    rawArgs,
  )

  const prompt = `${preamble}\n\n${renderedTemplate}`.trim()
  if (prompt.length === 0) {
    return jsonEnvelope(
      buildErrorEnvelope(entry, {
        code: 'internal',
        message: 'rendered prompt was empty (template + preamble produced no content)',
      }),
    )
  }

  // ── Dispatch through the existing audit/run pipeline.
  const runId = randomUUID()
  const streamId = bridgeStreamId(runId)
  await runsRepo.createRun(ctx.db, {
    id: runId,
    agentId: entry.agent.id,
    inputPrompt: prompt,
    streamId,
    bridgeToolName: entry.name,
  })

  // Emit `coding-agent.repo.resolved` BEFORE dispatch so the audit
  // row lands in `run_events` ahead of any token batches the
  // dispatcher will later append. Operators reading the timeline
  // get "resolver decided" → "LLM streamed" → "tool completed" in
  // order.
  void publishCodingAgentEvent({
    eventBus: ctx.eventBus,
    agentId: entry.agent.id,
    db: ctx.db,
    runId,
    streamId,
    kind: 'coding-agent.repo.resolved',
    payload: buildResolvedPayload({
      runId,
      tool: entry.def.name,
      hint,
      resolution,
      related,
    }),
  })

  const dispatchStart = Date.now()
  try {
    await dispatchRun({
      db: ctx.db,
      eventBus: ctx.eventBus,
      agentId: entry.agent.id,
      runId,
      streamId,
      prompt,
      threadId: ctx.threadId,
    })
  } catch (err) {
    return mcpError(
      err instanceof Error ? err.message : 'Bridge dispatch failed',
    )
  }
  const durationMs = Date.now() - dispatchStart

  const finalRow = await runsRepo.getRun(ctx.db, runId)
  if (!finalRow) {
    return mcpError(
      `Run ${runId} disappeared after dispatch. likely a row was deleted mid-flight.`,
    )
  }
  if (finalRow.status === 'error') {
    // dispatchRun already redacted error_message before persisting.
    return jsonEnvelope(
      buildErrorEnvelope(entry, {
        code: 'internal',
        message: finalRow.errorMessage ?? 'Run failed',
      }),
    )
  }

  const rawOutput = finalRow.outputSummary?.trim() ?? ''
  const envelope = buildSuccessEnvelope({
    entry,
    resolution,
    related,
    rawOutput,
  })

  // Pull `confidence` / `groundedness` / `schema_unmatched` straight
  // from the wire envelope. they're already either LLM-emitted or
  // bridge-defaulted by `buildSuccessEnvelope`. No second extraction
  // logic, no drift.
  if (envelope.ok) {
    void publishCodingAgentEvent({
      eventBus: ctx.eventBus,
      agentId: entry.agent.id,
      db: ctx.db,
      runId,
      streamId,
      kind: 'coding-agent.tool.completed',
      payload: {
        runId,
        tool: entry.def.name as CodingAgentEventToolName,
        scope: envelope.scope as CodingAgentEventScope,
        confidence: envelope.confidence as CodingAgentEventConfidence,
        ...(envelope.groundedness
          ? { groundedness: envelope.groundedness }
          : {}),
        duration_ms: durationMs,
        ...(envelope.schema_unmatched
          ? { schema_unmatched: true }
          : {}),
      } satisfies CodingAgentToolCompletedPayload,
    })
  }

  return jsonEnvelope(envelope)
}

// ─── list_repos (synchronous) ────────────────────────────────────────────

async function handleListRepos(
  ctx: CodingAgentHandlerCtx,
  entry: CodingAgentHandlerEntry,
) {
  const repos = await loadAttachedRepos({
    db: ctx.db,
    agentId: entry.agent.id,
    readyOnly: false,
  })
  const envelope = {
    ok: true as const,
    tool: 'list_repos' as const,
    agent: entry.agent,
    resolved_repo: null,
    related_repos: [],
    scope: 'all' as const,
    confidence: 'high' as const,
    answer: {
      summary: `${repos.length} repo${repos.length === 1 ? '' : 's'} attached.`,
      repos: repos.map((r) => ({
        id: r.repo_id,
        label: r.label,
        aliases: r.aliases,
        remote_url: r.remote_url,
        branch: r.branch,
        role: r.role,
        description: r.description,
        status: r.status,
      })),
    },
    uncertainty_notes: [],
    warnings: [],
  } satisfies CodingAgentEnvelope
  return jsonEnvelope(envelope)
}

// ─── Preamble + template helpers ─────────────────────────────────────────

interface BuildPreambleArgs {
  readonly tool: CodingAgentToolName
  readonly agent: { id: string; slug: string }
  readonly resolution: ResolvedSingleRepo | ResolvedAllRepos
  readonly related: readonly AttachedRepo[]
  readonly strictness: 'strict' | 'balanced' | 'exploratory'
}

/**
 * Render the structured `<coding_agent_call>` block the system skill
 * expects at the top of every coding-agent prompt. The block carries
 * the resolver's authoritative output so the LLM can't second-guess
 * which repo it's targeting. the bridge wins, not the LLM.
 *
 * Format intentionally uses XML-ish tags rather than JSON because:
 *   - Tags survive token-by-token streaming (an unfinished JSON
 *     object can't be inferred mid-stream; a partially-emitted tag
 *     can).
 *   - Tags read naturally as system-prompt prose; tags-in-prose is
 *     a well-explored prompting pattern in the Anthropic ecosystem.
 */
function buildResolutionPreamble(args: BuildPreambleArgs): string {
  const { tool, agent, resolution, related, strictness } = args
  const parts: string[] = []
  parts.push('<coding_agent_call>')
  parts.push(`  <tool>${tool}</tool>`)
  parts.push(`  <agent slug="${agent.slug}" id="${agent.id}" />`)
  parts.push(`  <scope>${resolution.scope}</scope>`)
  parts.push(`  <strictness>${strictness}</strictness>`)
  if (isResolvedSingle(resolution)) {
    const r = resolution.repo
    parts.push(
      `  <resolved_repo id="${r.repo_id}" label=${jsonAttr(r.label)} remote_url=${jsonAttr(r.remote_url)} branch=${jsonAttr(r.branch)} matched_signal="${resolution.matched_signal}" confidence="${resolution.confidence}" />`,
    )
  } else if (isResolvedAll(resolution)) {
    parts.push('  <resolved_repo>__all__</resolved_repo>')
    parts.push(`  <all_repos count="${resolution.repos.length}">`)
    for (const r of resolution.repos) {
      parts.push(
        `    <repo id="${r.repo_id}" label=${jsonAttr(r.label)} />`,
      )
    }
    parts.push('  </all_repos>')
  }
  if (related.length > 0) {
    parts.push(`  <related_repos count="${related.length}">`)
    for (const r of related) {
      parts.push(`    <repo id="${r.repo_id}" label=${jsonAttr(r.label)} />`)
    }
    parts.push('  </related_repos>')
  }
  parts.push('</coding_agent_call>')
  return parts.join('\n')
}

/**
 * Quote an XML attribute value defensively. We use JSON.stringify for
 * the quoting because attribute values may include `<`, `>`, `&`, and
 * `"`. JSON's escaping handles all four cleanly. The "attribute"
 * is then surrounded by the JSON-quoted string itself; no
 * additional outer quotes.
 */
function jsonAttr(s: string): string {
  return JSON.stringify(s)
}

/**
 * `{{ name }}` template renderer (verbatim copy of the Phase-7 helper
 * in `index.ts`). Unknown placeholders interpolate as the empty
 * string. Object args get `JSON.stringify`'d so structured fields
 * like `proposed_change` render as inline JSON the LLM can read.
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

// ─── Args extraction ─────────────────────────────────────────────────────

const HINT_FIELD_NAMES = [
  'repo_hint',
  'remote_url',
  'local_folder',
  'branch',
] as const

function pickHintFields(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of HINT_FIELD_NAMES) {
    if (k in raw && raw[k] !== undefined && raw[k] !== null) {
      out[k] = raw[k]
    }
  }
  return out
}

function parseRelatedRepoHints(raw: Record<string, unknown>): string[] {
  const v = raw['related_repos']
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
}

function pickStrictness(
  raw: Record<string, unknown>,
): 'strict' | 'balanced' | 'exploratory' {
  const v = raw['strictness']
  if (v === 'strict' || v === 'exploratory') return v
  return 'balanced'
}

// ─── Envelope builders ───────────────────────────────────────────────────

interface BuildSuccessEnvelopeArgs {
  readonly entry: CodingAgentHandlerEntry
  readonly resolution: ResolvedSingleRepo | ResolvedAllRepos
  readonly related: {
    readonly resolved: readonly AttachedRepo[]
    readonly unresolved: readonly { hint: string; reason: string }[]
  }
  readonly rawOutput: string
}

interface ParsedLlmJson {
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly groundedness?: { claims: number; grounded: number; ungrounded: number }
  readonly uncertainty_notes?: string[]
  readonly warnings?: string[]
  readonly open_questions?: string[]
  readonly answer?: Record<string, unknown>
}

function buildSuccessEnvelope(
  args: BuildSuccessEnvelopeArgs,
): CodingAgentEnvelope {
  const { entry, resolution, related, rawOutput } = args
  const parsed = tryParseLlmJson(rawOutput)

  const baseWarnings: string[] = []
  for (const u of related.unresolved) {
    baseWarnings.push(`unresolved related_repos hint "${u.hint}": ${u.reason}`)
  }

  const resolvedRepoWire = isResolvedSingle(resolution)
    ? {
        id: resolution.repo.repo_id,
        label: resolution.repo.label,
        remote_url: resolution.repo.remote_url,
        branch: resolution.repo.branch,
      }
    : null

  const relatedRepoWire = related.resolved.map((r) => ({
    id: r.repo_id,
    label: r.label,
  }))

  if (parsed.kind === 'error') {
    // JSON parse failed. degrade to schema_unmatched, surface raw text.
    return {
      ok: true,
      tool: entry.def.name,
      agent: entry.agent,
      resolved_repo: resolvedRepoWire,
      related_repos: relatedRepoWire,
      scope: resolution.scope,
      confidence: 'low',
      answer: {
        text: rawOutput.length > 0
          ? rawOutput
          : '(agent returned no text. check the run history in the UI)',
      },
      uncertainty_notes: [
        `LLM output did not parse as JSON: ${parsed.message}`,
      ],
      warnings: baseWarnings,
      schema_unmatched: true,
    } satisfies CodingAgentEnvelope
  }

  const json = parsed.value
  const confidence = json.confidence ?? 'medium'
  const groundedness = json.groundedness
  const uncertaintyNotes = Array.isArray(json.uncertainty_notes)
    ? json.uncertainty_notes
    : []
  const llmWarnings = Array.isArray(json.warnings) ? json.warnings : []
  const openQuestions = Array.isArray(json.open_questions)
    ? json.open_questions
    : []
  const answerObject =
    typeof json.answer === 'object' && json.answer !== null && !Array.isArray(json.answer)
      ? json.answer
      : json // fall back to using the whole JSON as `answer`

  // Splice open_questions into `answer` so the IDE finds them where
  // the per-tool schema documents them. The system skill puts them
  // at the LLM's top level for ergonomics; the wire envelope keeps
  // them on `answer` so per-tool consumers don't need a special case.
  const finalAnswer: Record<string, unknown> = {
    ...answerObject,
  }
  if (openQuestions.length > 0 && !('open_questions' in finalAnswer)) {
    finalAnswer.open_questions = openQuestions
  }

  return {
    ok: true,
    tool: entry.def.name,
    agent: entry.agent,
    resolved_repo: resolvedRepoWire,
    related_repos: relatedRepoWire,
    scope: resolution.scope,
    confidence,
    ...(groundedness ? { groundedness } : {}),
    answer: finalAnswer,
    uncertainty_notes: uncertaintyNotes,
    warnings: [...baseWarnings, ...llmWarnings],
  } satisfies CodingAgentEnvelope
}

function buildErrorEnvelope(
  entry: CodingAgentHandlerEntry,
  err: {
    code:
      | 'no_repos_attached'
      | 'repo_not_found'
      | 'repo_ambiguous'
      | 'repo_not_ready'
      | 'missing_input'
      | 'internal'
    message: string
    candidates?: ReadonlyArray<{
      repo_id: string
      label: string
      score: number
      matched_signal:
        | 'remote_url'
        | 'role'
        | 'alias'
        | 'local_folder'
        | 'url_tail'
    }>
  },
): CodingAgentEnvelope {
  void entry // kept for symmetry with success builder + future telemetry
  return {
    ok: false,
    code: err.code,
    message: err.message,
    ...(err.candidates && err.candidates.length > 0
      ? { candidates: [...err.candidates] }
      : {}),
  }
}

// ─── JSON parse helper ───────────────────────────────────────────────────

type ParseResult =
  | { kind: 'ok'; value: ParsedLlmJson }
  | { kind: 'error'; message: string }

/**
 * Best-effort JSON parser for LLM output. Handles three real-world
 * shapes that show up in practice:
 *
 *   1. Pure JSON: the LLM emitted the JSON directly. `JSON.parse`
 *      succeeds.
 *   2. Fenced JSON: ` ```json\n{...}\n``` `. We strip the fence and
 *      re-parse.
 *   3. JSON embedded in prose: the LLM wrote a sentence and then a
 *      JSON object. We grab the first `{...}` block and parse.
 *
 * On parse failure we return an error message. the caller wraps the
 * raw output in a `schema_unmatched: true` envelope so the IDE
 * sees SOMETHING actionable.
 */
function tryParseLlmJson(raw: string): ParseResult {
  if (raw.length === 0) {
    return { kind: 'error', message: 'empty output' }
  }
  const trimmed = raw.trim()

  // Fenced form first. it's the most common when the model is
  // instructed to "output JSON" (anthropic models often wrap).
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed

  // Direct parse first.
  try {
    const parsed = JSON.parse(candidate) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'error', message: 'JSON is not an object' }
    }
    return { kind: 'ok', value: parsed as ParsedLlmJson }
  } catch {
    // Fall through.
  }

  // Last resort: pluck the first balanced `{...}` from the candidate.
  const obj = extractFirstObject(candidate)
  if (!obj) {
    return { kind: 'error', message: 'no JSON object found' }
  }
  try {
    const parsed = JSON.parse(obj) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'error', message: 'JSON is not an object' }
    }
    return { kind: 'ok', value: parsed as ParsedLlmJson }
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'parse error',
    }
  }
}

/**
 * Brace-balanced extractor. Walks the string char by char tracking
 * `{` / `}` depth, ignoring braces inside strings (so `"a{b}c"`
 * doesn't fool the depth counter). Good enough for LLM output;
 * doesn't try to be a real JSON parser.
 */
function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inStr) {
      if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

// ─── MCP envelope helpers ────────────────────────────────────────────────

function jsonEnvelope(envelope: CodingAgentEnvelope) {
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

// ─── Telemetry plumbing ──────────────────────────────────────────────────

interface PublishCodingAgentEventInput {
  readonly eventBus: EventBus
  readonly agentId: string
  /**
   * `null` for fan-out-only events (e.g. clarification requests
   * before a `runs` row exists). Any other value is the run that
   * owns this event for `run_events` audit + per-run channel.
   */
  readonly runId: string | null
  /** Required when `runId` is set; passed straight to publish. */
  readonly streamId?: string
  /** Required when we want a `run_events` audit row written. */
  readonly db?: AgentBridgeDb
  readonly kind:
    | 'coding-agent.repo.resolved'
    | 'coding-agent.repo.clarification_requested'
    | 'coding-agent.tool.completed'
  readonly payload: unknown
}

/**
 * Publish a coding-agent telemetry event. Mirrors the dispatcher's
 * `publishAndAudit` pattern but without the redactor. coding-agent
 * payloads carry repo metadata + IDE-supplied hints + match scores,
 * none of which include user secrets. (The hint object COULD
 * theoretically contain a typo'd secret if the IDE coding agent
 * misuses it, but that's a misbehaving IDE, not our trust
 * boundary.)
 *
 * Always publishes to the per-agent channel so the right-rail
 * Activity panel sees the event regardless of whether a `runs` row
 * exists. Per-run publish + audit-row insert only happen when a
 * `runId` is supplied. clarifications skip both.
 *
 * Errors are swallowed (logged to stderr). telemetry failure must
 * never break a tool call. Same discipline as the dispatcher.
 */
function publishCodingAgentEvent(
  input: PublishCodingAgentEventInput,
): Promise<void> {
  const { eventBus, agentId, runId, streamId, db, kind, payload } = input
  const event: RunEvent = {
    kind,
    ts: Date.now(),
    streamId: streamId ?? agentStreamId(agentId),
    data: payload,
  }
  // Per-run channel first (chat panel subscribes here when a run
  // exists), then per-agent fan-out (Activity panel always
  // subscribes).
  const tasks: Promise<unknown>[] = []
  if (runId !== null && streamId) {
    tasks.push(eventBus.publish(event))
  }
  tasks.push(
    eventBus.publish({ ...event, streamId: agentStreamId(agentId) }),
  )
  if (runId !== null && db) {
    tasks.push(
      runsRepo
        .appendEvent(db, {
          runId,
          kind: event.kind,
          payload: (event.data as Record<string, unknown>) ?? null,
          ts: new Date(event.ts),
        })
        .catch((err: unknown) => {
          console.error(
            `[coding-agent-handler] audit insert failed (run=${runId}, kind=${kind}):`,
            err,
          )
        }),
    )
  }
  return Promise.all(tasks)
    .then(() => undefined)
    .catch((err: unknown) => {
      console.error(
        `[coding-agent-handler] telemetry publish failed (kind=${kind}):`,
        err,
      )
    })
}

/**
 * Build the `coding-agent.repo.resolved` payload from the resolver's
 * structured output. Pulls only the fields the audit row needs -
 * full `score_table` capped at top 3 entries to keep `run_events`
 * row size bounded for agents with dozens of attached repos.
 */
function buildResolvedPayload(args: {
  runId: string
  tool: CodingAgentToolName
  hint: { repo_hint?: string; remote_url?: string; local_folder?: string; branch?: string }
  resolution: ResolvedSingleRepo | ResolvedAllRepos
  related: { resolved: readonly AttachedRepo[]; unresolved: readonly { hint: string; reason: string }[] }
}): CodingAgentRepoResolvedPayload {
  const { runId, tool, hint, resolution, related } = args
  if (resolution.scope === 'single') {
    return {
      runId,
      tool: tool as CodingAgentEventToolName,
      hint,
      scope: 'single',
      picked: {
        repo_id: resolution.repo.repo_id,
        label: resolution.repo.label,
        matched_signal:
          resolution.matched_signal as CodingAgentEventToolName extends never
            ? never
            : 'remote_url' | 'role' | 'alias' | 'local_folder' | 'url_tail',
        confidence: resolution.confidence as CodingAgentEventConfidence,
      },
      score_table: resolution.score_table.slice(0, 3),
      picked_alias_count: resolution.repo.aliases.length,
      unresolved_related_count: related.unresolved.length,
    }
  }
  // scope === 'all'
  return {
    runId,
    tool: tool as CodingAgentEventToolName,
    hint,
    scope: 'all',
    picked: null,
    score_table: [],
    unresolved_related_count: related.unresolved.length,
  }
}

// Re-export sentinel for symmetry. bridge handlers can import every
// coding-agent constant from one place.
export { ALL_REPOS_SENTINEL }
