/**
 * Term expansion + intent classification (`docs/ARCHITECTURE.md §10` Phase C).
 *
 * One small LLM call per wrapper invocation. Takes the user's free-form
 * query, returns:
 *
 *   - `intent`: best-guess high-level shape (`find` / `trace` / `impact`
 *     / `debug` / `understand`). Today only `find_in_codebase` consumes
 *     this; Phase E wrappers will use it to gate their behaviour.
 *   - `expansions`: codebase-specific synonyms / variants. "translation"
 *     → `["translation", "i18n", "locale", "intl", "t()"]`. The wrapper
 *     fans out one `gitnexus_query` per expansion and unions the hits.
 *   - `anchors`: file-paths or symbol names the LLM thinks the answer
 *     anchors on. Phase B doesn't consume these yet; held for Phase E
 *     when `trace_flow` / `understand_module` need a starting point.
 *
 * Hard fallback (D5): any failure → `{ intent: 'find', expansions: [query], anchors: [] }`.
 * The wrapper tool continues with raw query as the only term. The run
 * never dies because of an expansion miss.
 *
 * The LLM call uses a tools-less sibling `Agent` so we can re-use the
 * agent's existing `MastraModelConfig` (same provider, same key, same
 * base URL) without paying for a second provider key. The sibling has
 * no tools and no memory so it can't recurse into the inspector or
 * carry chat history into the expansion call.
 *
 * Output format is intentionally **prose with flat keys** (`§5.5`,
 * lesson_learned 5.5). Models emit prose reliably; structured output
 * across providers drifts. We parse leniently — the regex tolerates
 * extra commentary, blank lines, and the model wrapping in code fences.
 */

import { Agent } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'

import type { InspectorIntent } from './types.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface ClassifyAndExpandInput {
  /** User query forwarded by the wrapper-tool input. */
  readonly query: string
  /** The agent's model config. shared with the main wrapper agent. */
  readonly modelConfig: MastraModelConfig
  /**
   * Hint for the LLM — tells it which languages the attached repos
   * use so expansions land in the right vocabulary (Python tests use
   * `pytest`, JS uses `jest`, etc.). Empty array is fine.
   */
  readonly languages?: readonly string[]
}

export interface ClassifyAndExpandResult {
  readonly intent: InspectorIntent
  readonly expansions: readonly string[]
  readonly anchors: readonly string[]
  /** `true` when the LLM call failed or output was unparsable. */
  readonly fallback: boolean
  readonly fallbackReason?: string
  /** Wall-clock duration of the LLM call. `null` on fallback before any call ran. */
  readonly durationMs: number | null
  /** Truncated response preview for telemetry. May be empty on full failure. */
  readonly responsePreview: string
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Process-level cache of "expander" Mastra Agents, keyed by the model
 * config triple `${providerId}::${modelId}::${url}`. Reuse keeps the
 * sibling Agent warm across calls so we don't reconstruct a fresh
 * Mastra runtime on every wrapper invocation.
 */
const expanderCache = new Map<string, Agent>()

/**
 * Cache key for the sibling Agent. `MastraModelConfig` is a wide union
 * (`OpenAICompatibleConfig | LanguageModelV*` etc.) — buildAgent always
 * passes the `{providerId, modelId, url}` variant of OpenAICompatible,
 * but we widen pragmatically: read whatever string-y fields exist so a
 * future change to use the `id: 'provider/model'` variant or a raw
 * `LanguageModelV2` doesn't break the cache. Cache misses are cheap
 * (one Mastra Agent construct), so a slightly looser key is fine.
 */
function expanderCacheKey(model: MastraModelConfig): string {
  if (typeof model === 'object' && model !== null) {
    const m = model as Record<string, unknown>
    const providerId =
      typeof m['providerId'] === 'string' ? m['providerId'] : ''
    const modelId = typeof m['modelId'] === 'string' ? m['modelId'] : ''
    const id = typeof m['id'] === 'string' ? m['id'] : ''
    const url = typeof m['url'] === 'string' ? m['url'] : ''
    return `oai::${providerId}::${modelId}::${id}::${url}`
  }
  return `model-instance::${typeof model}`
}

function getExpanderAgent(model: MastraModelConfig): Agent {
  const key = expanderCacheKey(model)
  const cached = expanderCache.get(key)
  if (cached) return cached
  // Tools-less, memoryless sibling. Empty system prompt — we hand the
  // full instructions on the prompt itself so a future model swap
  // doesn't fight a stale system message.
  const agent = new Agent({
    id: `inspector-expand:${key}`,
    name: 'inspector-expand',
    description:
      'Term expansion + intent classification helper for Agent Bridge inspector wrappers.',
    instructions: '',
    model,
  })
  expanderCache.set(key, agent)
  return agent
}

const EXPAND_PROMPT_TEMPLATE = `You help an automated code-search agent disambiguate developer questions about a codebase.

Given a user query, output two pieces of information in plain prose:

1. \`intent\`: one of these labels (lowercase, no punctuation):
   - \`find\`: the user wants to locate code (where is X? show me Y)
   - \`trace\`: the user wants to follow execution (how does X reach Y?)
   - \`impact\`: the user wants blast-radius analysis (what breaks if X changes?)
   - \`debug\`: the user is investigating a bug (why is X failing?)
   - \`understand\`: the user wants a higher-level explanation (what does X do?)

2. \`expansions\`: a comma-separated list of 2-8 alternative names a developer might use for the same concept. Lean toward variants that would actually appear in code — function names, file conventions, library identifiers. Include the user's original wording first. Examples:
   - "translation" -> translation, i18n, internationalization, locale, intl, t(), i18next, lingui
   - "auth middleware" -> auth middleware, authentication, authMiddleware, requireAuth, session, jwt
   - "cart total" -> cart total, totalAmount, getTotal, computeTotal, cartTotal, subtotal

3. \`anchors\`: a comma-separated list of 0-3 specific file paths or symbol names the answer probably hinges on, only when the user named or strongly implied them. Empty when nothing specific was mentioned.

Output exactly three lines, in this format, no other text:
intent: <label>
expansions: <comma-separated list>
anchors: <comma-separated list, or empty>

User query: {{query}}{{languagesHint}}`

export async function classifyAndExpand(
  input: ClassifyAndExpandInput,
): Promise<ClassifyAndExpandResult> {
  const { query, modelConfig, languages } = input

  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return {
      intent: 'find',
      expansions: [],
      anchors: [],
      fallback: true,
      fallbackReason: 'empty query',
      durationMs: null,
      responsePreview: '',
    }
  }

  const languagesHint =
    languages && languages.length > 0
      ? `\n\nAttached repos use: ${languages.join(', ')}. Lean expansions toward this vocabulary.`
      : ''

  const prompt = EXPAND_PROMPT_TEMPLATE.replace('{{query}}', trimmed).replace(
    '{{languagesHint}}',
    languagesHint,
  )

  const startedAt = Date.now()
  let text = ''
  try {
    const agent = getExpanderAgent(modelConfig)
    // No `maxOutputTokens` plumbed here — Mastra 1.28's
    // `AgentGenerateOptions` doesn't accept it as a top-level field, and
    // per-provider knobs (`providerOptions.openai.max_tokens`) would
    // make this code provider-specific. The prompt explicitly asks for
    // three short lines, so the model self-bounds at ~150 tokens.
    const result = await agent.generate(prompt, {})
    text = (result.text ?? '').trim()
  } catch (err) {
    return {
      intent: 'find',
      expansions: [trimmed],
      anchors: [],
      fallback: true,
      fallbackReason:
        err instanceof Error ? err.message : 'expand LLM call failed',
      durationMs: Date.now() - startedAt,
      responsePreview: '',
    }
  }
  const durationMs = Date.now() - startedAt

  const parsed = parseExpandOutput(text)
  if (!parsed) {
    return {
      intent: 'find',
      expansions: [trimmed],
      anchors: [],
      fallback: true,
      fallbackReason: 'unparsable output',
      durationMs,
      responsePreview: text.slice(0, 512),
    }
  }

  // Always include the raw query as the first expansion so gitnexus has a
  // shot at the literal phrasing even if the LLM dropped it.
  const expansions = unique([trimmed, ...parsed.expansions])

  return {
    intent: parsed.intent,
    expansions,
    anchors: parsed.anchors,
    fallback: false,
    durationMs,
    responsePreview: text.slice(0, 512),
  }
}

// ─── Parser ──────────────────────────────────────────────────────────────

interface ParsedExpand {
  intent: InspectorIntent
  expansions: string[]
  anchors: string[]
}

const VALID_INTENTS: ReadonlySet<InspectorIntent> = new Set<InspectorIntent>([
  'find',
  'trace',
  'impact',
  'debug',
  'understand',
])

/**
 * Lenient prose parser. Looks for `intent: <label>` and `expansions: <list>`
 * lines anywhere in the output, case-insensitive, tolerating extra
 * markdown / commentary. Returns `null` only when neither field is found.
 */
function parseExpandOutput(text: string): ParsedExpand | null {
  if (text.length === 0) return null

  // Strip code fences if the model wrapped the output in ```.
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')

  const intentMatch = stripped.match(/intent\s*[:=]\s*(\w+)/i)
  const expansionsMatch = stripped.match(/expansions?\s*[:=]\s*(.+)/i)
  const anchorsMatch = stripped.match(/anchors?\s*[:=]\s*(.*)/i)

  if (!intentMatch && !expansionsMatch) return null

  const intentRaw = intentMatch?.[1]?.trim().toLowerCase() ?? 'find'
  const intent: InspectorIntent = VALID_INTENTS.has(
    intentRaw as InspectorIntent,
  )
    ? (intentRaw as InspectorIntent)
    : 'find'

  const expansions = splitList(expansionsMatch?.[1] ?? '')
  const anchors = splitList(anchorsMatch?.[1] ?? '')

  return { intent, expansions, anchors }
}

/**
 * Comma-separated list parser. Tolerates extra whitespace, trailing
 * commentary on its own line, and quoted entries. Caps results at 12
 * to keep wrapper-tool fan-out bounded.
 */
function splitList(raw: string): string[] {
  const firstLine = raw.split('\n')[0] ?? ''
  const cleaned = firstLine
    .replace(/^[\s\[\(]+|[\s\]\)]+$/g, '') // strip enclosing brackets
    .trim()
  if (cleaned.length === 0) return []
  const parts = cleaned
    .split(/[,;]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter((s) => s.length > 0 && s.length <= 80)
  return parts.slice(0, 12)
}

function unique(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Test-only hook for clearing the expander cache between integration tests
 * (so a swapped model config really does produce a new agent). Not part
 * of the production surface; lives here for proximity rather than in a
 * separate test-utils module.
 */
export function _clearExpanderCacheForTests(): void {
  expanderCache.clear()
}
