/**
 * Per-call context-budget estimator. Walks every component buildAgent
 * injects into a chat-completions request — system prompt, skills,
 * attached-repo hints, repo edges, gitnexus tool dict, external MCP
 * tools, custom tools — and returns a structured token breakdown so
 * the UI can show "you're sending 16k tokens before the user types,
 * 87% of headroom" before the user hits the wall.
 *
 * Tokenization uses `js-tiktoken` with the encoding picked from the
 * agent's model id (cl100k_base for gpt-3.5/gpt-4, o200k_base for
 * gpt-4o + o-series). For non-OpenAI models the count is approximate
 * but still much better than a /4 char heuristic — every modern BPE
 * tokenizer produces similar token densities.
 *
 * Cheap by design: doesn't spawn subprocesses, doesn't do network
 * calls beyond loading the cached gitnexus tool list. Safe to call
 * on every Configure-tab open.
 */

import { encodingForModel, getEncoding, type TiktokenEncoding } from 'js-tiktoken'
import { and, asc, eq } from 'drizzle-orm'
import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import {
  INSPECTOR_SYSTEM_PROMPT_VERSION,
  loadInspectorSystemPrompt,
} from './inspector/system-prompt.js'
import { inspectorWrapperNames } from '@agent-bridge/shared'

// Known cap per model. The Configure-tab card shows a percentage of
// this; absent entries fall back to "unknown" so the user sees a
// neutral-state pill instead of misleading math. Update this map as
// new models are released — better stale than absent.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI cloud
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-2024-05-13': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-4o-2024-11-20': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-2024-04-09': 128_000,
  'gpt-4': 8_192,
  'gpt-4-32k': 32_768,
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-16k': 16_385,
  'gpt-3.5-turbo-0125': 16_385,
  'chatgpt-4o-latest': 128_000,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  // Common local model defaults — what most recent llama.cpp / ollama
  // builds ship with. Operators with custom rope/extended contexts
  // will see the wrong number; that's a known limitation.
  'llama-3.1': 128_000,
  'llama-3.2': 128_000,
  'llama-3.3': 128_000,
  'qwen2.5': 32_768,
  mistral: 32_768,
}

function lookupContextLimit(model: string | null): number | null {
  if (!model) return null
  if (MODEL_CONTEXT_LIMITS[model] !== undefined) {
    return MODEL_CONTEXT_LIMITS[model]
  }
  // Prefix match for snapshotted variants (gpt-4o-2024-08-06,
  // o3-mini-something, etc.)
  for (const [prefix, cap] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return cap
  }
  return null
}

/**
 * Pick a tokenizer encoding for a model id. Defaults to `cl100k_base`
 * — the most widely-compatible encoding — for unrecognized models so
 * we still produce a reasonable count.
 */
function pickEncoding(model: string | null): TiktokenEncoding {
  if (!model) return 'cl100k_base'
  if (/^(gpt-4o|chatgpt-4o|o\d)/.test(model)) return 'o200k_base'
  return 'cl100k_base'
}

interface TiktokenLite {
  encode: (text: string) => number[]
}

function loadEncoding(model: string | null): TiktokenLite {
  // js-tiktoken's encodingForModel throws on unknown model ids, so we
  // fall back to a known encoding when the agent's model isn't in its
  // built-in registry. The encoding choice mostly affects efficiency
  // for code-heavy text; both encodings produce defensibly close
  // counts for the natural-language content most of our payload is.
  if (model) {
    try {
      return encodingForModel(model as Parameters<typeof encodingForModel>[0])
    } catch {
      // fall through to the default
    }
  }
  return getEncoding(pickEncoding(model))
}

function tokenize(enc: TiktokenLite, text: string): number {
  if (!text) return 0
  return enc.encode(text).length
}

export interface TokenEstimateSkill {
  readonly name: string
  readonly tokens: number
}

export interface TokenEstimateTool {
  readonly name: string
  readonly tokens: number
  readonly source: 'gitnexus' | 'mcp' | 'custom'
}

export interface TokenEstimateSystemSkill {
  /** Display name for the budget card row. */
  readonly name: string
  /** Skill version. bumping it flushes the BuiltAgent cache. */
  readonly version: string
  /** Tokens the .md body contributes to every prompt. */
  readonly tokens: number
}

export interface TokenEstimateGitnexusLibrarySkills {
  /** gitnexus npm package version (e.g. `1.6.3`). */
  readonly version: string
  /** Number of skill files attached. */
  readonly count: number
  /** Tokens the concatenated bodies + heading contribute to every prompt. */
  readonly tokens: number
}

export interface TokenEstimate {
  readonly model: string | null
  readonly encoding: TiktokenEncoding
  readonly modelContextLimit: number | null
  readonly parts: {
    readonly systemPrompt: number
    readonly skills: ReadonlyArray<TokenEstimateSkill>
    readonly skillsTotal: number
    /**
     * Coding-agent system skill. the markdown body
     * `composeInstructions` auto-appends to every agent. Always
     * present since P2; budget card surfaces it as "Built-in skill".
     * `null` only when the .md fails to load (build artifact missing
     * in dist), which the UI flags as a config gap.
     */
    readonly systemSkill: TokenEstimateSystemSkill | null
    /**
     * GitNexus library skills (vendor-shipped guidance from the
     * gitnexus npm package's `skills/` dir). Auto-attached to every
     * agent's instructions in `composeInstructions`. `null` when
     * the gitnexus package isn't reachable or the dir is empty.
     */
    readonly gitnexusLibrarySkills: TokenEstimateGitnexusLibrarySkills | null
    readonly attachedReposHint: number
    readonly repoEdgesHint: number
    readonly tools: ReadonlyArray<TokenEstimateTool>
    readonly toolsTotal: number
  }
  /**
   * Sum of every part above. Doesn't include per-call dynamic content
   * (recent-message replay, semantic-recall chunks, the user's actual
   * message) — those vary by turn so we couldn't quote a stable number
   * without faking it. The card surfaces this as "baseline" and notes
   * that runtime additions push the actual call slightly higher.
   */
  readonly baselineTotal: number
}

/**
 * Short, stable description per inspector wrapper for the budget card.
 * The Mastra Agent's tool dict ships richer text (see
 * `inspector/index.ts`); we only need approximate token weight here.
 */
function describeInspectorWrapper(name: string): string {
  switch (name) {
    case 'find_in_codebase':
      return 'Hybrid keyword + semantic code search across attached repos. Returns mini-repo with files + chunks.'
    case 'trace_flow':
      return 'Walk the call/import graph from a starting anchor toward a goal. Returns mini-repo with graph_subset + chunks.'
    case 'assess_change_impact':
      return 'Compute blast radius for a proposed change (rename / remove / modify / add). Returns direct + transitive dependents and operator-curated cross-repo edges.'
    case 'debug_help':
      return 'Diagnose a bug from raw error text. Extracts file paths and symbols, finds suspect call sites with chunks.'
    case 'understand_module':
      return 'Explain a file or symbol — body + outgoing dependencies (depth ≤ 2).'
    case 'list_repos':
      return 'List the repositories attached to this agent (label, role, status, aliases).'
    default:
      return ''
  }
}

/**
 * Compute the token breakdown for an agent's static payload — the
 * stuff that ships on every chat completion regardless of which
 * thread or message the user sends.
 */
export async function estimateAgentTokens(
  handle: AgentBridgeDb,
  agentId: string,
): Promise<TokenEstimate> {
  const { db } = handle

  const [agentRow] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  if (!agentRow) {
    throw new Error(`[token-estimate] agent ${agentId} not found`)
  }

  // Resolve chat model via the agent's configured provider. Provider
  // owns the model identity now; estimating without one yields a
  // null model id, which `loadEncoding` falls back on.
  const [providerRow] = agentRow.llmProviderId
    ? await db
        .select({ defaultModel: schema.llmProviders.defaultModel })
        .from(schema.llmProviders)
        .where(eq(schema.llmProviders.id, agentRow.llmProviderId))
        .limit(1)
    : [undefined]
  const modelId = providerRow?.defaultModel ?? null

  const skillRows = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.agentId, agentId))
    .orderBy(asc(schema.skills.position), asc(schema.skills.createdAt))

  const repoRows = await db
    .select({
      remoteUrl: schema.repos.remoteUrl,
      branch: schema.repos.branch,
      role: schema.agentRepos.role,
      description: schema.agentRepos.description,
      status: schema.repos.status,
    })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(
      and(
        eq(schema.agentRepos.agentId, agentId),
        eq(schema.repos.status, 'ready'),
      ),
    )

  const edgeRows = await db
    .select()
    .from(schema.repoEdges)
    .where(eq(schema.repoEdges.agentId, agentId))

  const enc = loadEncoding(modelId)

  // System prompt + composed skills body. We re-implement the same
  // composition `composeInstructions` does in build-agent so the count
  // matches what Mastra actually receives. Not extracted to a shared
  // helper because this is the only off-runtime caller and inlining
  // keeps the dependency direction clean (estimator → schema, not
  // estimator → buildAgent's helpers).
  const systemPromptText = (agentRow.systemPrompt ?? '').trim()
  const systemPromptTokens = tokenize(enc, systemPromptText)

  const skills: TokenEstimateSkill[] = skillRows
    .filter((s) => s.markdownBody.trim().length > 0)
    .map((s) => ({
      name: s.name,
      tokens: tokenize(enc, `## ${s.name}\n\n${s.markdownBody.trim()}`),
    }))
  const skillsTotal = skills.reduce((sum, s) => sum + s.tokens, 0)

  // Inspector toolkit's auto-appended system prompt
  // (`docs/ARCHITECTURE.md §10`). Fail-silent contract: a load failure
  // (missing .md in `dist/src/inspector/`) gives a null entry, which
  // the budget card surfaces as a config gap. The shared
  // `TokenEstimateSystemSkill` type is kept so the frontend's budget
  // card doesn't have to re-shape on this change.
  //
  // Build-your-own-agent (`inspectorEnabled === false`) skips the
  // attach in `composeInstructions`, so the budget should reflect zero
  // tokens for it — `null` here matches that.
  let systemSkill: TokenEstimateSystemSkill | null = null
  if (agentRow.inspectorEnabled) {
    try {
      const skillBody = await loadInspectorSystemPrompt()
      systemSkill = {
        name: 'Inspector toolkit',
        version: INSPECTOR_SYSTEM_PROMPT_VERSION,
        tokens: tokenize(enc, skillBody),
      }
    } catch {
      // Leave `systemSkill` null. The card flags this distinctly from
      // "0 tokens" to nudge the operator toward a rebuild.
    }
  }

  // Previously auto-attached blocks (gitnexus library skills,
  // attached-repos inventory, repo-edges) are gone from the prompt
  // under the wrapper-tool architecture. Repos + edges now travel
  // inside wrapper responses (`list_repos`, `assess_change_impact`)
  // where they're actionable; library skills are dead weight without
  // the direct gitnexus_* tool surface. Fields kept on the response
  // shape so the frontend's budget card doesn't have to re-shape;
  // values stay `null`/`0` permanently (unused in the new prompt).
  const gitnexusLibrarySkills: TokenEstimateGitnexusLibrarySkills | null = null
  const attachedReposHint = 0
  const repoEdgesHint = 0
  void edgeRows // computed above for future use; intentionally unused now

  // Tools — the inspector wrapper toolkit. Six tools registered per
  // agent (five when no repos are attached → only `list_repos`).
  // We don't have access to the wrappers' Zod input schemas here
  // without going through `mountInspectorTools`, so we approximate
  // with name + a one-line description + a 60-token wrapper overhead.
  // Slight undercount; the budget card flags this in the help text.
  //
  // Build-your-own-agent skips the toolkit entirely, so the budget
  // shows zero tool tokens for those agents.
  const tools: TokenEstimateTool[] = []
  if (agentRow.inspectorEnabled) {
    for (const name of inspectorWrapperNames) {
      if (name !== 'list_repos' && repoRows.length === 0) continue
      const description = describeInspectorWrapper(name)
      const text = JSON.stringify({ name, description })
      const tokens = tokenize(enc, text) + 60
      tools.push({ name, tokens, source: 'gitnexus' })
    }
  }

  const toolsTotal = tools.reduce((sum, t) => sum + t.tokens, 0)

  const baselineTotal =
    systemPromptTokens +
    skillsTotal +
    (systemSkill?.tokens ?? 0) +
    toolsTotal

  return {
    model: modelId,
    encoding: pickEncoding(modelId),
    modelContextLimit: lookupContextLimit(modelId),
    parts: {
      systemPrompt: systemPromptTokens,
      skills,
      skillsTotal,
      systemSkill,
      gitnexusLibrarySkills,
      attachedReposHint,
      repoEdgesHint,
      tools,
      toolsTotal,
    },
    baselineTotal,
  }
}
