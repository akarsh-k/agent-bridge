/**
 * `assess_change_impact` wrapper (`docs/ARCHITECTURE.md §10` Phase E E2).
 *
 * Computes blast radius for a proposed change. Inputs are the changed
 * file(s) or symbol(s) plus a `change_kind` (rename / remove / modify /
 * add). Outputs a mini-repo whose `files` list each affected path
 * with `why` carrying the classification:
 *
 *   - `direct (depth=1, upstream)`   — code that imports/calls the change directly
 *   - `direct (depth=1, downstream)` — code the change reaches directly
 *   - `transitive (depth=N)`          — N hops away
 *
 * Cross-repo expansion (the v1-system-skill §10.5 "always-explain-bounds"
 * rule, baked into code now): for every operator-curated `repo_edges`
 * row originating from the resolved repo, run gitnexus_impact upstream
 * on each anchor against the target repo too. Hits are added to
 * `mini_repo.cross_repo_edges` AND folded into `files` with the
 * cross-repo target's label.
 *
 * `add` change_kind: blast radius is empty by definition (nothing
 * existing references the new code yet). We surface the empty array
 * with a clear summary instead of skipping the call.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import type { AttachedRepo } from '@agent-bridge/shared'

import {
  callGitnexusImpact,
  type GitnexusImpactRow,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import {
  loadIncomingRepoEdges,
  loadOutgoingRepoEdges,
  type CrossRepoEdgeWithTarget,
} from '../repo-edges.js'
import { resolveRepoFromHint } from '../repo-resolve.js'
import type {
  MiniRepo,
  MiniRepoCrossRepoEdge,
  MiniRepoFile,
} from '../types.js'
import {
  emitMinirepoBuilt,
  emitToolCalled,
  emitToolResult,
  withGitnexusCall,
} from '../wrapper-telemetry.js'

const IMPACT_DEPTH = 3 as const

export type ChangeKind = 'rename' | 'remove' | 'modify' | 'add'

export interface AssessChangeImpactInput {
  readonly tools: ToolDict
  readonly repos: readonly AttachedRepo[]
  readonly db: AgentBridgeDb
  readonly agentId: string
  /** File path(s) and/or symbol name(s) the change touches. */
  readonly anchors: readonly string[]
  readonly changeKind: ChangeKind
  readonly repoHint?: string | null
}

export async function runAssessChangeImpact(
  input: AssessChangeImpactInput,
): Promise<MiniRepo> {
  const {
    tools,
    repos,
    db,
    agentId,
    anchors,
    changeKind,
    repoHint,
  } = input

  const handle = await emitToolCalled('assess_change_impact', {
    anchors,
    change_kind: changeKind,
    repo_hint: repoHint,
  })

  const trimmedAnchors = anchors
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  if (trimmedAnchors.length === 0) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Pass at least one file path or symbol name to assess.',
      warnings: ['no anchors'],
    }))
    await emitMinirepoBuilt('assess_change_impact', result)
    await emitToolResult({
      handle,
      wrapperName: 'assess_change_impact',
      status: 'error',
      message: 'no anchors',
    })
    return result
  }

  const resolution = resolveRepoFromHint({ repos, hint: repoHint, allowAll: false })
  if (resolution.ok === false || resolution.ok === 'all') {
    const message =
      resolution.ok === 'all'
        ? 'assess_change_impact operates on a single primary repo; pass `repo_hint`.'
        : resolution.message
    const result = finalizeMiniRepo(emptyDraft({
      summary: `Could not resolve repo: ${message}`,
      warnings: [message],
    }))
    await emitMinirepoBuilt('assess_change_impact', result)
    await emitToolResult({
      handle,
      wrapperName: 'assess_change_impact',
      status: 'error',
      message,
    })
    return result
  }
  const target = resolution.repo

  const warnings: string[] = []

  // `add` is structurally empty. Emit a clean summary + empty mini-repo
  // rather than calling gitnexus on a path that doesn't exist yet.
  if (changeKind === 'add') {
    const miniRepo = finalizeMiniRepo({
      wrapper: 'assess_change_impact',
      summary: `Change kind "add" has no blast radius. nothing existing references "${trimmedAnchors.join('", "')}" yet in repo ${target.label}.`,
      intent: 'impact',
      expansions: trimmedAnchors,
      files: [],
      graph_subset: { nodes: [], edges: [] },
      cross_repo_edges: [],
      warnings: [],
    })
    await emitMinirepoBuilt('assess_change_impact', miniRepo)
    await emitToolResult({
      handle,
      wrapperName: 'assess_change_impact',
      status: 'ok',
    })
    return miniRepo
  }

  // Same-repo blast radius. We always run BOTH directions:
  //   - upstream  → callers/importers (what depends on me)
  //   - downstream → callees (what I touch). For `remove`/`rename` this
  //     is less interesting than upstream, but it's cheap and the LLM
  //     can decide which dimension to surface.
  const sameRepoRows: Array<{
    anchor: string
    direction: 'upstream' | 'downstream'
    rows: readonly GitnexusImpactRow[]
  }> = []
  for (const anchor of trimmedAnchors) {
    for (const direction of ['upstream', 'downstream'] as const) {
      try {
        const rows = await withGitnexusCall(
          'assess_change_impact',
          'gitnexus_impact',
          { repo: target.label, target: anchor, direction, depth: IMPACT_DEPTH },
          () =>
            callGitnexusImpact({
              tools,
              repo: target.label,
              target: anchor,
              direction,
              depth: IMPACT_DEPTH,
            }),
        )
        sameRepoRows.push({ anchor, direction, rows })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `gitnexus_impact ${direction} failed for "${anchor}": ${message}`,
        )
      }
    }
  }

  // Cross-repo expansion: load operator-curated edges originating from
  // the target repo, fan upstream on each anchor against each target.
  // We use upstream because edges semantically read
  // "<from> deploys-to <to>" / "<from> calls <to>" — meaning code in
  // <to> depends on or consumes <from>'s outputs. Asking gitnexus
  // "what in <to> would be affected by changing <anchor> in <from>?"
  // requires running upstream impact in the TARGET repo using the
  // anchor name as the symbol. Not perfect (relies on shared symbol
  // names across repos) but the operator's repo_edges block and the
  // LLM's use of `related_repos` cover the gaps.
  const crossEdges: MiniRepoCrossRepoEdge[] = []
  const crossHits: Array<{
    repo: AttachedRepo
    rows: readonly GitnexusImpactRow[]
  }> = []

  // Walk both edge directions. Outgoing edges point AT consumers the
  // change reaches; incoming edges point AT us from callers/importers.
  // Without the incoming sweep, an asymmetric edge like
  // `frontend --calls--> backend` is invisible when the change is in
  // `backend` (backend has no outgoing edges to frontend, but frontend
  // is still affected). Dedupe by (from_repo, to_repo) — operators
  // sometimes record a logical relationship as two opposing edges and
  // we want one cross-repo expansion per pair.
  let outgoingEdges: CrossRepoEdgeWithTarget[] = []
  let incomingEdges: CrossRepoEdgeWithTarget[] = []
  try {
    outgoingEdges = await loadOutgoingRepoEdges({
      db,
      agentId,
      fromRepoId: target.repo_id,
      attached: repos,
    })
  } catch (err) {
    warnings.push(
      `loadOutgoingRepoEdges failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    incomingEdges = await loadIncomingRepoEdges({
      db,
      agentId,
      toRepoId: target.repo_id,
      attached: repos,
    })
  } catch (err) {
    warnings.push(
      `loadIncomingRepoEdges failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const expansionTargets = new Map<string, CrossRepoEdgeWithTarget>()
  for (const e of [...outgoingEdges, ...incomingEdges]) {
    const key = `${e.edge.from_repo}::${e.edge.to_repo}`
    if (!expansionTargets.has(key)) expansionTargets.set(key, e)
  }

  for (const { edge, target: edgeTarget } of expansionTargets.values()) {
    crossEdges.push(edge)
    if (edgeTarget.status !== 'ready') continue
    for (const anchor of trimmedAnchors) {
      try {
        const rows = await withGitnexusCall(
          'assess_change_impact',
          'gitnexus_impact',
          {
            repo: edgeTarget.label,
            target: anchor,
            direction: 'upstream',
            depth: IMPACT_DEPTH,
          },
          () =>
            callGitnexusImpact({
              tools,
              repo: edgeTarget.label,
              target: anchor,
              direction: 'upstream',
              depth: IMPACT_DEPTH,
            }),
        )
        if (rows.length > 0) crossHits.push({ repo: edgeTarget, rows })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `cross-repo gitnexus_impact failed for ${edgeTarget.label}: ${message}`,
        )
      }
    }
  }

  // Flatten everything into mini-repo files. Dedupe by (repo_id, path),
  // keeping the lowest depth (closest hit). One file row per unique
  // path; the `why` carries direction + depth from the winning hit.
  type Pick = {
    repoId: string
    repoLabel: string
    path: string
    depth: number
    direction: 'upstream' | 'downstream'
    crossRepo: boolean
    anchor: string
  }
  const picks = new Map<string, Pick>()
  const claim = (
    anchor: string,
    repo: AttachedRepo,
    row: GitnexusImpactRow,
    direction: 'upstream' | 'downstream',
    crossRepo: boolean,
  ): void => {
    const key = `${repo.repo_id}::${row.path}`
    const existing = picks.get(key)
    if (existing && existing.depth <= row.depth) return
    picks.set(key, {
      repoId: repo.repo_id,
      repoLabel: repo.label,
      path: row.path,
      depth: row.depth,
      direction,
      crossRepo,
      anchor,
    })
  }
  for (const { anchor, direction, rows } of sameRepoRows) {
    for (const row of rows) claim(anchor, target, row, direction, false)
  }
  for (const { repo, rows } of crossHits) {
    for (const row of rows) claim('', repo, row, 'upstream', true)
  }

  const files: MiniRepoFile[] = [...picks.values()]
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.repoLabel.localeCompare(b.repoLabel) ||
        a.path.localeCompare(b.path),
    )
    .map((p) => {
      const classification = p.depth === 1 ? 'direct' : 'transitive'
      const scope = p.crossRepo ? ' (cross-repo)' : ''
      const reason = p.anchor
        ? `${classification} (depth=${p.depth}, ${p.direction}) from "${p.anchor}"${scope}`
        : `${classification} (depth=${p.depth}, ${p.direction})${scope}`
      return {
        repo_id: p.repoId,
        repo_label: p.repoLabel,
        path: p.path,
        language: 'unknown',
        chunks: [],
        why: reason,
      } satisfies MiniRepoFile
    })

  // Summary explicitly names the cross-repo dimension (the v1 skill's
  // "always-say-what-you-DID-NOT-check" rule, made deterministic).
  const sameRepoCount = files.filter((f) => f.repo_id === target.repo_id).length
  const crossCount = files.length - sameRepoCount
  const crossSummary =
    outgoingEdges.length === 0
      ? repos.length === 1
        ? 'Single repo attached; no cross-repo expansion applicable.'
        : `Agent has ${repos.length} repos but no repo_edges originate from ${target.label}; cross-repo expansion skipped.`
      : crossCount === 0
        ? `Followed ${outgoingEdges.length} repo_edge(s) from ${target.label}; no cross-repo consumers found.`
        : `Followed ${outgoingEdges.length} repo_edge(s); ${crossCount} cross-repo consumer(s) included.`
  const summary = `${changeKind.toUpperCase()} of ${trimmedAnchors.length} anchor(s) in ${target.label}: ${sameRepoCount} same-repo + ${crossCount} cross-repo file(s) affected. ${crossSummary}`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'assess_change_impact',
    summary,
    intent: 'impact',
    expansions: trimmedAnchors,
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: crossEdges,
    warnings,
  })

  await emitMinirepoBuilt('assess_change_impact', miniRepo)
  await emitToolResult({
    handle,
    wrapperName: 'assess_change_impact',
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
    wrapper: 'assess_change_impact',
    summary: args.summary,
    intent: 'impact',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings: args.warnings,
  }
}
