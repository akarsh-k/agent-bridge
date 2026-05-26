/**
 * `trace_flow` wrapper (`docs/ARCHITECTURE.md §10`).
 *
 * Walks the call/import graph from a starting anchor (file path or
 * symbol name) toward a goal. Returns a codebase inspection report whose `graph_subset`
 * carries the visited nodes and the edges between them; the
 * highest-relevance hops also get fetched as `files` chunks so the
 * LLM has actual code to look at, not just node ids.
 *
 * Implementation:
 *   1. Resolve the repo (single or all). Trace MUST scope to one
 *      starting repo — there's no obvious anchor when fanned out.
 *   2. Use `gitnexus_impact` with `direction='downstream'` from the
 *      anchor, depth = 4 (the plan's cap). Gitnexus's impact tool
 *      already does the graph walk; reusing it avoids hand-writing a
 *      cypher template that drifts on schema changes.
 *   3. Each impact row becomes a `CodebaseInspectionReportGraphNode`; consecutive
 *      depths produce edges between them.
 *   4. For the top-K (cap 6) closest hops, fetch `gitnexus_context` to
 *      stuff the file content into codebase inspection report chunks. Beyond depth 2
 *      we stop fetching context — too much noise and the wire payload
 *      caps out anyway.
 *
 * Cypher would let us write a more precise query (e.g. "follow CALLS
 * edges only, ignore IMPORTS") but the contract for `gitnexus_cypher`'s
 * schema isn't pinned across versions. impact-driven trace is good
 * enough for now and a cypher refinement can land when
 * gitnexus pins its schema.
 */

import type { AttachedRepo } from '@agent-bridge/shared'

import {
  callGitnexusCypher,
  callGitnexusImpact,
  type GitnexusImpactRow,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeCodebaseInspectionReport, type CodebaseInspectionReportDraft } from '../codebase-inspection-report.js'
import { readFileChunkFromDisk } from '../read-source.js'
import { resolveRepoForWrapper } from '../run-context.js'
import type {
  CodebaseInspectionReport,
  CodebaseInspectionReportChunk,
  CodebaseInspectionReportFile,
  CodebaseInspectionReportGraphEdge,
  CodebaseInspectionReportGraphNode,
} from '../types.js'
import {
  emitReportBuilt,
  emitToolCalled,
  emitToolResult,
  withGitnexusCall,
} from '../wrapper-telemetry.js'

const TRACE_DEPTH_CAP = 4 as const
const CONTEXT_FETCH_CAP = 6 as const
const CONTEXT_DEPTH_CAP = 2 as const

export interface TraceFlowInput {
  readonly tools: ToolDict
  readonly repos: readonly AttachedRepo[]
  /** File path to anchor on. Either this or `startSymbol` is required. */
  readonly startPath?: string
  /** Symbol name to anchor on. Either this or `startPath` is required. */
  readonly startSymbol?: string
  readonly goal?: string
  readonly repoHint?: string | null
  /** Per-call codebase inspection report token cap; falls back to the module default when omitted. */
  readonly codebaseInspectionReportTokenCap?: number
}

export async function runTraceFlow(input: TraceFlowInput): Promise<CodebaseInspectionReport> {
  const {
    tools,
    repos,
    startPath,
    startSymbol,
    goal,
    repoHint,
    codebaseInspectionReportTokenCap,
  } = input
  const handle = await emitToolCalled('trace_flow', {
    start_path: startPath,
    start_symbol: startSymbol,
    goal,
    repo_hint: repoHint,
  })

  const anchor = (startPath ?? startSymbol ?? '').trim()
  if (anchor.length === 0) {
    const result = finalizeCodebaseInspectionReport(
      emptyDraft({
        summary:
          'Pass either `start_path` or `start_symbol` to anchor the trace.',
        warnings: ['no anchor provided'],
      }),
      codebaseInspectionReportTokenCap,
    )
    await emitReportBuilt('trace_flow', result)
    await emitToolResult({
      handle,
      wrapperName: 'trace_flow',
      status: 'error',
      message: 'no anchor provided',
    })
    return result
  }

  const resolution = resolveRepoForWrapper({
    repos,
    hint: repoHint,
    allowAll: false,
  })
  if (resolution.ok !== true) {
    const message =
      resolution.ok === 'all'
        ? 'trace_flow operates on a single repo; pass `repo_hint`.'
        : resolution.message
    const summary =
      resolution.ok === 'clarify'
        ? `${message}. Pick one: ${resolution.candidates.map((c) => c.label).join(', ')}.`
        : `Could not resolve repo: ${message}`
    const result = finalizeCodebaseInspectionReport(
      emptyDraft({
        summary,
        warnings: [message],
      }),
      codebaseInspectionReportTokenCap,
    )
    await emitReportBuilt('trace_flow', result)
    await emitToolResult({
      handle,
      wrapperName: 'trace_flow',
      status: 'error',
      message,
    })
    return result
  }
  const target = resolution.repo

  // Walk downstream from the anchor. We prefer a Cypher query that
  // walks ONLY CALLS edges (variable length 1..N). That gives a
  // call-graph trace without the IMPORTS noise gitnexus_impact mixes
  // in — IMPORTS reach EVERYTHING the file transitively pulls, which
  // is rarely what the user means by "follow the flow." When Cypher
  // returns rows, we use them. When it returns nothing or errors
  // (gitnexus version pre-cypher, anchor not in the graph, etc.), we
  // fall back to the broader impact walk so the wrapper still produces
  // something useful instead of an empty trace.
  const warnings: string[] = []
  let rows: readonly GitnexusImpactRow[] = []
  let usedStrategy: 'cypher' | 'impact' | 'none' = 'none'
  const cypherRows = await tryCypherCallsTrace({
    tools,
    repo: target.label,
    anchor,
    isFileAnchor: !!startPath,
  })
  if (cypherRows.ok && cypherRows.rows.length > 0) {
    rows = cypherRows.rows
    usedStrategy = 'cypher'
  } else {
    if (!cypherRows.ok) {
      warnings.push(
        `gitnexus_cypher fell back to gitnexus_impact: ${cypherRows.reason}`,
      )
    }
    try {
      const result = await withGitnexusCall(
        'trace_flow',
        'gitnexus_impact',
        {
          repo: target.label,
          target: anchor,
          direction: 'downstream',
          depth: TRACE_DEPTH_CAP,
        },
        () =>
          callGitnexusImpact({
            tools,
            repo: target.label,
            target: anchor,
            direction: 'downstream',
            depth: TRACE_DEPTH_CAP,
          }),
      )
      rows = result.rows
      if (result.rows.length > 0) usedStrategy = 'impact'
      if (result.partial) {
        warnings.push(
          'gitnexus_impact returned partial results: trace below is incomplete.',
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`gitnexus_impact failed: ${message}`)
    }
  }

  // Sort by ascending depth so context fetches focus on the hops
  // closest to the anchor — those are usually the most relevant for
  // understanding flow. Same-depth ties keep gitnexus's own ordering.
  const sorted = [...rows].sort((a, b) => a.depth - b.depth)

  const nodes: CodebaseInspectionReportGraphNode[] = sorted.map((r, i) => ({
    id: `${r.path}#${i}`,
    kind: 'file',
    path: r.path,
    name: r.path.split('/').pop() ?? r.path,
  }))

  // Naive edges: connect anchor → all depth-1 hops, then each
  // depth-N hop → the previous depth's nodes. Approximation;
  // gitnexus_impact doesn't expose the exact parent-child links in
  // its result shape.
  const edges: CodebaseInspectionReportGraphEdge[] = []
  const anchorId = `__anchor__:${anchor}`
  if (sorted.length > 0) {
    const byDepth = new Map<number, CodebaseInspectionReportGraphNode[]>()
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i]!
      const node = nodes[i]!
      const arr = byDepth.get(row.depth) ?? []
      arr.push(node)
      byDepth.set(row.depth, arr)
    }
    const depths = [...byDepth.keys()].sort((a, b) => a - b)
    for (let i = 0; i < depths.length; i++) {
      const here = byDepth.get(depths[i]!)!
      const parents =
        i === 0
          ? [{ id: anchorId } as CodebaseInspectionReportGraphNode]
          : byDepth.get(depths[i - 1]!)!
      for (const child of here) {
        for (const parent of parents) {
          edges.push({ from: parent.id, to: child.id, kind: 'reaches' })
        }
      }
    }
  }

  // Fetch context for the closest-and-most-relevant hops only.
  const fetchTargets = sorted
    .filter((r) => r.depth <= CONTEXT_DEPTH_CAP)
    .slice(0, CONTEXT_FETCH_CAP)

  // Read the body of each top hop directly from disk. gitnexus_context
  // is graph-only — for file content we always slice the source.
  const files: CodebaseInspectionReportFile[] = []
  for (const row of fetchTargets) {
    const chunk = await readFileChunkFromDisk({
      repo: target,
      filePath: row.path,
    })
    const chunks: CodebaseInspectionReportChunk[] = chunk
      ? [
          {
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            content: chunk.content,
          },
        ]
      : []
    files.push({
      repo_id: target.repo_id,
      repo_label: target.label,
      path: row.path,
      language: chunk?.language ?? 'unknown',
      chunks,
      why: `depth ${row.depth} from anchor "${anchor}"`,
    })
    if (!chunk) {
      warnings.push(`couldn't read ${row.path} from disk`)
    }
  }

  const goalSuffix = goal ? ` toward goal "${goal}"` : ''
  const strategySuffix =
    usedStrategy === 'cypher'
      ? ' (via CALLS-edge cypher walk)'
      : usedStrategy === 'impact'
        ? ' (via gitnexus_impact walk)'
        : ''
  const summary =
    sorted.length === 0
      ? `No downstream hops found for "${anchor}" in repo ${target.label}${goalSuffix}.`
      : `Traced ${sorted.length} downstream hop(s) from "${anchor}" in repo ${target.label}${goalSuffix}${strategySuffix}; fetched context for ${files.length} closest file(s).`

  const report = finalizeCodebaseInspectionReport(
    {
      wrapper: 'trace_flow',
      summary,
      intent: 'trace',
      expansions: [anchor],
      files,
      graph_subset: { nodes, edges },
      cross_repo_relationships: [],
      warnings,
      resolved_repo: {
        repo_id: target.repo_id,
        label: target.label,
        matched_signal: resolution.matched_signal,
      },
      confidence:
        nodes.length >= 5 ? 'high' : nodes.length >= 1 ? 'medium' : 'low',
    },
    codebaseInspectionReportTokenCap,
  )

  await emitReportBuilt('trace_flow', report)
  await emitToolResult({
    handle,
    wrapperName: 'trace_flow',
    status: warnings.length > 0 ? 'fallback' : 'ok',
    ...(warnings.length > 0 ? { message: warnings[0] } : {}),
  })
  return report
}

function emptyDraft(args: {
  summary: string
  warnings?: readonly string[]
}): CodebaseInspectionReportDraft {
  return {
    wrapper: 'trace_flow',
    summary: args.summary,
    intent: 'trace',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
    warnings: args.warnings,
  }
}

/**
 * Try a Cypher-driven CALLS-only walk via `gitnexus_cypher`. Variable-
 * length match `*1..N` with an `ALL(rel IN r WHERE rel.type = 'CALLS')`
 * predicate gives a precise call-graph trace that skips IMPORTS noise.
 *
 * Returns `{ ok: true, rows }` on success (rows projected to the
 * `GitnexusImpactRow` shape so the rest of `trace_flow` doesn't need a
 * branch). Returns `{ ok: false, reason }` when the cypher path can't
 * deliver a result (tool missing, query error, malformed rows). The
 * caller falls back to `gitnexus_impact` on `ok: false`.
 *
 * Escapes single quotes in `anchor` by doubling them — Cypher's string
 * literal escape. The anchor itself is LLM-supplied (path or symbol
 * name), so defensive escaping prevents an accidentally-broken query
 * even though we trust the LLM not to inject Cypher fragments.
 */
async function tryCypherCallsTrace(args: {
  tools: ToolDict
  repo: string
  anchor: string
  isFileAnchor: boolean
}): Promise<
  | { ok: true; rows: readonly GitnexusImpactRow[] }
  | { ok: false; reason: string }
> {
  const { tools, repo, anchor, isFileAnchor } = args
  if (!tools['gitnexus_cypher']) {
    return { ok: false, reason: 'gitnexus_cypher not mounted' }
  }
  const escaped = anchor.replace(/'/g, "''")
  // Variable-length CALLS walk. `*1..N` caps the hop count at
  // `TRACE_DEPTH_CAP`; the `ALL(...)` predicate constrains every edge
  // in the path to be a CALLS relation (no IMPORTS / CONTAINS / etc.).
  // We anchor on `File.filePath` for path-shaped anchors (gitnexus
  // stores file paths on the `filePath` property, NOT `path`) and on
  // `name` for symbol-shaped anchors. Order by depth ascending so the
  // closest hops surface first — the wrapper's context-fetch logic
  // takes the top N.
  const anchorMatch = isFileAnchor
    ? `(start:File {filePath: '${escaped}'})`
    : `(start {name: '${escaped}'})`
  const query = `MATCH p = ${anchorMatch}-[r:CodeRelation*1..${TRACE_DEPTH_CAP}]->(end)
WHERE ALL(rel IN r WHERE rel.type = 'CALLS')
RETURN end.filePath AS path, end.name AS name, length(p) AS depth
ORDER BY depth ASC
LIMIT 50`
  try {
    const result = await withGitnexusCall(
      'trace_flow',
      'gitnexus_cypher',
      { repo, query },
      () => callGitnexusCypher({ tools, repo, query }),
    )
    if (result.rowCount === 0) {
      return { ok: false, reason: 'cypher returned no rows' }
    }
    const rows: GitnexusImpactRow[] = []
    for (const row of result.rows) {
      const path = (row['path'] ?? '').trim()
      if (!path) continue
      const depthRaw = (row['depth'] ?? '').trim()
      const depth = Number(depthRaw)
      rows.push({
        repo,
        path,
        direction: 'downstream',
        depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
        confidence: 'high',
        reason: row['name']
          ? `CALLS path to ${row['name']} (cypher)`
          : 'CALLS path (cypher)',
        // Cypher walk constrains every edge to be CALLS by predicate,
        // so we know the edge type for the synthesized row.
        relationType: 'CALLS',
      })
    }
    if (rows.length === 0) {
      return { ok: false, reason: 'cypher rows did not project to paths' }
    }
    return { ok: true, rows }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message }
  }
}
