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
  /**
   * Gitnexus node kind for this hit: `'Function'`, `'Class'`,
   * `'Method'`, `'File'`, `'Route'`, `'Process'`, etc. Lets wrappers
   * dispatch on semantic type — e.g. `find_in_codebase` watches for
   * `'Route'` hits and chases them with `gitnexus_route_map` for
   * middleware + consumer enrichment, regardless of how the user
   * phrased the query ("POST /api/x" vs "the checkout endpoint"
   * both surface Route nodes when gitnexus indexed them). `null` on
   * synthesized hits (keyword-search, route_map handler projections)
   * and on legacy response shapes that didn't include a type field.
   */
  readonly type: string | null
  /**
   * Auto-detected business flow this hit participates in (gitnexus's
   * `Process` nodes — "UserLogin", "Checkout"). `null` when the hit
   * lives in `definitions[]` (no process membership) or when gitnexus
   * has not clustered the repo into processes at index time. Repos
   * without clear entry points (libraries, utilities) typically have
   * no processes detected, so this stays null. Resolved by joining
   * `process_symbols[].process_id` to `processes[].summary` in
   * `parseQueryResponse`.
   *
   * Gitnexus dedupes each symbol to ONE process (`local-backend.js:805`),
   * preferring the highest-priority assignment when a symbol
   * participates in multiple flows. We surface only that winning
   * assignment, not the full membership list.
   */
  readonly processLabel: string | null
  /**
   * Process category ('http_route', 'background_job', etc.) when
   * `processLabel` is set. Lets the IDE/LLM distinguish "this is a
   * web endpoint's flow" from "this is a job's flow." `null` mirrors
   * `processLabel`.
   */
  readonly processType: string | null
  /**
   * Position of this symbol in the process flow (1-indexed). `null`
   * when there's no process. Useful for narrative ("step 2 in the
   * Login flow"). Note: gitnexus's spread loses this if its symbol
   * record doesn't include it; we read defensively.
   */
  readonly stepIndex: number | null
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
  /**
   * Edge type that brought us to this symbol on the last hop (CALLS,
   * IMPORTS, EXTENDS, IMPLEMENTS, USES, METHOD_OVERRIDES, etc.). Lets
   * downstream wrappers + the IDE distinguish runtime breakage (CALLS)
   * from compile-time / type-only dependencies (IMPORTS, EXTENDS).
   * `null` when gitnexus's older response shape did not include it.
   */
  readonly relationType: string | null
}

/**
 * Rich return shape for `gitnexus_impact`. Was historically just
 * `GitnexusImpactRow[]`; we widened it to surface the envelope metadata
 * gitnexus emits alongside the rows. The metadata is what lets the IDE
 * answer "is this a high-risk change?" and "did the analysis even
 * finish?" without reinventing the heuristic ourselves.
 */
export interface GitnexusImpactResult {
  readonly rows: readonly GitnexusImpactRow[]
  /**
   * Gitnexus's overall verdict: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.
   * Computed from direct-consumer count + affected processes/modules.
   * `null` when gitnexus did not surface a risk score (older versions
   * or error paths). When set, prefer this over our flat depth-based
   * direct/transitive classification — gitnexus's heuristic also
   * accounts for process / module spread.
   */
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null
  /**
   * `true` when gitnexus's BFS bailed mid-walk (query error, etc.).
   * Critical safety signal: the result is incomplete and the IDE
   * should warn before acting. Without this flag, partial results
   * read like complete results.
   */
  readonly partial: boolean
  /**
   * Process names (auto-detected business flows) the change ripples
   * into. Lets a remediation suggestion read "Login + Checkout
   * affected" instead of "23 symbols."
   */
  readonly affectedProcesses: readonly string[]
  /**
   * Module-level rollup gitnexus computes alongside the symbol-level
   * impact. Useful for cross-team change reviews.
   */
  readonly affectedModules: readonly {
    readonly name: string
    readonly hits: number
    readonly impact: 'direct' | 'indirect'
  }[]
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
): Promise<GitnexusImpactResult> {
  const { tools, target, direction, depth = 2, repo } = input
  const tool = tools['gitnexus_impact']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_impact tool is not mounted')
  }
  const args: Record<string, unknown> = { target, direction, depth }
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseImpact(raw, direction)
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

  // Build a process-id → { priority, label, type } map. Priority drives
  // score sorting (high-priority processes' symbols rank above
  // standalone definitions). Label and type are surfaced PER HIT so
  // downstream wrappers can annotate the file's `why` with the flow
  // membership ("...; in Login flow"). Repos without entry points
  // (libraries) produce an empty processes[] and every hit comes back
  // with null label/type.
  const processPriority = new Map<string, number>()
  const processInfo = new Map<
    string,
    { label: string | null; type: string | null }
  >()
  if (Array.isArray(top['processes'])) {
    for (const p of top['processes'] as unknown[]) {
      if (!p || typeof p !== 'object') continue
      const o = p as Record<string, unknown>
      const id = typeof o['id'] === 'string' ? o['id'] : null
      const pri = typeof o['priority'] === 'number' ? o['priority'] : 0
      if (id) {
        processPriority.set(id, pri)
        // `summary` is gitnexus's human-readable flow name; falls back
        // to `heuristicLabel` / `label` for older response shapes.
        const label = readString(o, ['summary', 'heuristicLabel', 'label'])
        const type = readString(o, ['process_type', 'processType', 'type'])
        processInfo.set(id, { label, type })
      }
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
    const procInfo = pid != null ? processInfo.get(pid) : undefined
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
      // Gitnexus's node kind. The wrapper layer dispatches on this:
      // `Route` hits trigger a route_map enrichment pass, `Process`
      // hits could trigger flow expansion, etc.
      type: readString(o, ['type', 'kind']),
      processLabel: procInfo?.label ?? null,
      processType: procInfo?.type ?? null,
      stepIndex: readNumber(o, ['step_index', 'stepIndex']),
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
      // Legacy shapes may or may not include `type`; probe defensively.
      type: readString(o, ['type', 'kind']),
      // Legacy shapes don't carry process clustering — gitnexus only
      // started emitting `processes[]` in 1.6.3. Stay null for pre-1.6.3
      // responses; consumers handle null cleanly.
      processLabel: null,
      processType: null,
      stepIndex: null,
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

function parseEdgeMap(
  raw: unknown,
): Record<string, readonly GitnexusContextEdge[]> {
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

function parseImpact(
  raw: unknown,
  direction: 'upstream' | 'downstream',
): GitnexusImpactResult {
  const data = unwrap(raw)
  if (!data || typeof data !== 'object') {
    return {
      rows: [],
      risk: null,
      partial: false,
      affectedProcesses: [],
      affectedModules: [],
    }
  }
  const top = data as Record<string, unknown>

  // The impacted symbol rows live under one of several keys depending
  // on gitnexus version: `byDepth` (current, keyed by depth number),
  // `items`/`results`/`impact`/`rows` (legacy flat arrays). We
  // accept all, normalizing into one flat list per row's own depth.
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
  // `byDepth` is `{ "1": [...], "2": [...], ... }` — iterate values.
  const byDepth = top['byDepth']
  if (byDepth && typeof byDepth === 'object' && !Array.isArray(byDepth)) {
    for (const v of Object.values(byDepth as Record<string, unknown>)) {
      if (Array.isArray(v)) items.push(...v)
    }
  }
  collect(top)

  const rows: GitnexusImpactRow[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const path = readString(o, ['filePath', 'path', 'file'])
    if (!path) continue
    const dirRaw = readString(o, ['direction'])
    const rowDirection: 'upstream' | 'downstream' =
      dirRaw === 'upstream' || dirRaw === 'downstream' ? dirRaw : direction
    const confRaw = readString(o, ['confidence'])
    const confidence: 'high' | 'medium' | 'low' | null =
      confRaw === 'high' || confRaw === 'medium' || confRaw === 'low'
        ? confRaw
        : null
    rows.push({
      repo: readString(o, ['repo', 'repository']) ?? '',
      path,
      direction: rowDirection,
      depth: readNumber(o, ['depth']) ?? 0,
      confidence,
      reason:
        readString(o, ['reason', 'why', 'relationType']) ??
        'gitnexus_impact hit',
      relationType: readString(o, [
        'relationType',
        'relation_type',
        'edgeType',
      ]),
    })
  }

  // Envelope metadata. `risk` is gitnexus's heuristic verdict; we keep
  // it as-is. `partial` is the truncation safety signal. The process /
  // module name lists are projection-friendly: just the names, no
  // structural detail (the IDE can ask for more on a follow-up call).
  const riskRaw = readString(top, ['risk'])
  const risk: GitnexusImpactResult['risk'] =
    riskRaw === 'LOW' ||
    riskRaw === 'MEDIUM' ||
    riskRaw === 'HIGH' ||
    riskRaw === 'CRITICAL'
      ? riskRaw
      : null
  const partial = top['partial'] === true

  const affectedProcesses: string[] = []
  const procsRaw = top['affected_processes'] ?? top['affectedProcesses']
  if (Array.isArray(procsRaw)) {
    for (const p of procsRaw) {
      if (!p) continue
      // Accept both `"name"` and `{ name, ... }` shapes.
      const name =
        typeof p === 'string'
          ? p
          : typeof p === 'object'
            ? readString(p as Record<string, unknown>, [
                'name',
                'heuristicLabel',
                'label',
              ])
            : null
      if (name) affectedProcesses.push(name)
    }
  }

  const affectedModules: Array<{
    name: string
    hits: number
    impact: 'direct' | 'indirect'
  }> = []
  const modsRaw = top['affected_modules'] ?? top['affectedModules']
  if (Array.isArray(modsRaw)) {
    for (const m of modsRaw) {
      if (!m || typeof m !== 'object') continue
      const mo = m as Record<string, unknown>
      const name = readString(mo, ['name'])
      if (!name) continue
      const impactRaw = readString(mo, ['impact'])
      const impact: 'direct' | 'indirect' =
        impactRaw === 'indirect' ? 'indirect' : 'direct'
      affectedModules.push({
        name,
        hits: readNumber(mo, ['hits']) ?? 0,
        impact,
      })
    }
  }

  return { rows, risk, partial, affectedProcesses, affectedModules }
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

// Note: `gitnexus_detect_changes` is deliberately NOT wrapped. It walks
// the local working tree for uncommitted diffs, but Agent Bridge clones
// repos with `git clone --depth 1 --single-branch` and never modifies
// the tree (we git-reset on pull). So the diff set is always empty in
// our environment. The tool is useful only against a developer's
// actively-edited checkout, which we don't have access to.

// ─── route_map ───────────────────────────────────────────────────────────

/**
 * One row from `gitnexus_route_map`: a route → handler mapping plus the
 * full handler context gitnexus surfaces — middleware wrapper chain,
 * consumers that fetch the route, and any execution flow nodes the
 * route entry-points into. Originally we projected only handlerPath;
 * extending the parser lets `find_in_codebase` surface "this route is
 * auth-protected" and "this route is called from X, Y, Z" without
 * triggering a follow-up gitnexus call.
 */
export interface GitnexusRouteConsumer {
  /** Component / hook name that fetches this route. */
  readonly name: string
  readonly filePath: string
  /** Response keys the consumer accesses (when gitnexus extracted them). */
  readonly accessedKeys: readonly string[]
  /** Number of fetch sites in the consumer file (when > 1). */
  readonly fetchCount: number | null
}

export interface GitnexusRoute {
  readonly repo: string
  /** Normalised route, e.g. `POST /api/users/:id` or `/api/users`. */
  readonly route: string
  /** HTTP method when gitnexus extracted one, else null. */
  readonly method: string | null
  /** Handler file the route resolves to, when known. */
  readonly handlerPath: string | null
  /** Handler symbol when gitnexus identifies a function/method. */
  readonly handlerSymbol: string | null
  /**
   * Wrapper functions composed around the handler (e.g. `withAuth`,
   * `withRateLimit`). Empty when gitnexus detected none. The LLM can
   * use this to answer "is this route auth-protected?" without a
   * follow-up tool call.
   */
  readonly middleware: readonly string[]
  /** Frontend components / hooks that fetch this route. */
  readonly consumers: readonly GitnexusRouteConsumer[]
  /**
   * Execution flow nodes (gitnexus `Process`) the route entry-points
   * into. Empty when gitnexus hasn't detected a process. Mostly useful
   * as a follow-up signal — operators rarely care about flow names
   * directly but they hint at "this route does more than the handler
   * suggests."
   */
  readonly flows: readonly string[]
}

export interface RouteMapInput extends CallGitnexusInput {
  /** Filter by route path. Omit for the full map (capped by gitnexus). */
  readonly route?: string
}

export async function callGitnexusRouteMap(
  input: RouteMapInput,
): Promise<readonly GitnexusRoute[]> {
  const { tools, repo, route } = input
  const tool = tools['gitnexus_route_map']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_route_map tool is not mounted')
  }
  const args: Record<string, unknown> = {}
  if (repo) args['repo'] = repo
  if (route) args['route'] = route
  const raw = await tool.execute(args as never, {} as never)
  return parseRouteMap(raw)
}

function parseRouteMap(raw: unknown): GitnexusRoute[] {
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
    if (Array.isArray(o['routes'])) collect(o['routes'])
    if (Array.isArray(o['items'])) collect(o['items'])
    if (Array.isArray(o['results'])) collect(o['results'])
  }
  collect(data)

  const out: GitnexusRoute[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const route =
      readString(o, ['route', 'path', 'pattern', 'normalizedRoute']) ?? ''
    if (!route) continue
    // Handler can be a string (newer gitnexus emits `handler: "src/.../foo.ts"`)
    // or a nested object (older versions emit `handler: { filePath, name }`).
    // Probe both shapes.
    let handlerPath: string | null = readString(o, [
      'handlerPath',
      'handler_path',
      'handlerFile',
    ])
    let handlerSymbol: string | null = readString(o, [
      'handlerSymbol',
      'handler_symbol',
      'handlerName',
    ])
    const handler = o['handler']
    if (typeof handler === 'string' && handler.length > 0) {
      if (!handlerPath) handlerPath = handler
    } else if (
      handler &&
      typeof handler === 'object' &&
      !Array.isArray(handler)
    ) {
      const h = handler as Record<string, unknown>
      if (!handlerPath)
        handlerPath = readString(h, ['filePath', 'path', 'file'])
      if (!handlerSymbol) handlerSymbol = readString(h, ['name', 'symbol'])
    }
    // Middleware: gitnexus emits a string array (e.g. ["withAuth",
    // "withRateLimit"]). May arrive null when the indexer detected
    // none — coerce to [] so consumers don't have to null-check.
    const middleware: string[] = []
    const middlewareRaw = o['middleware']
    if (Array.isArray(middlewareRaw)) {
      for (const m of middlewareRaw) {
        if (typeof m === 'string' && m.length > 0) middleware.push(m)
      }
    }
    // Consumers: array of `{ name, filePath, accessedKeys?, fetchCount? }`.
    const consumers: GitnexusRouteConsumer[] = []
    const consumersRaw = o['consumers']
    if (Array.isArray(consumersRaw)) {
      for (const c of consumersRaw) {
        if (!c || typeof c !== 'object') continue
        const cObj = c as Record<string, unknown>
        const name = readString(cObj, ['name'])
        const filePath = readString(cObj, ['filePath', 'path', 'file'])
        if (!name || !filePath) continue
        const accessedKeysRaw = cObj['accessedKeys']
        const accessedKeys: string[] = []
        if (Array.isArray(accessedKeysRaw)) {
          for (const k of accessedKeysRaw) {
            if (typeof k === 'string' && k.length > 0) accessedKeys.push(k)
          }
        }
        consumers.push({
          name,
          filePath,
          accessedKeys,
          fetchCount: readNumber(cObj, ['fetchCount', 'fetch_count']),
        })
      }
    }
    // Flows: execution flow node names (Process labels).
    const flows: string[] = []
    const flowsRaw = o['flows']
    if (Array.isArray(flowsRaw)) {
      for (const f of flowsRaw) {
        if (typeof f === 'string' && f.length > 0) flows.push(f)
      }
    }
    out.push({
      repo: readString(o, ['repo', 'repository']) ?? '',
      route,
      method: readString(o, ['method', 'httpMethod', 'verb']),
      handlerPath,
      handlerSymbol,
      middleware,
      consumers,
      flows,
    })
  }
  return out
}

// ─── api_impact ──────────────────────────────────────────────────────────

/**
 * Subset of `gitnexus_api_impact` we surface. The real payload carries
 * routes + consumers + middleware + shape mismatches + risk level; we
 * collapse it into a flat list of consumer file paths plus the route's
 * own metadata so `assess_change_impact` can union these with its
 * call-graph results without rewriting its rendering path.
 */
export interface GitnexusApiImpactConsumer {
  readonly repo: string
  readonly path: string
  /** Which response keys this consumer accesses (when gitnexus surfaces them). */
  readonly accessedKeys: readonly string[]
  /** `mismatch` when consumer reads keys absent from the route's response shape. */
  readonly status: 'ok' | 'mismatch' | null
  /** Gitnexus's confidence in the attribution. */
  readonly confidence: 'high' | 'medium' | 'low' | null
}

/**
 * One route in the api_impact report. Captures the full handler
 * context gitnexus emits so a single api_impact call answers
 * "what's the API contract, who calls it, what middleware protects
 * it, what flows does it trigger?" without a follow-up tool call.
 */
export interface GitnexusApiImpactRoute {
  readonly route: string
  readonly handlerPath: string | null
  /** Wrapper functions composed around the handler. Empty when none. */
  readonly middleware: readonly string[]
  /**
   * `'partial'` when gitnexus could only inspect ONE HTTP method
   * export from a multi-method handler file; the middleware list may
   * be incomplete for other methods on the same file. `null` when
   * gitnexus flagged no caveat. Critical safety signal for the IDE:
   * a `partial` flag means "do not trust the absence of middleware."
   */
  readonly middlewareDetection: 'partial' | null
  /** Human-readable note attached to a partial middleware detection. */
  readonly middlewareNote: string | null
  /**
   * Response shape gitnexus extracted from the handler's `.json({...})`
   * calls. `success` is the top-level keys of the happy-path
   * response; `error` is the top-level keys of error responses. Lets
   * the IDE answer "what does this route return?" without reading
   * the handler.
   */
  readonly responseShape: {
    readonly success: readonly string[]
    readonly error: readonly string[]
  }
  /**
   * Names of execution flows (gitnexus `Process` nodes) this route
   * entry-points into. Names like "UserLogin", "Checkout". Useful for
   * narrative ("changing this route ripples into Login + Checkout").
   */
  readonly executionFlows: readonly string[]
}

export interface GitnexusApiImpactResult {
  /** The route(s) the impact report covered (may be multiple if `route`
   *  matched a pattern). */
  readonly routes: readonly GitnexusApiImpactRoute[]
  readonly consumers: readonly GitnexusApiImpactConsumer[]
  /** `LOW` / `MEDIUM` / `HIGH` per gitnexus's heuristic. `null` when absent. */
  readonly risk: string | null
}

export interface ApiImpactInput extends CallGitnexusInput {
  /** Route path to assess. Either `route` or `file` is required. */
  readonly route?: string
  /** Handler file path. Alternative to `route`. */
  readonly file?: string
}

export async function callGitnexusApiImpact(
  input: ApiImpactInput,
): Promise<GitnexusApiImpactResult> {
  const { tools, route, file, repo } = input
  if (!route && !file) {
    throw new Error(
      '[gitnexus-callers] callGitnexusApiImpact requires `route` or `file`',
    )
  }
  const tool = tools['gitnexus_api_impact']
  if (!tool || !tool.execute) {
    throw new Error(
      '[gitnexus-callers] gitnexus_api_impact tool is not mounted',
    )
  }
  const args: Record<string, unknown> = {}
  if (route) args['route'] = route
  if (file) args['file'] = file
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseApiImpact(raw)
}

function parseApiImpact(raw: unknown): GitnexusApiImpactResult {
  const data = unwrap(raw)
  if (!data || typeof data !== 'object') {
    return { routes: [], consumers: [], risk: null }
  }
  // Gitnexus returns either a single route object or `{ routes: [...], total: N }`.
  const top = data as Record<string, unknown>
  const routeObjects: Record<string, unknown>[] = []
  if (Array.isArray(top['routes'])) {
    for (const r of top['routes'] as unknown[]) {
      if (r && typeof r === 'object')
        routeObjects.push(r as Record<string, unknown>)
    }
  } else {
    routeObjects.push(top)
  }
  const consumers: GitnexusApiImpactConsumer[] = []
  const routes: GitnexusApiImpactRoute[] = []
  // `risk` lives at `impactSummary.riskLevel` per the gitnexus shape. We
  // also accept top-level `risk`/`risk_level` as defensive fallbacks for
  // future versions or alternate emitters. First non-null wins.
  let risk: string | null = null
  const seen = new Set<string>()
  for (const r of routeObjects) {
    const routePath = readString(r, ['route', 'path', 'pattern']) ?? ''
    if (routePath) {
      const handler = r['handler']
      const handlerPath =
        readString(r, ['handlerPath', 'handler_path', 'handlerFile']) ??
        (typeof handler === 'string' && handler.length > 0
          ? handler
          : handler && typeof handler === 'object' && !Array.isArray(handler)
            ? readString(handler as Record<string, unknown>, [
                'filePath',
                'path',
                'file',
              ])
            : null)
      // Middleware: string array. Coerce missing/non-array to [].
      const middleware: string[] = []
      const middlewareRaw = r['middleware']
      if (Array.isArray(middlewareRaw)) {
        for (const m of middlewareRaw) {
          if (typeof m === 'string' && m.length > 0) middleware.push(m)
        }
      }
      const middlewareDetectionRaw = readString(r, [
        'middlewareDetection',
        'middleware_detection',
      ])
      const middlewareDetection: 'partial' | null =
        middlewareDetectionRaw === 'partial' ? 'partial' : null
      const middlewareNote = readString(r, [
        'middlewareNote',
        'middleware_note',
      ])
      // Response shape: gitnexus emits `responseShape: { success, error }`
      // with both as string[]. Both default to [] when absent.
      const responseShapeRaw = r['responseShape']
      const responseShape: { success: string[]; error: string[] } = {
        success: [],
        error: [],
      }
      if (
        responseShapeRaw &&
        typeof responseShapeRaw === 'object' &&
        !Array.isArray(responseShapeRaw)
      ) {
        const rs = responseShapeRaw as Record<string, unknown>
        if (Array.isArray(rs['success'])) {
          for (const k of rs['success']) {
            if (typeof k === 'string' && k.length > 0)
              responseShape.success.push(k)
          }
        }
        if (Array.isArray(rs['error'])) {
          for (const k of rs['error']) {
            if (typeof k === 'string' && k.length > 0)
              responseShape.error.push(k)
          }
        }
      }
      const executionFlows: string[] = []
      const flowsRaw = r['executionFlows'] ?? r['execution_flows'] ?? r['flows']
      if (Array.isArray(flowsRaw)) {
        for (const f of flowsRaw) {
          if (typeof f === 'string' && f.length > 0) executionFlows.push(f)
        }
      }
      routes.push({
        route: routePath,
        handlerPath,
        middleware,
        middlewareDetection,
        middlewareNote,
        responseShape,
        executionFlows,
      })
    }
    if (!risk) {
      const summary = r['impactSummary']
      if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
        risk = readString(summary as Record<string, unknown>, [
          'riskLevel',
          'risk_level',
          'risk',
        ])
      }
    }
    if (!risk) risk = readString(r, ['risk', 'risk_level'])
    // Build a `(consumer file) → mismatch-confidence` lookup so we can
    // tag each consumer's status from the top-level `mismatches[]` array
    // gitnexus emits separately (consumers themselves don't carry a
    // `status` field).
    const mismatchByConsumer = new Map<string, 'high' | 'medium' | 'low'>()
    if (Array.isArray(r['mismatches'])) {
      for (const m of r['mismatches'] as unknown[]) {
        if (!m || typeof m !== 'object') continue
        const mObj = m as Record<string, unknown>
        const consumerPath = readString(mObj, ['consumer', 'file', 'filePath'])
        if (!consumerPath) continue
        const conf = readString(mObj, ['confidence']) ?? 'high'
        const norm: 'high' | 'medium' | 'low' =
          conf === 'low' ? 'low' : conf === 'medium' ? 'medium' : 'high'
        // Keep the worst (highest-confidence) mismatch when the same
        // consumer accesses multiple missing keys.
        const existing = mismatchByConsumer.get(consumerPath)
        if (!existing || rankConfidence(norm) > rankConfidence(existing)) {
          mismatchByConsumer.set(consumerPath, norm)
        }
      }
    }
    const consumerList = Array.isArray(r['consumers'])
      ? (r['consumers'] as unknown[])
      : []
    for (const c of consumerList) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      // Field name varies across gitnexus tools: `apiImpact` emits
      // `file`, `routeMap` emits `filePath`. Probe both.
      const path = readString(o, ['file', 'filePath', 'path'])
      if (!path) continue
      const dedupeKey = `${path}::${routePath}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      // Same dual-field name issue: `apiImpact` emits `accesses`,
      // `routeMap` emits `accessedKeys`.
      const accessedKeysRaw = o['accesses'] ?? o['accessedKeys']
      const accessedKeys = Array.isArray(accessedKeysRaw)
        ? (accessedKeysRaw.filter((k) => typeof k === 'string') as string[])
        : []
      const mismatchConf = mismatchByConsumer.get(path)
      consumers.push({
        repo: readString(o, ['repo', 'repository']) ?? '',
        path,
        accessedKeys,
        status: mismatchConf ? 'mismatch' : 'ok',
        confidence: mismatchConf ?? null,
      })
    }
  }
  return { routes, consumers, risk }
}

function rankConfidence(c: 'high' | 'medium' | 'low'): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1
}

// ─── cypher ──────────────────────────────────────────────────────────────

/**
 * `gitnexus_cypher` returns `{ markdown, row_count }`. The markdown is a
 * table for human consumption; row data is not surfaced as structured
 * JSON. We parse the table back into rows so wrappers can consume it
 * without re-rendering. Lossy on rich types but sufficient for the
 * path/name/score columns wrappers actually query for.
 *
 * Used INTERNALLY by wrappers (e.g. `trace_flow` for precise edge
 * filtering); never exposed to the LLM directly.
 */
export interface GitnexusCypherRow {
  readonly [column: string]: string
}

export interface GitnexusCypherResult {
  readonly markdown: string
  readonly rowCount: number
  readonly rows: readonly GitnexusCypherRow[]
}

export interface CypherInput extends CallGitnexusInput {
  /** Raw Cypher query. Wrappers compose against gitnexus's schema. */
  readonly query: string
}

export async function callGitnexusCypher(
  input: CypherInput,
): Promise<GitnexusCypherResult> {
  const { tools, query, repo } = input
  const tool = tools['gitnexus_cypher']
  if (!tool || !tool.execute) {
    throw new Error('[gitnexus-callers] gitnexus_cypher tool is not mounted')
  }
  const args: Record<string, unknown> = { query }
  if (repo) args['repo'] = repo
  const raw = await tool.execute(args as never, {} as never)
  return parseCypher(raw)
}

function parseCypher(raw: unknown): GitnexusCypherResult {
  const data = unwrap(raw)
  if (!data || typeof data !== 'object') {
    return { markdown: '', rowCount: 0, rows: [] }
  }
  const top = data as Record<string, unknown>
  const markdown = readString(top, ['markdown']) ?? ''
  const rowCount = readNumber(top, ['row_count', 'rowCount']) ?? 0
  return { markdown, rowCount, rows: parseMarkdownTable(markdown) }
}

/**
 * Parse a GitHub-flavoured markdown table into row objects.
 *
 *   | col_a | col_b |
 *   | ---   | ---   |
 *   | v1    | v2    |
 *
 * Anything outside the table (preamble, footnotes) is ignored. Returns
 * an empty array if no header row + separator row is detected.
 */
function parseMarkdownTable(markdown: string): GitnexusCypherRow[] {
  if (!markdown.trim()) return []
  const lines = markdown.split('\n').map((l) => l.trim())
  let headerIdx = -1
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]!.startsWith('|') && /^\|[\s:-]+\|/.test(lines[i + 1]!)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) return []
  const splitRow = (line: string): string[] =>
    line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim())
  const headers = splitRow(lines[headerIdx]!)
  const out: GitnexusCypherRow[] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('|')) break
    const cells = splitRow(line)
    const row: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]!] = cells[c] ?? ''
    }
    out.push(row)
  }
  return out
}
