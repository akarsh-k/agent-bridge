/**
 * Thin async wrappers around the gitnexus MCP tool dict
 * (`docs/ARCHITECTURE.md §10`).
 *
 * The wrapper-tool architecture keeps the gitnexus subprocess + its
 * `tools` dict alive, but the LLM never sees the `gitnexus_*` tools
 * directly. Instead our deterministic workflows call them through the
 * functions below. Each function:
 *
 *   - takes the live `tools` dict (from `mountGitnexusMcp(...)`),
 *   - calls the relevant tool's `execute(...)`,
 *   - parses gitnexus's response shape (text-wrapped JSON, structured
 *     content, or array — see `unwrap` below),
 *   - returns a typed value the workflow can reason about.
 *
 * Failure mode: throw with a descriptive message. The workflow is
 * responsible for catching and degrading. these are infrastructure-level
 * helpers, not user-facing code.
 *
 * Idempotent on the gitnexus side — every supported call (`query`,
 * `context`, `impact`, `cypher`, `detect_changes`) is read-only.
 */

import type { Tool } from '@mastra/core/tools'

// ─── Types the callers return ────────────────────────────────────────────

/**
 * One hit from `gitnexus_query`. Gitnexus returns this as
 * "process-grouped hybrid search (BM25 + semantic + RRF)" so each entry
 * has a fused score; we surface only what the workflow needs to pick
 * the next call (path + line + reason).
 */
export interface GitnexusQueryHit {
  readonly repo: string
  readonly path: string
  readonly line: number | null
  readonly symbol: string | null
  readonly score: number
  readonly snippet: string | null
  readonly reason: string
}

/**
 * One graph neighbour returned by `gitnexus_context` under
 * `incoming.{calls,imports,...}` or `outgoing.{...}`. Gitnexus's actual
 * keys vary by node kind (calls / imports / inherits / references / …)
 * so we model them as a flat keyed map.
 */
export interface GitnexusContextEdge {
  readonly uid: string
  readonly name: string
  readonly filePath: string
}

export interface GitnexusContextSymbol {
  readonly uid: string
  readonly name: string
  /** "Function", "Interface", "Class", "Method", "File", … (gitnexus node kind). */
  readonly kind: string
  readonly filePath: string
  readonly startLine: number | null
  readonly endLine: number | null
}

/**
 * Graph context for one symbol. Note: gitnexus_context returns symbol
 * METADATA + EDGES, not file content. To get the symbol's body, slice
 * the source file from disk using `symbol.filePath` + `startLine`/
 * `endLine`. See `read-source.ts:readFileChunkFromDisk`.
 */
export interface GitnexusContextResult {
  readonly repo: string
  readonly status: string
  readonly symbol: GitnexusContextSymbol
  readonly incoming: Record<string, readonly GitnexusContextEdge[]>
  readonly outgoing: Record<string, readonly GitnexusContextEdge[]>
}

export interface GitnexusImpactRow {
  readonly repo: string
  readonly path: string
  readonly direction: 'upstream' | 'downstream'
  readonly depth: number
  readonly confidence: 'high' | 'medium' | 'low' | null
  readonly reason: string
}

// ─── Public surface ──────────────────────────────────────────────────────

export type ToolDict = Record<string, Tool<any, any, any, any>>

export interface CallGitnexusInput {
  readonly tools: ToolDict
  /** Canonical gitnexus registry name — pre-resolved by the caller. */
  readonly repo?: string
}

export interface QueryInput extends CallGitnexusInput {
  readonly query: string
  /** Cap on results returned by gitnexus. Default 20, max 100. */
  readonly limit?: number
}

/**
 * `callGitnexusQuery` returns hits AND any top-level diagnostic the
 * server included. Today the only one in the wild is `warning` —
 * emitted when gitnexus's BM25 (FTS) arm is unavailable on the
 * read-only MCP DB connection (see `core/search/hybrid-search.js`,
 * gitnexus issue #1403). Routing it through to the caller lets the
 * wrapper surface "embedder/FTS misconfigured → recall is degraded"
 * as a visible diagnostic instead of an unexplained empty result.
 */
export interface GitnexusQueryResponse {
  readonly hits: readonly GitnexusQueryHit[]
  /** Server-side warning text, or `null` when none. */
  readonly warning: string | null
}

export async function callGitnexusQuery(
  input: QueryInput,
): Promise<GitnexusQueryResponse> {
  const { tools, query, repo, limit = 20 } = input
  const tool = tools['gitnexus_query']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_query tool is not mounted')
  }
  const args: Record<string, unknown> = { query, limit }
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseQueryResponse(raw)
}

export interface ContextInput extends CallGitnexusInput {
  /**
   * Symbol name to anchor the context on (function, class, interface,
   * method). Either `name` or `uid` is required — gitnexus_context
   * is symbol-anchored, NOT file-anchored. To get a file body, slice
   * the source from disk; this caller surfaces the graph relationships
   * around the symbol, not the bytes of the file it lives in.
   */
  readonly name?: string
  /**
   * Fully-qualified node id like
   * `Function:app/routes/products.py:list_products`. Use this when
   * `name` would be ambiguous (e.g. multiple `Product` symbols across
   * kinds). Either `name` or `uid` must be provided.
   */
  readonly uid?: string
}

export async function callGitnexusContext(
  input: ContextInput,
): Promise<GitnexusContextResult | null> {
  const { tools, name, uid, repo } = input
  if (!name && !uid) {
    throw new Error(
      '[gitnexus-callers] callGitnexusContext requires `name` or `uid`',
    )
  }
  const tool = tools['gitnexus_context']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_context tool is not mounted')
  }
  const args: Record<string, unknown> = {}
  if (name) args['name'] = name
  if (uid) args['uid'] = uid
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseContextResult(raw, repo ?? '')
}

export interface ImpactInput extends CallGitnexusInput {
  /**
   * Symbol name (function, class, interface, method) to assess.
   *
   * Gitnexus 1.6.3's `impact` tool is symbol-anchored: passing a file
   * path returns `Target '<path>' not found`. To go from a path to a
   * symbol, query first (`callGitnexusQuery({query: '<path>', limit: 5})`)
   * and forward the matched hit's `symbol` field as `target`. A
   * dedicated `callGitnexusImpactByPath(...)` shim is on the TODO list
   * once we want this dance in more than one wrapper.
   */
  readonly target: string
  readonly direction: 'upstream' | 'downstream'
  readonly depth?: number
}

export async function callGitnexusImpact(
  input: ImpactInput,
): Promise<GitnexusImpactRow[]> {
  const { tools, target, direction, depth = 2, repo } = input
  const tool = tools['gitnexus_impact']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_impact tool is not mounted')
  }
  const args: Record<string, unknown> = { target, direction, depth }
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseImpactRows(raw, direction)
}

// ─── Envelope unwrap ─────────────────────────────────────────────────────

/**
 * Gitnexus's MCP server emits results in a few shapes depending on tool
 * + version. Recognised inputs (in order of preference):
 *
 *   1. Already-parsed object/array (Mastra's MCP wrapper sometimes
 *      hands us `structuredContent` directly).
 *   2. `{ content: [{ type: 'text', text: '<json>' }] }` — the canonical
 *      MCP `CallToolResult`. We strip gitnexus's optional next-step
 *      hint (`\n\n---\n**Next:** …` divider) and parse the prefix.
 *   3. Raw string. JSON-parse it directly.
 *
 * Returns `null` when nothing parseable was found. Workflows treat
 * `null` as "no results" (legitimate empty case), not as an error.
 *
 * Mirrors the unwrap logic in `mcp/gitnexus-mcp.ts:parseTextPayload`
 * but generalised to any shape gitnexus might emit, not just lists.
 */
export function unwrap(raw: unknown): unknown | null {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'string') return tryJson(raw)
  if (Array.isArray(raw)) return raw

  if (typeof raw !== 'object') return null

  const obj = raw as Record<string, unknown>

  // Mastra-style structuredContent passthrough.
  if (obj['structuredContent'] !== undefined) {
    const sc = obj['structuredContent']
    return typeof sc === 'string' ? tryJson(sc) : sc
  }

  // MCP CallToolResult.
  if (Array.isArray(obj['content'])) {
    for (const part of obj['content'] as unknown[]) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p['type'] === 'text' && typeof p['text'] === 'string') {
        const parsed = tryJson(p['text'] as string)
        if (parsed !== null) return parsed
      }
    }
    return null
  }

  // Direct object passthrough.
  return obj
}

function tryJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // Strategy 1: strip gitnexus's next-step divider.
  const dividerIdx = trimmed.indexOf('\n\n---\n')
  const candidates: string[] = []
  if (dividerIdx >= 0) candidates.push(trimmed.slice(0, dividerIdx).trim())
  candidates.push(trimmed)

  // Strategy 2: last balanced bracket (defensive against suffix changes).
  const lastBracket = Math.max(
    trimmed.lastIndexOf(']'),
    trimmed.lastIndexOf('}'),
  )
  if (lastBracket >= 0 && lastBracket < trimmed.length - 1) {
    candidates.push(trimmed.slice(0, lastBracket + 1))
  }

  for (const c of candidates) {
    if (c.length === 0) continue
    try {
      return JSON.parse(c) as unknown
    } catch {
      /* try next */
    }
  }
  return null
}

// ─── Parsers ─────────────────────────────────────────────────────────────

/**
 * Parse gitnexus 1.6.3's process-grouped `query` response.
 *
 * Actual shape (from gitnexus's local-backend.js):
 *
 *   {
 *     processes:        [ { id, summary, priority, symbol_count, … } ],
 *     process_symbols:  [ { id, name, type, filePath, startLine, endLine,
 *                           module?, content?, process_id, step_index } ],
 *     definitions:      [ { id, name, type, filePath, startLine, endLine,
 *                           module?, content? } ],
 *     timing:           { … },
 *     warning?:         'FTS extension unavailable - keyword search degraded.
 *                        Run: gitnexus analyze --force to rebuild indexes.'
 *   }
 *
 * We mine `process_symbols` + `definitions` for hits; both carry the
 * file path, line range, and symbol name we need. Process metadata
 * (`processes[]`) is summary-only, no file paths — useful for grouping
 * but not for our flat hit list.
 *
 * Older / pre-1.6.3 shapes (`{results}` / `{items}` / bare arrays /
 * `{groups: [{items}]}`) stay supported as fallbacks so a future
 * gitnexus revert doesn't break us. Dedupe by `(filePath, name)` so a
 * symbol that appears in multiple processes isn't double-counted.
 *
 * If the response carries a top-level `warning` (gitnexus's hint about
 * a degraded FTS index), we return it on the response envelope so the
 * caller can route it into the wrapper's `warnings[]` and the operator
 * sees actionable diagnosis instead of an unexplained empty result.
 */
function parseQueryResponse(raw: unknown): GitnexusQueryResponse {
  const data = unwrap(raw)
  if (!data || typeof data !== 'object') {
    if (Array.isArray(data)) {
      return { hits: parseLegacyArray(data), warning: null }
    }
    return { hits: [], warning: null }
  }
  const top = data as Record<string, unknown>
  const warning =
    typeof top['warning'] === 'string' && top['warning'].length > 0
      ? top['warning']
      : null

  // gitnexus 1.6.3 process-grouped shape.
  const processSymbols = Array.isArray(top['process_symbols'])
    ? (top['process_symbols'] as unknown[])
    : []
  const definitions = Array.isArray(top['definitions'])
    ? (top['definitions'] as unknown[])
    : []

  // Build a process-id → priority map so symbols inside high-priority
  // processes get a higher score.
  const processPriority = new Map<string, number>()
  if (Array.isArray(top['processes'])) {
    for (const p of top['processes'] as unknown[]) {
      if (!p || typeof p !== 'object') continue
      const o = p as Record<string, unknown>
      const id = typeof o['id'] === 'string' ? o['id'] : null
      const pri = typeof o['priority'] === 'number' ? o['priority'] : 0
      if (id) processPriority.set(id, pri)
    }
  }

  const out: GitnexusQueryHit[] = []
  const seen = new Set<string>()
  const pushSymbol = (item: unknown, defaultReason: string): void => {
    if (!item || typeof item !== 'object') return
    const o = item as Record<string, unknown>
    const path = readString(o, ['filePath', 'path', 'file'])
    if (!path) return
    const symbol = readString(o, ['name', 'symbol', 'symbolName'])
    const dedupeKey = `${path}::${symbol ?? ''}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    const pid = readString(o, ['process_id'])
    const score = pid != null ? (processPriority.get(pid) ?? 0) : 0
    out.push({
      repo: readString(o, ['repo', 'repository']) ?? '',
      path,
      line: readNumber(o, ['startLine', 'line', 'lineNumber']),
      symbol,
      score,
      snippet: readString(o, ['content', 'snippet', 'preview', 'text']),
      reason:
        readString(o, ['reason', 'why', 'matchType']) ??
        readString(o, ['type']) ??
        defaultReason,
    })
  }
  for (const item of processSymbols) pushSymbol(item, 'process flow symbol')
  for (const item of definitions) pushSymbol(item, 'standalone definition')

  // Sort by score desc so caller's top-N slicing surfaces the most
  // important matches first.
  out.sort((a, b) => b.score - a.score)

  // Fallback: pre-1.6.3 / future shapes. Try `{results}` / `{items}` /
  // `{groups: [{items}]}` paths if we got nothing from the canonical shape.
  if (out.length === 0) {
    const legacy = collectLegacyItems(top)
    for (const item of legacy) pushSymbol(item, 'legacy hit')
  }

  return { hits: out, warning }
}

function parseLegacyArray(items: readonly unknown[]): GitnexusQueryHit[] {
  const out: GitnexusQueryHit[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const path = readString(o, ['path', 'filePath', 'file'])
    if (!path) continue
    out.push({
      repo: readString(o, ['repo', 'repository']) ?? '',
      path,
      line: readNumber(o, ['line', 'startLine', 'lineNumber']),
      symbol: readString(o, ['symbol', 'name', 'symbolName']),
      score: readNumber(o, ['score', 'rrf', 'rank']) ?? 0,
      snippet: readString(o, ['snippet', 'preview', 'text']),
      reason:
        readString(o, ['reason', 'why', 'matchType']) ?? 'gitnexus_query hit',
    })
  }
  return out
}

function collectLegacyItems(top: Record<string, unknown>): unknown[] {
  const out: unknown[] = []
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      out.push(...v)
      return
    }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (Array.isArray(o['results'])) collect(o['results'])
    if (Array.isArray(o['items'])) collect(o['items'])
    if (Array.isArray(o['hits'])) collect(o['hits'])
    if (Array.isArray(o['groups'])) {
      for (const g of o['groups'] as unknown[]) collect(g)
    }
  }
  collect(top)
  return out
}

function parseContextResult(
  raw: unknown,
  repo: string,
): GitnexusContextResult | null {
  const data = unwrap(raw)
  if (!data || typeof data !== 'object') return null

  // gitnexus_context returns `{ status, symbol: {...}, incoming: {...},
  // outgoing: {...}, processes: [...] }`. An error response carries an
  // `error` field instead — we surface that as null so callers degrade.
  const candidates: Array<Record<string, unknown>> = []
  const collect = (v: unknown): void => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return
    const o = v as Record<string, unknown>
    candidates.push(o)
    if (o['result']) collect(o['result'])
    if (o['context']) collect(o['context'])
    if (o['data']) collect(o['data'])
  }
  collect(data)

  for (const o of candidates) {
    if (typeof o['error'] === 'string') return null
    const symbolRaw = o['symbol']
    if (!symbolRaw || typeof symbolRaw !== 'object') continue
    const sym = symbolRaw as Record<string, unknown>
    const uid = readString(sym, ['uid', 'id'])
    const name = readString(sym, ['name'])
    const kind = readString(sym, ['kind', 'type'])
    const filePath = readString(sym, ['filePath', 'path'])
    if (!uid || !name || !kind || !filePath) continue
    return {
      repo: readString(o, ['repo', 'repository']) ?? repo,
      status: readString(o, ['status']) ?? 'found',
      symbol: {
        uid,
        name,
        kind,
        filePath,
        startLine: readNumber(sym, ['startLine', 'start', 'lineStart']),
        endLine: readNumber(sym, ['endLine', 'end', 'lineEnd']),
      },
      incoming: parseEdgeMap(o['incoming']),
      outgoing: parseEdgeMap(o['outgoing']),
    }
  }
  return null
}

function parseEdgeMap(raw: unknown): Record<string, readonly GitnexusContextEdge[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, readonly GitnexusContextEdge[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const edges: GitnexusContextEdge[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const uid = readString(o, ['uid', 'id'])
      const name = readString(o, ['name'])
      const filePath = readString(o, ['filePath', 'path'])
      if (uid && name && filePath) edges.push({ uid, name, filePath })
    }
    if (edges.length > 0) out[key] = edges
  }
  return out
}

function parseImpactRows(
  raw: unknown,
  direction: 'upstream' | 'downstream',
): GitnexusImpactRow[] {
  const data = unwrap(raw)
  if (!data) return []

  const items: unknown[] = []
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      items.push(...v)
      return
    }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (Array.isArray(o['items'])) collect(o['items'])
    if (Array.isArray(o['results'])) collect(o['results'])
    if (Array.isArray(o['impact'])) collect(o['impact'])
    if (Array.isArray(o['rows'])) collect(o['rows'])
  }
  collect(data)

  const out: GitnexusImpactRow[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const path = readString(o, ['path', 'filePath', 'file'])
    if (!path) continue
    out.push({
      repo: readString(o, ['repo', 'repository']) ?? '',
      path,
      direction:
        (readString(o, ['direction']) === 'upstream' ||
        readString(o, ['direction']) === 'downstream'
          ? (readString(o, ['direction']) as 'upstream' | 'downstream')
          : direction),
      depth: readNumber(o, ['depth']) ?? 0,
      confidence:
        (readString(o, ['confidence']) as
          | 'high'
          | 'medium'
          | 'low'
          | null) ?? null,
      reason: readString(o, ['reason', 'why']) ?? 'gitnexus_impact hit',
    })
  }
  return out
}

// ─── Field readers ───────────────────────────────────────────────────────

function readString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function readNumber(
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}
