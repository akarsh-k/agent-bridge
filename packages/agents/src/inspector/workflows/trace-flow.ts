/**
 * `trace_flow` wrapper (`docs/ARCHITECTURE.md §10`).
 *
 * Walks the call/import graph from a starting anchor (file path or
 * symbol name) toward a goal. Returns a mini-repo whose `graph_subset`
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
 *   3. Each impact row becomes a `MiniRepoGraphNode`; consecutive
 *      depths produce edges between them.
 *   4. For the top-K (cap 6) closest hops, fetch `gitnexus_context` to
 *      stuff the file content into mini-repo chunks. Beyond depth 2
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
  callGitnexusImpact,
  type GitnexusImpactRow,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import { readFileChunkFromDisk } from '../read-source.js'
import { resolveRepoForWrapper } from '../run-context.js'
import type {
  MiniRepo,
  MiniRepoChunk,
  MiniRepoFile,
  MiniRepoGraphEdge,
  MiniRepoGraphNode,
} from '../types.js'
import {
  emitMinirepoBuilt,
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
}

export async function runTraceFlow(input: TraceFlowInput): Promise<MiniRepo> {
  const { tools, repos, startPath, startSymbol, goal, repoHint } = input
  const handle = await emitToolCalled('trace_flow', {
    start_path: startPath,
    start_symbol: startSymbol,
    goal,
    repo_hint: repoHint,
  })

  const anchor = (startPath ?? startSymbol ?? '').trim()
  if (anchor.length === 0) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Pass either `start_path` or `start_symbol` to anchor the trace.',
      warnings: ['no anchor provided'],
    }))
    await emitMinirepoBuilt('trace_flow', result)
    await emitToolResult({
      handle,
      wrapperName: 'trace_flow',
      status: 'error',
      message: 'no anchor provided',
    })
    return result
  }

  const resolution = resolveRepoForWrapper({ repos, hint: repoHint, allowAll: false })
  if (resolution.ok !== true) {
    const message =
      resolution.ok === 'all'
        ? 'trace_flow operates on a single repo; pass `repo_hint`.'
        : resolution.message
    const summary =
      resolution.ok === 'clarify'
        ? `${message}. Pick one: ${resolution.candidates.map((c) => c.label).join(', ')}.`
        : `Could not resolve repo: ${message}`
    const result = finalizeMiniRepo(emptyDraft({
      summary,
      warnings: [message],
    }))
    await emitMinirepoBuilt('trace_flow', result)
    await emitToolResult({
      handle,
      wrapperName: 'trace_flow',
      status: 'error',
      message,
    })
    return result
  }
  const target = resolution.repo

  // Walk downstream from the anchor. Failures here stop the trace —
  // there's no useful recovery (the alternative would be returning an
  // empty graph, which a caller would correctly read as "nothing to
  // trace" and possibly act on misleadingly).
  const warnings: string[] = []
  let rows: readonly GitnexusImpactRow[] = []
  try {
    rows = await withGitnexusCall(
      'trace_flow',
      'gitnexus_impact',
      { repo: target.label, target: anchor, direction: 'downstream', depth: TRACE_DEPTH_CAP },
      () =>
        callGitnexusImpact({
          tools,
          repo: target.label,
          target: anchor,
          direction: 'downstream',
          depth: TRACE_DEPTH_CAP,
        }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`gitnexus_impact failed: ${message}`)
  }

  // Sort by ascending depth so context fetches focus on the hops
  // closest to the anchor — those are usually the most relevant for
  // understanding flow. Same-depth ties keep gitnexus's own ordering.
  const sorted = [...rows].sort((a, b) => a.depth - b.depth)

  const nodes: MiniRepoGraphNode[] = sorted.map((r, i) => ({
    id: `${r.path}#${i}`,
    kind: 'file',
    path: r.path,
    name: r.path.split('/').pop() ?? r.path,
  }))

  // Naive edges: connect anchor → all depth-1 hops, then each
  // depth-N hop → the previous depth's nodes. Approximation;
  // gitnexus_impact doesn't expose the exact parent-child links in
  // its result shape.
  const edges: MiniRepoGraphEdge[] = []
  const anchorId = `__anchor__:${anchor}`
  if (sorted.length > 0) {
    const byDepth = new Map<number, MiniRepoGraphNode[]>()
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
          ? [{ id: anchorId } as MiniRepoGraphNode]
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
  const files: MiniRepoFile[] = []
  for (const row of fetchTargets) {
    const chunk = await readFileChunkFromDisk({ repo: target, filePath: row.path })
    const chunks: MiniRepoChunk[] = chunk
      ? [{ start_line: chunk.startLine, end_line: chunk.endLine, content: chunk.content }]
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
  const summary =
    sorted.length === 0
      ? `No downstream hops found for "${anchor}" in repo ${target.label}${goalSuffix}.`
      : `Traced ${sorted.length} downstream hop(s) from "${anchor}" in repo ${target.label}${goalSuffix}; fetched context for ${files.length} closest file(s).`

  const miniRepo = finalizeMiniRepo({
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
  })

  await emitMinirepoBuilt('trace_flow', miniRepo)
  await emitToolResult({
    handle,
    wrapperName: 'trace_flow',
    status: warnings.length > 0 ? 'fallback' : 'ok',
    ...(warnings.length > 0 ? { message: warnings[0] } : {}),
  })
  return miniRepo
}

function emptyDraft(args: {
  summary: string
  warnings?: readonly string[]
}): MiniRepoDraft {
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
