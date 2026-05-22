/**
 * `assess_change_impact` wrapper (`docs/ARCHITECTURE.md §10`).
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
 * Cross-repo expansion ("always-explain-bounds" rule, baked into code):
 * for every operator-curated `repo_relationships`
 * row originating from the resolved repo, run gitnexus_impact upstream
 * on each anchor against the target repo too. Hits are added to
 * `mini_repo.cross_repo_relationships` AND folded into `files` with the
 * cross-repo target's label.
 *
 * `add` change_kind: blast radius is empty by definition (nothing
 * existing references the new code yet). We surface the empty array
 * with a clear summary instead of skipping the call.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import type { AttachedRepo } from '@agent-bridge/shared'

import {
  callGitnexusApiImpact,
  callGitnexusImpact,
  type GitnexusApiImpactConsumer,
  type GitnexusImpactResult,
  type GitnexusImpactRow,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import {
  loadIncomingRepoRelationships,
  loadOutgoingRepoRelationships,
  type CrossRepoRelationshipWithTarget,
} from '../repo-relationships.js'
import { resolveRepoForWrapper } from '../run-context.js'
import type {
  MiniRepo,
  MiniRepoCrossRepoRelationship,
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
  const { tools, repos, db, agentId, anchors, changeKind, repoHint } = input

  const handle = await emitToolCalled('assess_change_impact', {
    anchors,
    change_kind: changeKind,
    repo_hint: repoHint,
  })

  const trimmedAnchors = anchors
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  if (trimmedAnchors.length === 0) {
    const result = finalizeMiniRepo(
      emptyDraft({
        summary: 'Pass at least one file path or symbol name to assess.',
        warnings: ['no anchors'],
      }),
    )
    await emitMinirepoBuilt('assess_change_impact', result)
    await emitToolResult({
      handle,
      wrapperName: 'assess_change_impact',
      status: 'error',
      message: 'no anchors',
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
        ? 'assess_change_impact operates on a single primary repo; pass `repo_hint`.'
        : resolution.message
    const summary =
      resolution.ok === 'clarify'
        ? `${message}. Pick one: ${resolution.candidates.map((c) => c.label).join(', ')}.`
        : `Could not resolve repo: ${message}`
    const result = finalizeMiniRepo(
      emptyDraft({
        summary,
        warnings: [message],
      }),
    )
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
      cross_repo_relationships: [],
      warnings: [],
      resolved_repo: {
        repo_id: target.repo_id,
        label: target.label,
        matched_signal: resolution.matched_signal,
      },
      // "add" is a deterministic empty-blast-radius result; high
      // confidence that there's nothing to find, not low confidence
      // that we missed something.
      confidence: 'high',
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
  // Track gitnexus's own envelope verdict per (anchor, direction) so
  // the wrapper summary can surface "CRITICAL" / "partial" without
  // reinventing the heuristic. First non-null `risk` wins. `partial`
  // is OR'd across calls — any partial result taints the whole.
  let envelopeRisk: GitnexusImpactResult['risk'] = null
  let envelopePartial = false
  const envelopeProcesses = new Set<string>()
  for (const anchor of trimmedAnchors) {
    for (const direction of ['upstream', 'downstream'] as const) {
      try {
        const result = await withGitnexusCall(
          'assess_change_impact',
          'gitnexus_impact',
          {
            repo: target.label,
            target: anchor,
            direction,
            depth: IMPACT_DEPTH,
          },
          () =>
            callGitnexusImpact({
              tools,
              repo: target.label,
              target: anchor,
              direction,
              depth: IMPACT_DEPTH,
            }),
        )
        sameRepoRows.push({ anchor, direction, rows: result.rows })
        if (!envelopeRisk && result.risk) envelopeRisk = result.risk
        if (result.partial) envelopePartial = true
        for (const p of result.affectedProcesses) envelopeProcesses.add(p)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `gitnexus_impact ${direction} failed for "${anchor}": ${message}`,
        )
      }
    }
  }
  if (envelopePartial) {
    warnings.push(
      'gitnexus_impact returned partial results: traversal failed mid-walk and the impact list below is incomplete.',
    )
  }

  // API-shape blast radius. `gitnexus_impact` only walks the call
  // graph; it misses consumers that READ response fields or HIT the
  // route from a different repo without a call edge in the AST. The
  // `gitnexus_api_impact` tool fills that gap by joining route_map +
  // shape_check + impact data: it finds the route's consumers, what
  // response keys they access, and whether their reads match the
  // route's current shape. We probe each anchor as a route, then as a
  // handler file path. Both calls are best-effort: any anchor that's
  // not API-shaped silently returns no consumers and we move on.
  type ApiImpactRow = { consumer: GitnexusApiImpactConsumer; anchor: string }
  const apiConsumers: ApiImpactRow[] = []
  const apiRouteSummaries: string[] = []
  let apiMismatchCount = 0
  for (const anchor of trimmedAnchors) {
    // Heuristic: only call api_impact for anchors that COULD be an API
    // surface. A bare symbol like `computeTotal` would never match a
    // route and the call costs ~50 ms anyway, so we skip it. Path-
    // shaped anchors (start with `/`) get tried as routes; file-
    // shaped anchors (contain a path separator + a code extension)
    // get tried as handler files.
    const isRouteShape = anchor.startsWith('/')
    const isFileShape =
      !isRouteShape &&
      /[\\/]/.test(anchor) &&
      /\.(ts|tsx|js|jsx|py|rb|go|java|kt|rs|php|cs|mjs|cjs)$/i.test(anchor)
    if (!isRouteShape && !isFileShape) continue
    try {
      const apiResult = await withGitnexusCall(
        'assess_change_impact',
        'gitnexus_api_impact',
        isRouteShape
          ? { repo: target.label, route: anchor }
          : { repo: target.label, file: anchor },
        () =>
          callGitnexusApiImpact({
            tools,
            repo: target.label,
            ...(isRouteShape ? { route: anchor } : { file: anchor }),
          }),
      )
      for (const consumer of apiResult.consumers) {
        apiConsumers.push({ consumer, anchor })
        if (consumer.status === 'mismatch') apiMismatchCount += 1
      }
      for (const r of apiResult.routes) {
        apiRouteSummaries.push(r.route)
        // Critical safety: when gitnexus could only inspect one HTTP
        // method export from a multi-method handler file, the
        // middleware list is incomplete. Surface as a warning so the
        // IDE's coding agent doesn't confidently claim "no auth" when
        // POST might in fact be auth-protected.
        if (r.middlewareDetection === 'partial') {
          warnings.push(
            `gitnexus_api_impact: partial middleware detection on ${r.route}. ${r.middlewareNote ?? 'Other HTTP methods may use different middleware.'}`,
          )
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`gitnexus_api_impact failed for "${anchor}": ${message}`)
    }
  }

  // Cross-repo expansion: load operator-curated relationships originating from
  // the target repo, fan upstream on each anchor against each target.
  // We use upstream because relationships semantically read
  // "<from> deploys-to <to>" / "<from> calls <to>" — meaning code in
  // <to> depends on or consumes <from>'s outputs. Asking gitnexus
  // "what in <to> would be affected by changing <anchor> in <from>?"
  // requires running upstream impact in the TARGET repo using the
  // anchor name as the symbol. Not perfect (relies on shared symbol
  // names across repos) but the operator's repo_relationships block and the
  // LLM's use of `related_repos` cover the gaps.
  const crossEdges: MiniRepoCrossRepoRelationship[] = []
  const crossHits: Array<{
    repo: AttachedRepo
    rows: readonly GitnexusImpactRow[]
  }> = []

  // Walk both relationship directions. Outgoing relationships point AT consumers the
  // change reaches; incoming relationships point AT us from callers/importers.
  // Without the incoming sweep, an asymmetric relationship like
  // `frontend --calls--> backend` is invisible when the change is in
  // `backend` (backend has no outgoing relationships to frontend, but frontend
  // is still affected). Dedupe by (from_repo, to_repo) — operators
  // sometimes record a logical relationship as two opposing relationships and
  // we want one cross-repo expansion per pair.
  let outgoingEdges: CrossRepoRelationshipWithTarget[] = []
  let incomingEdges: CrossRepoRelationshipWithTarget[] = []
  try {
    outgoingEdges = await loadOutgoingRepoRelationships({
      db,
      agentId,
      fromRepoId: target.repo_id,
      attached: repos,
    })
  } catch (err) {
    warnings.push(
      `loadOutgoingRepoRelationships failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    incomingEdges = await loadIncomingRepoRelationships({
      db,
      agentId,
      toRepoId: target.repo_id,
      attached: repos,
    })
  } catch (err) {
    warnings.push(
      `loadIncomingRepoRelationships failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const expansionTargets = new Map<string, CrossRepoRelationshipWithTarget>()
  for (const e of [...outgoingEdges, ...incomingEdges]) {
    const key = `${e.edge.from_repo}::${e.edge.to_repo}`
    if (!expansionTargets.has(key)) expansionTargets.set(key, e)
  }

  for (const { edge, target: edgeTarget } of expansionTargets.values()) {
    crossEdges.push(edge)
    if (edgeTarget.status !== 'ready') continue
    for (const anchor of trimmedAnchors) {
      try {
        const result = await withGitnexusCall(
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
        if (result.rows.length > 0) {
          crossHits.push({ repo: edgeTarget, rows: result.rows })
        }
        if (result.partial) {
          // Emit a per-target warning every time so the operator sees
          // which cross-repo target was truncated. The earlier code
          // gated on `!envelopePartial` which silently dropped second-
          // and-later partial signals once any prior call (same-repo
          // or cross-repo) had already flipped the flag.
          envelopePartial = true
          warnings.push(
            `gitnexus_impact returned partial results for cross-repo "${edgeTarget.label}".`,
          )
        }
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
  // Project api_impact consumers into the picks map using the same
  // claim() invariant (lowest depth wins). We use depth=1 because a
  // consumer that hits the route IS a direct dependent.
  //
  // Repo attribution: gitnexus's `apiImpact` operates against a single
  // repo's graph and does NOT emit a `repo` field on consumer rows —
  // the response shape's `consumers` array carries only `name`, `file`,
  // and `accesses`. So an empty `consumer.repo` (the typical case) is
  // the SAME-repo signal, not the cross-repo signal. We default to the
  // target repo on empty and only mark cross-repo when gitnexus did
  // emit a distinct repo name. The previous logic flipped this and
  // tagged every consumer as cross-repo.
  for (const { consumer, anchor } of apiConsumers) {
    const sameRepo = !consumer.repo || consumer.repo === target.label
    const consumerRepoId = sameRepo ? target.repo_id : `api:${consumer.repo}`
    const consumerRepoLabel = sameRepo ? target.label : consumer.repo
    const crossRepo = !sameRepo
    const key = `${consumerRepoId}::${consumer.path}`
    const existing = picks.get(key)
    // depth 1 outranks any existing higher-depth claim
    if (existing && existing.depth <= 1) continue
    const mismatchSuffix =
      consumer.status === 'mismatch' ? ' [shape mismatch]' : ''
    const confidenceSuffix =
      consumer.confidence === 'low' ? ' (low confidence attribution)' : ''
    picks.set(key, {
      repoId: consumerRepoId,
      repoLabel: consumerRepoLabel,
      path: consumer.path,
      depth: 1,
      direction: 'upstream',
      crossRepo,
      anchor: `${anchor}${mismatchSuffix}${confidenceSuffix}`,
    })
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

  // Summary explicitly names the cross-repo dimension
  // ("always-say-what-you-DID-NOT-check" rule, made deterministic).
  const sameRepoCount = files.filter((f) => f.repo_id === target.repo_id).length
  const crossCount = files.length - sameRepoCount
  const crossSummary =
    outgoingEdges.length === 0
      ? repos.length === 1
        ? 'Single repo attached; no cross-repo expansion applicable.'
        : `Agent has ${repos.length} repos but no repo_relationships originate from ${target.label}; cross-repo expansion skipped.`
      : crossCount === 0
        ? `Followed ${outgoingEdges.length} repo_relationship(s) from ${target.label}; no cross-repo consumers found.`
        : `Followed ${outgoingEdges.length} repo_relationship(s); ${crossCount} cross-repo consumer(s) included.`
  const apiSummary =
    apiConsumers.length === 0
      ? apiRouteSummaries.length > 0
        ? ` Considered ${apiRouteSummaries.length} matching API route(s); no consumers depend on them.`
        : ''
      : ` ${apiConsumers.length} API consumer(s) found${apiMismatchCount > 0 ? `, ${apiMismatchCount} with response-shape mismatch(es); read carefully` : ''}.`
  const riskSuffix = envelopeRisk ? ` Gitnexus risk: ${envelopeRisk}.` : ''
  const processSuffix =
    envelopeProcesses.size > 0
      ? ` Affected business flows: ${[...envelopeProcesses].slice(0, 5).join(', ')}${envelopeProcesses.size > 5 ? '…' : ''}.`
      : ''
  const partialSuffix = envelopePartial
    ? ' Result is PARTIAL: gitnexus traversal failed mid-walk.'
    : ''
  const summary = `${changeKind.toUpperCase()} of ${trimmedAnchors.length} anchor(s) in ${target.label}: ${sameRepoCount} same-repo + ${crossCount} cross-repo file(s) affected.${riskSuffix}${processSuffix} ${crossSummary}${apiSummary}${partialSuffix}`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'assess_change_impact',
    summary,
    intent: 'impact',
    expansions: trimmedAnchors,
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: crossEdges,
    warnings,
    resolved_repo: {
      repo_id: target.repo_id,
      label: target.label,
      matched_signal: resolution.matched_signal,
    },
    confidence:
      files.length >= 3 ? 'high' : files.length >= 1 ? 'medium' : 'low',
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
    cross_repo_relationships: [],
    warnings: args.warnings,
  }
}
