/**
 * Read-only graph extraction over a repo's `gitnexus analyze` output.
 *
 *   GET /api/repos/:id/graph?mode=structure|symbols|imports
 *     200 { ok: true, graph: RepoGraph }
 *       → mode-specific slice of the knowledge graph. `symbols` is the
 *         default because that's the actual semantic graph the operator
 *         expects when they click "View graph"; `structure` is the
 *         directory tree fallback for repos with thin call graphs.
 *     404                              — repo not found
 *     409                              — repo is not yet indexed
 *                                        (no `meta.json`/Kuzu store).
 *     503                              — gitnexus cypher failed; we
 *                                        return the upstream message so
 *                                        operators can debug a stale
 *                                        index without tailing logs.
 *
 * Design notes:
 *   - All three modes share the response shape. Per-mode caps live
 *     here, not in the DTO, because the DTO is a wire contract while
 *     the caps are a server-side decision the UI just renders back.
 *   - `symbols` picks the top-degree Functions / Classes / Methods by
 *     CALLS connectivity (in + out), then materialises only the CALLS
 *     edges between those selected nodes. Edges to symbols outside the
 *     cap are dropped server-side so the modal never renders dangling
 *     endpoints.
 *   - `imports` operates at the File level. We don't add Folder
 *     parents because dagre lays out a File-only IMPORTS graph cleanly
 *     and the operator already has the structure mode for hierarchy.
 *   - count(*) failures are non-fatal. The UI hides the truncation
 *     hint when totals are null instead of crashing.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import {
  repoCommunityListResponseSchema,
  repoFileSliceQuerySchema,
  repoFileSliceResponseSchema,
  repoGraphNeighborsQuerySchema,
  repoGraphNeighborsResponseSchema,
  repoGraphQuerySchema,
  repoGraphSchema,
  repoIdParamSchema,
  repoProcessListResponseSchema,
  type RepoCommunityListResponse,
  type RepoCommunitySummary,
  type RepoFileSliceResponse,
  type RepoGraph,
  type RepoGraphEdge,
  type RepoGraphMode,
  type RepoGraphNeighbor,
  type RepoGraphNeighborsResponse,
  type RepoGraphNode,
  type RepoGraphNodeKind,
  type RepoProcessListResponse,
  type RepoProcessSummary,
} from '@agent-bridge/shared'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { repoCypherRows } from '@agent-bridge/shared/gitnexus'
import { repoDirName, repoSourceDir } from '@agent-bridge/shared/paths'
import { reposRepo } from '@agent-bridge/db'

import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

interface ModeCaps {
  readonly nodes: number
  readonly edges: number
}

/**
 * Network mode caps. Raised 2025 from { 600, 1500 } so hub nodes
 * actually keep their neighbours in the payload — the previous cap
 * was tight enough that a function with degree 77 could land in the
 * top-N set while all 77 of its callers were trimmed (each
 * individually low-degree). Hubs then rendered standalone on the
 * canvas, which read as a bug.
 *
 * Gitnexus's own viewer (`node_modules/gitnexus/dist/server/api.js:832`)
 * uses no cap at all — they ship the whole graph and let the client
 * stream + render it. We're not going that far yet (their NDJSON
 * stream covers the latency); 3000 is enough to fit the entire
 * graph for ~typical Agent-Bridge-attached repos (≤2000 functions +
 * methods + classes + files combined).
 *
 * If you find this still trims real-world repos, the next move is
 * to drop the cap entirely and stream the response — see the
 * gitnexus pattern.
 */
const NETWORK_CAPS: ModeCaps = { nodes: 3000, edges: 8000 }
const PROCESS_CAPS: ModeCaps = { nodes: 80, edges: 80 }
const COMMUNITY_CAPS: ModeCaps = { nodes: 80, edges: 200 }
const PROCESS_LIST_LIMIT = 200
const COMMUNITY_LIST_LIMIT = 200

interface RunContext {
  readonly sourceDir: string
  readonly repoName: string
}

const NEIGHBOR_LIMIT = 20

/** Common pattern: load the repo row, build a RunContext, run the
 *  handler, surface gitnexus errors uniformly. The caller has already
 *  validated `:id`. */
async function withRepoContext(
  c: Context,
  id: string,
  run: (ctx: RunContext) => Promise<Response>,
): Promise<Response> {
  const handle = getDb()
  const row = await reposRepo.getForWorker(handle, id)
  if (!row) {
    return httpError(c, {
      code: 'not_found',
      message: `repo ${id} not found`,
    })
  }
  if (!row.localPath) {
    return httpError(c, {
      code: 'conflict',
      message: `repo ${id} has no local clone yet`,
    })
  }
  const descriptor = {
    id: row.id,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
  }
  const ctx: RunContext = {
    sourceDir: repoSourceDir(descriptor),
    repoName: repoDirName(descriptor),
  }
  try {
    return await run(ctx)
  } catch (err) {
    if (err instanceof GraphExtractError) {
      if (err.reason === 'not-indexed') {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} has not been indexed yet`,
        })
      }
      return httpError(c, {
        code: 'internal',
        message: `gitnexus cypher failed: ${err.message}`,
        status: 503,
      })
    }
    throw err
  }
}

export const repoGraphRouter = new Hono()
  .get(
    '/:id/processes',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      return withRepoContext(c, id, async (ctx) => {
        const payload = await listProcesses(ctx)
        return c.json({
          ok: true as const,
          processes: repoProcessListResponseSchema.parse(payload),
        })
      })
    },
  )
  .get(
    '/:id/communities',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      return withRepoContext(c, id, async (ctx) => {
        const payload = await listCommunities(ctx)
        return c.json({
          ok: true as const,
          communities: repoCommunityListResponseSchema.parse(payload),
        })
      })
    },
  )
  .get(
    '/:id/file',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('query', repoFileSliceQuerySchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const query = c.req.valid('query')
      return withRepoContext(c, id, async (ctx) => {
        try {
          const slice = await readFileSlice(
            ctx.sourceDir,
            query.path,
            query.startLine ?? null,
            query.endLine ?? null,
            query.contextLines ?? DEFAULT_CONTEXT_LINES,
          )
          return c.json({
            ok: true as const,
            file: repoFileSliceResponseSchema.parse(slice),
          })
        } catch (err) {
          if (err instanceof FileSliceError) {
            return httpError(c, {
              code: err.code,
              message: err.message,
            })
          }
          throw err
        }
      })
    },
  )
  .get(
    '/:id/graph/neighbors',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('query', repoGraphNeighborsQuerySchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { nodeId } = c.req.valid('query')
      const handle = getDb()
      const row = await reposRepo.getForWorker(handle, id)
      if (!row) {
        return httpError(c, {
          code: 'not_found',
          message: `repo ${id} not found`,
        })
      }
      if (!row.localPath) {
        return httpError(c, {
          code: 'conflict',
          message: `repo ${id} has no local clone yet`,
        })
      }
      const descriptor = {
        id: row.id,
        remoteUrl: row.remoteUrl,
        branch: row.branch,
      }
      const ctx: RunContext = {
        sourceDir: repoSourceDir(descriptor),
        repoName: repoDirName(descriptor),
      }
      try {
        const payload = await buildNeighbors(ctx, nodeId)
        return c.json({
          ok: true as const,
          neighbors: repoGraphNeighborsResponseSchema.parse(payload),
        })
      } catch (err) {
        if (err instanceof GraphExtractError) {
          if (err.reason === 'not-indexed') {
            return httpError(c, {
              code: 'conflict',
              message: `repo ${id} has not been indexed yet`,
            })
          }
          return httpError(c, {
            code: 'internal',
            message: `gitnexus cypher failed: ${err.message}`,
            status: 503,
          })
        }
        throw err
      }
    },
  )
  .get(
  '/:id/graph',
  zValidator('param', repoIdParamSchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  zValidator('query', repoGraphQuerySchema, (result, c) => {
    if (!result.success) return httpValidationError(c, result.error)
    return
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const query = c.req.valid('query')
    const mode: RepoGraphMode = query.mode ?? 'network'
    const handle = getDb()

    const row = await reposRepo.getForWorker(handle, id)
    if (!row) {
      return httpError(c, {
        code: 'not_found',
        message: `repo ${id} not found`,
      })
    }
    if (!row.localPath) {
      return httpError(c, {
        code: 'conflict',
        message: `repo ${id} has no local clone yet`,
      })
    }

    const descriptor = {
      id: row.id,
      remoteUrl: row.remoteUrl,
      branch: row.branch,
    }
    const ctx: RunContext = {
      sourceDir: repoSourceDir(descriptor),
      // The analyze pass registers each repo under this alias (see
      // index-repo.ts:`--name <repoDirName>`); cypher's `-r` flag
      // picks it back up so we never depend on cwd-based resolution.
      repoName: repoDirName(descriptor),
    }

    try {
      let graph: RepoGraph
      if (mode === 'processes') {
        if (!query.selection) {
          return httpError(c, {
            code: 'validation_failed',
            message: '`selection` is required for mode=processes',
          })
        }
        graph = await buildProcessGraph(ctx, query.selection)
      } else if (mode === 'communities') {
        if (!query.selection) {
          return httpError(c, {
            code: 'validation_failed',
            message: '`selection` is required for mode=communities',
          })
        }
        graph = await buildCommunityGraph(ctx, query.selection)
      } else {
        // network is the only remaining "slice" mode; default for
        // any future / unrecognised mode for back-compat.
        graph = await buildNetworkGraph(ctx)
      }
      return c.json({ ok: true as const, graph: repoGraphSchema.parse(graph) })
    } catch (err) {
      if (err instanceof GraphExtractError) {
        if (err.reason === 'not-indexed') {
          return httpError(c, {
            code: 'conflict',
            message: `repo ${id} has not been indexed yet`,
          })
        }
        return httpError(c, {
          code: 'internal',
          message: `gitnexus cypher failed: ${err.message}`,
          status: 503,
        })
      }
      throw err
    }
  },
)


// ─── network mode (unified graph — all node kinds + all edge kinds) ─────

async function buildNetworkGraph(ctx: RunContext): Promise<RepoGraph> {
  // We want the operator to see the whole knowledge graph on first
  // open — every kind of node + every edge type, force-directed,
  // colored by kind. The slice rules:
  //
  //   - Functions / Methods / Classes ranked by CALLS degree.
  //   - Files ranked by IMPORTS degree (high-traffic files matter
  //     more for navigation; low-degree leaf files are dropped).
  //   - Folders included only if they parent a kept File via the
  //     containment edges harvested below.
  //
  // The per-kind splits are tuned to ~600 total nodes — enough for
  // a useful "shape of the codebase" view, few enough that
  // forceAtlas2 settles in 1-2 seconds in the browser.
  const FN_LIMIT = Math.floor(NETWORK_CAPS.nodes * 0.35)
  const METHOD_LIMIT = Math.floor(NETWORK_CAPS.nodes * 0.18)
  const CLASS_LIMIT = Math.floor(NETWORK_CAPS.nodes * 0.07)
  const FILE_LIMIT = Math.floor(NETWORK_CAPS.nodes * 0.3)

  const fnRows = await runQuery(
    ctx,
    `MATCH (n:Function)-[r:CodeRelation]-() WHERE r.type = 'CALLS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, deg ` +
      `ORDER BY deg DESC LIMIT ${FN_LIMIT}`,
  )
  const methodRows = await runQuery(
    ctx,
    `MATCH (n:Method)-[r:CodeRelation]-() WHERE r.type = 'CALLS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, deg ` +
      `ORDER BY deg DESC LIMIT ${METHOD_LIMIT}`,
  )
  const classRows = await runQuery(
    ctx,
    `MATCH (n:Class) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine ` +
      `ORDER BY n.id LIMIT ${CLASS_LIMIT}`,
  )
  const fileRows = await runQuery(
    ctx,
    `MATCH (n:File)-[r:CodeRelation]-() WHERE r.type = 'IMPORTS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, n.filePath AS filePath, deg ` +
      `ORDER BY deg DESC LIMIT ${FILE_LIMIT}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  for (const r of fnRows) {
    if (!r['id']) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'function',
      degree: parseIntOrNull(r['deg']),
      filePath: nonEmptyOrNull(r['filePath']),
      startLine: parseIntOrNull(r['startLine']),
      endLine: parseIntOrNull(r['endLine']),
    })
  }
  for (const r of methodRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'method',
      degree: parseIntOrNull(r['deg']),
      filePath: nonEmptyOrNull(r['filePath']),
      startLine: parseIntOrNull(r['startLine']),
      endLine: parseIntOrNull(r['endLine']),
    })
  }
  for (const r of classRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'class',
      filePath: nonEmptyOrNull(r['filePath']),
      startLine: parseIntOrNull(r['startLine']),
      endLine: parseIntOrNull(r['endLine']),
    })
  }
  for (const r of fileRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'file',
      degree: parseIntOrNull(r['deg']),
      filePath: nonEmptyOrNull(r['filePath']),
    })
  }

  // Pull edges of every relevant kind. Filter to endpoints we kept.
  const callsRows = await runQuery(
    ctx,
    `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' ` +
      `RETURN a.id AS source, b.id AS target LIMIT ${NETWORK_CAPS.edges * 3}`,
  )
  const importsRows = await runQuery(
    ctx,
    `MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS' ` +
      `RETURN a.id AS source, b.id AS target LIMIT ${NETWORK_CAPS.edges * 2}`,
  )
  const containsRows = await runQuery(
    ctx,
    `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CONTAINS' ` +
      `RETURN a.id AS source, b.id AS target LIMIT ${NETWORK_CAPS.edges * 2}`,
  )

  const edges: RepoGraphEdge[] = []
  const edgeSeen = new Set<string>()
  const addEdges = (
    rows: readonly Record<string, string | undefined>[],
    kind: RepoGraphEdge['kind'],
  ) => {
    for (const r of rows) {
      const s = r['source']
      const t = r['target']
      if (!s || !t) continue
      if (!nodes.has(s) || !nodes.has(t)) continue
      const key = `${kind}:${s} ${t}`
      if (edgeSeen.has(key)) continue
      edgeSeen.add(key)
      edges.push({ source: s, target: t, kind })
      if (edges.length >= NETWORK_CAPS.edges) return
    }
  }
  addEdges(callsRows, 'calls')
  if (edges.length < NETWORK_CAPS.edges) addEdges(importsRows, 'imports')
  if (edges.length < NETWORK_CAPS.edges) addEdges(containsRows, 'contains')

  const fnTotal = await tryFetchCount(
    ctx,
    `MATCH (n:Function) RETURN count(n) AS total`,
  )
  const methodTotal = await tryFetchCount(
    ctx,
    `MATCH (n:Method) RETURN count(n) AS total`,
  )
  const classTotal = await tryFetchCount(
    ctx,
    `MATCH (n:Class) RETURN count(n) AS total`,
  )
  const fileTotal = await tryFetchCount(
    ctx,
    `MATCH (n:File) RETURN count(n) AS total`,
  )

  return {
    mode: 'network',
    nodes: [...nodes.values()],
    edges,
    totals: {
      functions: fnTotal,
      methods: methodTotal,
      classes: classTotal,
      files: fileTotal,
    },
    limits: { nodes: NETWORK_CAPS.nodes, edges: NETWORK_CAPS.edges },
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

class GraphExtractError extends Error {
  readonly reason: 'not-indexed' | 'parse' | 'query' | 'spawn'
  constructor(
    message: string,
    reason: 'not-indexed' | 'parse' | 'query' | 'spawn',
  ) {
    super(message)
    this.name = 'GraphExtractError'
    this.reason = reason
  }
}

async function runQuery(
  ctx: RunContext,
  query: string,
): Promise<readonly Record<string, string | undefined>[]> {
  const result = await repoCypherRows(query, {
    sourceDir: ctx.sourceDir,
    fromModuleUrl: import.meta.url,
  })
  if (!result.ok) {
    throw new GraphExtractError(result.message, result.reason)
  }
  // Coerce every cell to string-or-undefined so the rest of this
  // file (which was written against the legacy markdown-table row
  // shape) continues to work unchanged. The number-parsing helpers
  // below also accept unknown, so this is a safety net more than a
  // requirement.
  return result.rows.map((row) => {
    const out: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(row)) {
      if (v == null) continue
      out[k] = typeof v === 'string' ? v : String(v)
    }
    return out
  })
}

async function tryFetchCount(
  ctx: RunContext,
  query: string,
): Promise<number | null> {
  const result = await repoCypherRows(query, {
    sourceDir: ctx.sourceDir,
    fromModuleUrl: import.meta.url,
  })
  if (!result.ok) return null
  const row = result.rows[0]
  if (!row) return null
  return parseIntOrNull(row['total'])
}

/**
 * Accept either a number (native from `executeQuery`) or a numeric
 * string (legacy callers / count(...) cells). BigInts from Kuzu's
 * INT64 columns are coerced to Number; we never expect counts above
 * 2^53 here.
 */
function parseIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Treat empty / "null" / undefined cypher cells as null. Cypher's
 * markdown-table emitter sometimes renders missing properties as a
 * literal `null` string we don't want bleeding into the DTO.
 */
function nonEmptyOrNull(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null
    return trimmed
  }
  // Defensive coerce for numeric or boolean cells — the previous
  // markdown-table layer always produced strings, so callers were
  // happy to receive strings even when a column held a number.
  return String(value)
}

// ─── neighbors (one-hop in each direction) ───────────────────────────────

const KIND_BY_LABEL: Record<string, RepoGraphNodeKind> = {
  Function: 'function',
  Method: 'method',
  Class: 'class',
  File: 'file',
  Folder: 'folder',
}

async function buildNeighbors(
  ctx: RunContext,
  nodeId: string,
): Promise<RepoGraphNeighborsResponse> {
  // Four directed one-hop queries. We avoid `()-[r]-()` non-directional
  // patterns because cypher's markdown emitter doesn't surface direction
  // when undirected, and we want explicit caller/callee labelling.
  const callersQ = neighborCypher(nodeId, 'CALLS', 'in')
  const calleesQ = neighborCypher(nodeId, 'CALLS', 'out')
  const parentsQ = neighborCypher(nodeId, 'CONTAINS', 'in')
  const childrenQ = neighborCypher(nodeId, 'CONTAINS', 'out')

  // Serialized — `gitnexus cypher` spawns a fresh process per call,
  // and parallel processes against the same Kuzu store contend for the
  // exclusive write lock even though we're read-only. The result is a
  // stderr "lock unavailable" message that bleeds into stdout and
  // breaks the JSON-envelope parser ("envelope is not an object").
  // Four sequential calls is plenty fast and fully reliable.
  const callers = await runQuery(ctx, callersQ)
  const callees = await runQuery(ctx, calleesQ)
  const parents = await runQuery(ctx, parentsQ)
  const children = await runQuery(ctx, childrenQ)

  const neighbors: RepoGraphNeighbor[] = []
  const seen = new Set<string>()
  const collect = (
    rows: readonly Record<string, string | undefined>[],
    relation: RepoGraphNeighbor['relation'],
  ) => {
    for (const r of rows) {
      const id = r['id']
      if (!id || seen.has(`${relation}:${id}`)) continue
      seen.add(`${relation}:${id}`)
      neighbors.push({
        id,
        name: r['name'] ?? id,
        kind: kindFromRow(r),
        relation,
        filePath: nonEmptyOrNull(r['filePath']),
        startLine: parseIntOrNull(r['startLine']),
        endLine: parseIntOrNull(r['endLine']),
      })
    }
  }
  collect(callers, 'caller')
  collect(callees, 'callee')
  collect(parents, 'parent')
  collect(children, 'child')

  // Best-effort totals — same serialization reason as above.
  const callersTotal = await tryFetchCount(
    ctx,
    neighborCountCypher(nodeId, 'CALLS', 'in'),
  )
  const calleesTotal = await tryFetchCount(
    ctx,
    neighborCountCypher(nodeId, 'CALLS', 'out'),
  )
  const parentsTotal = await tryFetchCount(
    ctx,
    neighborCountCypher(nodeId, 'CONTAINS', 'in'),
  )
  const childrenTotal = await tryFetchCount(
    ctx,
    neighborCountCypher(nodeId, 'CONTAINS', 'out'),
  )

  return {
    nodeId,
    neighbors,
    totals: {
      callers: callersTotal,
      callees: calleesTotal,
      parents: parentsTotal,
      children: childrenTotal,
    },
    limit: NEIGHBOR_LIMIT,
  }
}

function neighborCypher(
  nodeId: string,
  edgeType: 'CALLS' | 'CONTAINS',
  direction: 'in' | 'out',
): string {
  const escaped = nodeId.replace(/'/g, "\\'")
  const arrow =
    direction === 'in'
      ? `(other)-[r:CodeRelation]->(n)`
      : `(n)-[r:CodeRelation]->(other)`
  return (
    `MATCH ${arrow} WHERE n.id = '${escaped}' AND r.type = '${edgeType}' ` +
    `RETURN labels(other)[0] AS label, other.id AS id, other.name AS name, ` +
    `other.filePath AS filePath, other.startLine AS startLine, other.endLine AS endLine ` +
    `LIMIT ${NEIGHBOR_LIMIT}`
  )
}

function neighborCountCypher(
  nodeId: string,
  edgeType: 'CALLS' | 'CONTAINS',
  direction: 'in' | 'out',
): string {
  const escaped = nodeId.replace(/'/g, "\\'")
  const arrow =
    direction === 'in'
      ? `(other)-[r:CodeRelation]->(n)`
      : `(n)-[r:CodeRelation]->(other)`
  return (
    `MATCH ${arrow} WHERE n.id = '${escaped}' AND r.type = '${edgeType}' ` +
    `RETURN count(other) AS total`
  )
}

// ─── processes (list + subgraph) ──────────────────────────────────────

async function listProcesses(ctx: RunContext): Promise<RepoProcessListResponse> {
  const rows = await runQuery(
    ctx,
    `MATCH (p:Process) ` +
      `RETURN p.id AS id, p.stepCount AS stepCount, p.processType AS processType, ` +
      `p.entryPointId AS entryPointId ` +
      `ORDER BY p.stepCount DESC LIMIT ${PROCESS_LIST_LIMIT}`,
  )
  const out: RepoProcessSummary[] = rows.map((r) => ({
    id: r['id'] ?? '',
    stepCount: parseIntOrNull(r['stepCount']),
    processType: nonEmptyOrNull(r['processType']),
    label: deriveProcessLabel(r['id'], r['entryPointId']),
  }))
  const total = await tryFetchCount(
    ctx,
    `MATCH (p:Process) RETURN count(p) AS total`,
  )
  return { processes: out, total }
}

function deriveProcessLabel(
  id: string | undefined,
  entryPointId: string | undefined,
): string {
  // Entry-point ids look like `Function:src/a/b.ts:functionName` — the
  // last colon-separated segment is the symbol name. Fall back to the
  // process id (e.g. `proc_0_app`) when the entry point is unknown.
  const entry = nonEmptyOrNull(entryPointId)
  if (entry) {
    const lastColon = entry.lastIndexOf(':')
    if (lastColon >= 0 && lastColon < entry.length - 1) {
      return entry.slice(lastColon + 1)
    }
    return entry
  }
  return id ?? '(unnamed)'
}

async function buildProcessGraph(
  ctx: RunContext,
  processId: string,
): Promise<RepoGraph> {
  const escaped = processId.replace(/'/g, "\\'")
  // Members are connected to the Process via STEP_IN_PROCESS edges with
  // a 1-based `step` property. The edges point member → process, so the
  // sort + grouping happens here in JS.
  const memberRows = await runQuery(
    ctx,
    `MATCH (other)-[r:CodeRelation]->(p:Process) ` +
      `WHERE p.id = '${escaped}' AND r.type = 'STEP_IN_PROCESS' ` +
      `RETURN other.id AS id, other.name AS name, other.filePath AS filePath, ` +
      `other.startLine AS startLine, other.endLine AS endLine, r.step AS step ` +
      `ORDER BY r.step ASC LIMIT ${PROCESS_CAPS.nodes}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  // Synthetic Process node — the focal point of the view.
  nodes.set(processId, {
    id: processId,
    name: processId,
    kind: 'process',
  })

  const memberOrder: { id: string; step: number | null }[] = []
  for (const r of memberRows) {
    const id = r['id']
    if (!id) continue
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name: r['name'] ?? id,
        kind: kindFromId(id),
        filePath: nonEmptyOrNull(r['filePath']),
        startLine: parseIntOrNull(r['startLine']),
        endLine: parseIntOrNull(r['endLine']),
      })
    }
    memberOrder.push({ id, step: parseIntOrNull(r['step']) })
  }

  // Edges: process → each member, labelled by step so the UI can
  // render the order. Direction here is process → member because that
  // reads as "starts here, then this, then this" in the dagre layout.
  const edges: RepoGraphEdge[] = []
  for (const m of memberOrder) {
    edges.push({
      source: processId,
      target: m.id,
      kind: 'step',
      step: m.step,
    })
    if (edges.length >= PROCESS_CAPS.edges) break
  }

  return {
    mode: 'processes',
    nodes: [...nodes.values()],
    edges,
    totals: {},
    limits: { nodes: PROCESS_CAPS.nodes, edges: PROCESS_CAPS.edges },
  }
}

// ─── communities (list + subgraph) ────────────────────────────────────

async function listCommunities(
  ctx: RunContext,
): Promise<RepoCommunityListResponse> {
  const rows = await runQuery(
    ctx,
    `MATCH (c:Community) ` +
      `RETURN c.id AS id, c.heuristicLabel AS label, c.cohesion AS cohesion, ` +
      `c.symbolCount AS symbolCount ` +
      `ORDER BY c.symbolCount DESC LIMIT ${COMMUNITY_LIST_LIMIT}`,
  )
  const out: RepoCommunitySummary[] = rows.map((r) => ({
    id: r['id'] ?? '',
    label: nonEmptyOrNull(r['label']) ?? r['id'] ?? '(unnamed)',
    cohesion: parseFloatOrNull(r['cohesion']),
    symbolCount: parseIntOrNull(r['symbolCount']),
  }))
  const total = await tryFetchCount(
    ctx,
    `MATCH (c:Community) RETURN count(c) AS total`,
  )
  return { communities: out, total }
}

async function buildCommunityGraph(
  ctx: RunContext,
  communityId: string,
): Promise<RepoGraph> {
  const escaped = communityId.replace(/'/g, "\\'")
  const memberRows = await runQuery(
    ctx,
    `MATCH (other)-[r:CodeRelation]->(c:Community) ` +
      `WHERE c.id = '${escaped}' AND r.type = 'MEMBER_OF' ` +
      `RETURN other.id AS id, other.name AS name, other.filePath AS filePath, ` +
      `other.startLine AS startLine, other.endLine AS endLine ` +
      `ORDER BY other.id LIMIT ${COMMUNITY_CAPS.nodes}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  nodes.set(communityId, {
    id: communityId,
    name: communityId,
    kind: 'community',
  })
  for (const r of memberRows) {
    const id = r['id']
    if (!id || nodes.has(id)) continue
    nodes.set(id, {
      id,
      name: r['name'] ?? id,
      kind: kindFromId(id),
      filePath: nonEmptyOrNull(r['filePath']),
      startLine: parseIntOrNull(r['startLine']),
      endLine: parseIntOrNull(r['endLine']),
    })
  }

  // Community → member edges, plus any CALLS edges between members
  // already in the set. The CALLS overlay shows the internal call
  // graph of the cluster — what makes the community "cohesive".
  const edges: RepoGraphEdge[] = []
  for (const r of memberRows) {
    if (!r['id']) continue
    edges.push({
      source: communityId,
      target: r['id'],
      kind: 'member',
    })
  }

  if (memberRows.length > 0) {
    const callRows = await runQuery(
      ctx,
      `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' ` +
        `RETURN a.id AS source, b.id AS target LIMIT ${COMMUNITY_CAPS.edges * 4}`,
    )
    const memberSet = new Set(memberRows.map((r) => r['id']!).filter(Boolean))
    const seenEdge = new Set<string>()
    for (const r of callRows) {
      const s = r['source']
      const t = r['target']
      if (!s || !t) continue
      if (!memberSet.has(s) || !memberSet.has(t)) continue
      const key = `${s} ${t}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      edges.push({ source: s, target: t, kind: 'calls' })
      if (edges.length >= COMMUNITY_CAPS.edges) break
    }
  }

  return {
    mode: 'communities',
    nodes: [...nodes.values()],
    edges,
    totals: {},
    limits: { nodes: COMMUNITY_CAPS.nodes, edges: COMMUNITY_CAPS.edges },
  }
}

function parseFloatOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function kindFromId(id: string): RepoGraphNodeKind {
  const colonIdx = id.indexOf(':')
  if (colonIdx > 0) {
    const prefix = id.slice(0, colonIdx)
    if (KIND_BY_LABEL[prefix]) return KIND_BY_LABEL[prefix]!
  }
  return 'file'
}

function kindFromRow(
  r: Record<string, string | undefined>,
): RepoGraphNodeKind {
  const label = nonEmptyOrNull(r['label'])
  if (label && KIND_BY_LABEL[label]) return KIND_BY_LABEL[label]!
  // `labels(other)[0]` returns an empty cell in gitnexus's Kuzu
  // dialect (markdown emitter strips the property), so we lean on
  // the id prefix as the canonical kind source. The id format is
  // `<Label>:<...>` for every node kind we surface.
  const id = nonEmptyOrNull(r['id'])
  if (id) {
    const colonIdx = id.indexOf(':')
    if (colonIdx > 0) {
      const prefix = id.slice(0, colonIdx)
      if (KIND_BY_LABEL[prefix]) return KIND_BY_LABEL[prefix]!
    }
  }
  // Last resort — render as a generic file rather than drop the row.
  return 'file'
}

// ─── file slice (source preview for the details panel) ───────────────────

const DEFAULT_CONTEXT_LINES = 3
const MAX_PREVIEW_LINES = 400
const MAX_FILE_SIZE_BYTES = 2_000_000

class FileSliceError extends Error {
  readonly code: 'not_found' | 'validation_failed' | 'forbidden'
  constructor(message: string, code: FileSliceError['code']) {
    super(message)
    this.name = 'FileSliceError'
    this.code = code
  }
}

async function readFileSlice(
  sourceDir: string,
  relPath: string,
  startLine: number | null,
  endLine: number | null,
  contextLines: number,
): Promise<RepoFileSliceResponse> {
  // Resolve and sandbox: the resolved path must sit under sourceDir.
  // Refuse symlinked escapes via the realpath check below.
  const normalised = path.normalize(relPath).replace(/^[/\\]+/, '')
  if (normalised.startsWith('..') || normalised.includes(`${path.sep}..${path.sep}`)) {
    throw new FileSliceError(
      'path traversal not allowed',
      'forbidden',
    )
  }
  const absPath = path.join(sourceDir, normalised)
  let realPath: string
  try {
    realPath = await fs.realpath(absPath)
  } catch {
    throw new FileSliceError(`file not found: ${normalised}`, 'not_found')
  }
  const realSourceDir = await fs.realpath(sourceDir)
  if (
    realPath !== realSourceDir &&
    !realPath.startsWith(realSourceDir + path.sep)
  ) {
    throw new FileSliceError(
      'path traversal not allowed',
      'forbidden',
    )
  }

  const stat = await fs.stat(realPath)
  if (!stat.isFile()) {
    throw new FileSliceError(`not a regular file: ${normalised}`, 'not_found')
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new FileSliceError(
      `file too large: ${stat.size} bytes (max ${MAX_FILE_SIZE_BYTES})`,
      'validation_failed',
    )
  }

  // No streaming required — files we care about are source code,
  // so the 2 MB cap covers every realistic case and keeps the
  // string-split below trivially fast.
  const content = await fs.readFile(realPath, 'utf8')
  const lines = content.split('\n')
  const totalLines = lines.length

  // Pad start/end with `contextLines` on each side; clamp to bounds.
  // If neither boundary is provided, take the first MAX_PREVIEW_LINES
  // so a click on a file-kind node still surfaces something useful.
  let wantStart: number
  let wantEnd: number
  if (startLine == null && endLine == null) {
    wantStart = 1
    wantEnd = Math.min(MAX_PREVIEW_LINES, totalLines)
  } else {
    const s = startLine ?? endLine ?? 1
    const e = endLine ?? startLine ?? totalLines
    wantStart = Math.max(1, s - contextLines)
    wantEnd = Math.min(totalLines, e + contextLines)
  }
  // Cap how many lines we ship in any one response.
  if (wantEnd - wantStart + 1 > MAX_PREVIEW_LINES) {
    wantEnd = wantStart + MAX_PREVIEW_LINES - 1
  }
  const slice = lines.slice(wantStart - 1, wantEnd)

  return {
    path: normalised,
    startLine: wantStart,
    endLine: wantStart + slice.length - 1,
    lines: slice,
    totalLines,
    language: detectLanguageFromPath(normalised),
  }
}

/** Best-effort guess from extension. The frontend's renderer treats
 *  unknown languages as plain text — this is just a hint, not a
 *  contract. */
function detectLanguageFromPath(p: string): string | null {
  const lower = p.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return null
  const ext = lower.slice(dot + 1)
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    pyi: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    html: 'html',
    css: 'css',
  }
  return map[ext] ?? null
}

export type RepoGraphRouter = typeof repoGraphRouter
