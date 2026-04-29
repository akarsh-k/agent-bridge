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
import { Hono } from 'hono'
import {
  repoGraphQuerySchema,
  repoGraphSchema,
  repoIdParamSchema,
  type RepoGraph,
  type RepoGraphEdge,
  type RepoGraphMode,
  type RepoGraphNode,
} from '@agent-bridge/shared'
import { repoCypherRows } from '@agent-bridge/shared/gitnexus'
import { repoDirName, repoSourceDir } from '@agent-bridge/shared/paths'
import { reposRepo } from '@agent-bridge/db'

import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

interface ModeCaps {
  readonly nodes: number
  readonly edges: number
}

const STRUCTURE_CAPS: ModeCaps = { nodes: 500, edges: 800 }
const SYMBOLS_CAPS: ModeCaps = { nodes: 150, edges: 600 }
const IMPORTS_CAPS: ModeCaps = { nodes: 200, edges: 600 }

interface RunContext {
  readonly sourceDir: string
  readonly repoName: string
}

export const repoGraphRouter = new Hono().get(
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
    const mode: RepoGraphMode = query.mode ?? 'symbols'
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
      const graph: RepoGraph =
        mode === 'structure'
          ? await buildStructureGraph(ctx)
          : mode === 'imports'
            ? await buildImportsGraph(ctx)
            : await buildSymbolsGraph(ctx)
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

// ─── structure mode (Folder + File + CONTAINS) ───────────────────────────

async function buildStructureGraph(ctx: RunContext): Promise<RepoGraph> {
  const folderRows = await runQuery(
    ctx,
    `MATCH (f:Folder) RETURN f.id AS id, f.name AS name ORDER BY f.id LIMIT ${Math.floor(STRUCTURE_CAPS.nodes * 0.4)}`,
  )
  const fileRows = await runQuery(
    ctx,
    `MATCH (f:File) RETURN f.id AS id, f.name AS name ORDER BY f.id LIMIT ${STRUCTURE_CAPS.nodes - Math.floor(STRUCTURE_CAPS.nodes * 0.4)}`,
  )
  const edgeRows = await runQuery(
    ctx,
    `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CONTAINS' ` +
      `RETURN a.id AS source, b.id AS target ORDER BY a.id, b.id LIMIT ${STRUCTURE_CAPS.edges}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  for (const r of folderRows) {
    if (!r['id']) continue
    nodes.set(r['id'], { id: r['id'], name: r['name'] ?? r['id'], kind: 'folder' })
  }
  for (const r of fileRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], { id: r['id'], name: r['name'] ?? r['id'], kind: 'file' })
  }

  const edges: RepoGraphEdge[] = []
  for (const r of edgeRows) {
    if (!r['source'] || !r['target']) continue
    if (!nodes.has(r['source']) || !nodes.has(r['target'])) continue
    edges.push({ source: r['source'], target: r['target'], kind: 'contains' })
  }

  const folderTotal = await tryFetchCount(ctx, `MATCH (f:Folder) RETURN count(f) AS total`)
  const fileTotal = await tryFetchCount(ctx, `MATCH (f:File) RETURN count(f) AS total`)

  return {
    mode: 'structure',
    nodes: [...nodes.values()],
    edges,
    totals: { folders: folderTotal, files: fileTotal },
    limits: { nodes: STRUCTURE_CAPS.nodes, edges: STRUCTURE_CAPS.edges },
  }
}

// ─── symbols mode (top Functions / Classes / Methods + CALLS) ────────────

async function buildSymbolsGraph(ctx: RunContext): Promise<RepoGraph> {
  // Pick the most-connected symbols across Function + Class + Method.
  // Three small queries are cheaper to run than a single UNION across
  // all three labels; gitnexus's Kuzu build doesn't reliably support
  // UNION ALL in `MATCH ... WITH` chains, and the per-label cap keeps
  // each query bounded.
  const fnLimit = Math.floor(SYMBOLS_CAPS.nodes * 0.7) // 70% functions
  const methodLimit = Math.floor(SYMBOLS_CAPS.nodes * 0.25) // 25% methods
  const classLimit = SYMBOLS_CAPS.nodes - fnLimit - methodLimit // 5% classes

  const fnRows = await runQuery(
    ctx,
    `MATCH (n:Function)-[r:CodeRelation]-() WHERE r.type = 'CALLS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, deg ORDER BY deg DESC LIMIT ${fnLimit}`,
  )
  const methodRows = await runQuery(
    ctx,
    `MATCH (n:Method)-[r:CodeRelation]-() WHERE r.type = 'CALLS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, deg ORDER BY deg DESC LIMIT ${methodLimit}`,
  )
  const classRows = await runQuery(
    ctx,
    `MATCH (n:Class) RETURN n.id AS id, n.name AS name ORDER BY n.id LIMIT ${classLimit}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  for (const r of fnRows) {
    if (!r['id']) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'function',
      degree: parseIntOrNull(r['deg']),
    })
  }
  for (const r of methodRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'method',
      degree: parseIntOrNull(r['deg']),
    })
  }
  for (const r of classRows) {
    if (!r['id'] || nodes.has(r['id'])) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'class',
    })
  }

  // Pull every CALLS edge then filter to ones whose endpoints survived
  // the cap. Pulling the full set first (cap'd at edges-cap * 5) keeps
  // the query simple and correct even when popular symbols sit at
  // ranks 60+ in the function set; a per-edge join into the node-cap
  // would need a temp table cypher doesn't expose.
  const edgeRows = await runQuery(
    ctx,
    `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' ` +
      `RETURN a.id AS source, b.id AS target LIMIT ${SYMBOLS_CAPS.edges * 5}`,
  )

  const edges: RepoGraphEdge[] = []
  const edgeSeen = new Set<string>()
  for (const r of edgeRows) {
    if (!r['source'] || !r['target']) continue
    if (!nodes.has(r['source']) || !nodes.has(r['target'])) continue
    const key = `${r['source']} ${r['target']}`
    if (edgeSeen.has(key)) continue
    edgeSeen.add(key)
    edges.push({ source: r['source'], target: r['target'], kind: 'calls' })
    if (edges.length >= SYMBOLS_CAPS.edges) break
  }

  const fnTotal = await tryFetchCount(ctx, `MATCH (n:Function) RETURN count(n) AS total`)
  const methodTotal = await tryFetchCount(ctx, `MATCH (n:Method) RETURN count(n) AS total`)
  const classTotal = await tryFetchCount(ctx, `MATCH (n:Class) RETURN count(n) AS total`)

  return {
    mode: 'symbols',
    nodes: [...nodes.values()],
    edges,
    totals: {
      functions: fnTotal,
      methods: methodTotal,
      classes: classTotal,
    },
    limits: { nodes: SYMBOLS_CAPS.nodes, edges: SYMBOLS_CAPS.edges },
  }
}

// ─── imports mode (File + IMPORTS) ───────────────────────────────────────

async function buildImportsGraph(ctx: RunContext): Promise<RepoGraph> {
  // Pick files with the highest IMPORTS degree (in + out) so we keep
  // the actually-connected nodes, not whichever 200 sort first by id.
  const fileRows = await runQuery(
    ctx,
    `MATCH (n:File)-[r:CodeRelation]-() WHERE r.type = 'IMPORTS' ` +
      `WITH n, count(r) AS deg ` +
      `RETURN n.id AS id, n.name AS name, deg ORDER BY deg DESC LIMIT ${IMPORTS_CAPS.nodes}`,
  )
  const edgeRows = await runQuery(
    ctx,
    `MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS' ` +
      `RETURN a.id AS source, b.id AS target LIMIT ${IMPORTS_CAPS.edges * 4}`,
  )

  const nodes = new Map<string, RepoGraphNode>()
  for (const r of fileRows) {
    if (!r['id']) continue
    nodes.set(r['id'], {
      id: r['id'],
      name: r['name'] ?? r['id'],
      kind: 'file',
      degree: parseIntOrNull(r['deg']),
    })
  }

  const edges: RepoGraphEdge[] = []
  const edgeSeen = new Set<string>()
  for (const r of edgeRows) {
    if (!r['source'] || !r['target']) continue
    if (!nodes.has(r['source']) || !nodes.has(r['target'])) continue
    const key = `${r['source']} ${r['target']}`
    if (edgeSeen.has(key)) continue
    edgeSeen.add(key)
    edges.push({ source: r['source'], target: r['target'], kind: 'imports' })
    if (edges.length >= IMPORTS_CAPS.edges) break
  }

  const fileTotal = await tryFetchCount(ctx, `MATCH (f:File) RETURN count(f) AS total`)

  return {
    mode: 'imports',
    nodes: [...nodes.values()],
    edges,
    totals: { files: fileTotal },
    limits: { nodes: IMPORTS_CAPS.nodes, edges: IMPORTS_CAPS.edges },
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
): Promise<readonly Record<string, string>[]> {
  const result = await repoCypherRows(query, {
    sourceDir: ctx.sourceDir,
    repoName: ctx.repoName,
    fromModuleUrl: import.meta.url,
  })
  if (!result.ok) {
    throw new GraphExtractError(result.message, result.reason)
  }
  return result.rows
}

async function tryFetchCount(
  ctx: RunContext,
  query: string,
): Promise<number | null> {
  const result = await repoCypherRows(query, {
    sourceDir: ctx.sourceDir,
    repoName: ctx.repoName,
    fromModuleUrl: import.meta.url,
  })
  if (!result.ok) return null
  const row = result.rows[0]
  if (!row) return null
  return parseIntOrNull(row['total'])
}

function parseIntOrNull(value: string | undefined): number | null {
  if (!value) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

export type RepoGraphRouter = typeof repoGraphRouter
