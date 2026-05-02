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
  CODING_AGENT_SYSTEM_SKILL_VERSION,
  loadCodingAgentSystemSkill,
} from './coding-agent/system-skill.js'
import { loadGitnexusLibrarySkills } from './coding-agent/gitnexus-library-skills.js'
import { loadGitnexusToolDefinitions } from './system-tools.js'

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

  const enc = loadEncoding(agentRow.model)

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

  // Coding-agent system skill. auto-appended in `composeInstructions`
  // after the operator's skills. Same fail-silent contract as the
  // gitnexus tool list below: a load failure (missing .md in
  // `dist/src/coding-agent/`) gives 0 tokens and a null entry, which
  // the budget card surfaces as a config gap. Skipping the auto-attach
  // when an operator override is present is rare; we charge the full
  // body here regardless to keep the estimator deterministic.
  let systemSkill: TokenEstimateSystemSkill | null = null
  try {
    const skillBody = await loadCodingAgentSystemSkill()
    systemSkill = {
      name: 'Coding-agent toolkit guidance',
      version: CODING_AGENT_SYSTEM_SKILL_VERSION,
      tokens: tokenize(enc, skillBody),
    }
  } catch {
    // Leave `systemSkill` null. The card flags this distinctly from
    // "0 tokens" to nudge the operator toward a rebuild.
  }

  // GitNexus library skills. vendor-shipped from the npm package,
  // auto-appended in `composeInstructions`. Same fail-silent contract:
  // an empty list (loader couldn't resolve gitnexus) gives null;
  // a non-empty list contributes the concatenated bodies + the
  // section heading we render around them.
  let gitnexusLibrarySkills: TokenEstimateGitnexusLibrarySkills | null = null
  try {
    const lib = await loadGitnexusLibrarySkills()
    if (lib.skills.length > 0) {
      // Mirror the rendered shape from `renderGitnexusLibrarySkills`
      // so the count matches what the LLM will actually see.
      const bodies = lib.skills.map((s) => `### ${s.name}\n\n${s.body}`)
      const head =
        '## GitNexus library skills\n\n' +
        'The following skills are shipped inside the gitnexus npm package and ' +
        'auto-attached here. They are written by gitnexus\'s authors to teach ' +
        'an LLM how to call `gitnexus_*` tools effectively. Treat them as ' +
        'authoritative for tool-call shapes and recipes when answering ' +
        'questions that need code-graph evidence.'
      const block = [head, ...bodies].join('\n\n')
      gitnexusLibrarySkills = {
        version: lib.version,
        count: lib.skills.length,
        tokens: tokenize(enc, block),
      }
    }
  } catch {
    /* leave null. budget card surfaces "library skills unavailable" */
  }

  // Attached-repos hint mirrors `appendGitnexusRepoHint`. Only counts
  // when the agent has ≥1 ready repo (otherwise gitnexus doesn't
  // mount and the hint isn't appended).
  let attachedReposHint = 0
  if (repoRows.length > 0) {
    const lines = repoRows
      .map((r) => {
        const label = r.role?.trim() || r.remoteUrl
        const head = `- ${label}  (${r.remoteUrl}#${r.branch})`
        return r.description ? `${head} — ${r.description}` : head
      })
      .join('\n')
    const block = `## Attached repositories (${repoRows.length})\n\n${lines}`
    attachedReposHint = tokenize(enc, block)
  }

  // Repo edges hint mirrors `appendRepoEdges`. Only when ≥2 repos AND
  // ≥1 edge.
  let repoEdgesHint = 0
  if (repoRows.length >= 2 && edgeRows.length > 0) {
    const lines = edgeRows
      .map((e) => `- ${e.fromRepoId} ${e.connector} ${e.toRepoId}`)
      .join('\n')
    repoEdgesHint = tokenize(enc, `## Repo relationships\n\n${lines}`)
  }

  // Tools — gitnexus first (auto-mounted when ready repos exist).
  // Each tool's full JSON Schema (name + description + parameters)
  // ships on every call. We approximate by serializing the same
  // `{ name, description, parameters }` shape Mastra/AI SDK would
  // bake into the request body.
  const tools: TokenEstimateTool[] = []
  if (repoRows.length > 0) {
    try {
      const result = await loadGitnexusToolDefinitions()
      if (result.ok) {
        for (const t of result.tools) {
          // Approximate the JSON Schema overhead by stringifying the
          // tool definition. Real OpenAI requests wrap each tool in
          // `{type: 'function', function: { name, description,
          // parameters: {...} }}` — the parameters are the bulk; for
          // gitnexus tools we don't have the schema here, so we count
          // name + description and add a flat 60-token overhead for
          // the JSON Schema wrapper. This undercounts slightly; the
          // budget card flags this in the help text.
          const text = JSON.stringify({
            name: t.name,
            description: t.description,
          })
          const tokens = tokenize(enc, text) + 60
          tools.push({ name: t.name, tokens, source: 'gitnexus' })
        }
      }
    } catch {
      // gitnexus unreachable — skip silently. The budget card will
      // show 0 gitnexus tokens; it's more honest to undercount than
      // to throw and block the whole estimate.
    }
  }

  // Wiki tools. auto-mounted when at least one attached repo has
  // `wikiStatus='ready'`. Two tools with known descriptions; we
  // count them with the same name+description+wrapper formula
  // gitnexus uses above. Fail-silent if the count query throws -
  // same rationale as gitnexus.
  try {
    const wikiReady = await db
      .select({ id: schema.repos.id })
      .from(schema.agentRepos)
      .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
      .where(
        and(
          eq(schema.agentRepos.agentId, agentId),
          eq(schema.repos.wikiStatus, 'ready'),
        ),
      )
    if (wikiReady.length > 0) {
      const wikiToolDefs: Array<{ name: string; description: string }> = [
        {
          name: 'gitnexus_wiki_list_pages',
          description:
            'List the pages in a repo\'s pre-generated wiki. narrative summaries written by `gitnexus wiki`. Cheaper than fanning out 5+ graph queries when you need a high-level "how does X work" overview. Pass the repo\'s friendly label (role / alias / URL tail). Returns an ordered tree.',
        },
        {
          name: 'gitnexus_wiki_get_page',
          description:
            'Read one page of a repo\'s pre-generated wiki. Use AFTER `gitnexus_wiki_list_pages` told you which slug to fetch. Returns the markdown body. The wiki is a snapshot. verify any concrete file/line claim against `gitnexus_context` before quoting it.',
        },
      ]
      for (const t of wikiToolDefs) {
        const text = JSON.stringify({
          name: t.name,
          description: t.description,
        })
        const tokens = tokenize(enc, text) + 60
        tools.push({ name: t.name, tokens, source: 'gitnexus' })
      }
    }
  } catch {
    /* skip silently. same fail-open as gitnexus above */
  }

  const toolsTotal = tools.reduce((sum, t) => sum + t.tokens, 0)

  const baselineTotal =
    systemPromptTokens +
    skillsTotal +
    (systemSkill?.tokens ?? 0) +
    (gitnexusLibrarySkills?.tokens ?? 0) +
    attachedReposHint +
    repoEdgesHint +
    toolsTotal

  return {
    model: agentRow.model,
    encoding: pickEncoding(agentRow.model),
    modelContextLimit: lookupContextLimit(agentRow.model),
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
