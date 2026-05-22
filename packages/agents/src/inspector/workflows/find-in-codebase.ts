/**
 * `find_in_codebase` wrapper. first deterministic workflow
 * (`docs/ARCHITECTURE.md §10`).
 *
 * Inputs:
 *   - `query`: free-form search string.
 *   - `repo_hint?`: friendly label of an attached repo. omit to use all
 *     when the agent has multiple repos AND the wrapper allows it.
 *
 * Behaviour in deterministic mode (no LLM expansion):
 *   1. Resolve the hint to a single repo, an "all" fan-out, or a
 *      "needs clarification" message.
 *   2. Call `gitnexus_query` per resolved repo with the raw query.
 *      Gitnexus's hybrid search (BM25 + semantic + RRF) does the heavy
 *      lifting — we don't need a separate vector path here (`§3a`).
 *   3. Take the top-N hits, fold them into mini-repo `files`, using
 *      gitnexus's snippet as a single chunk per hit.
 *   4. `expansions: [query]` (LLM expansion replaces this when wired).
 *
 * Skipped on purpose for now (will land in later iterations):
 *   - LLM term expansion.
 *   - `gitnexus_context` round-trip for full file slices.
 *   - `graph_subset` (`trace_flow`).
 *   - `cross_repo_relationships` (`assess_change_impact`).
 */

import { readdir } from 'node:fs/promises'

import type { MastraModelConfig } from '@mastra/core/llm'
import type {
  AttachedRepo,
  InspectorFallbackPayload,
  InspectorGitnexusCalledPayload,
  InspectorGitnexusResultPayload,
  InspectorLlmCalledPayload,
  InspectorLlmResultPayload,
  InspectorToolCalledPayload,
  InspectorToolResultPayload,
} from '@agent-bridge/shared'
import { INSPECTOR_PREVIEW_BYTES_CAP } from '@agent-bridge/shared'

import { repoSourceDir } from '@agent-bridge/shared/paths'

import { classifyAndExpand } from '../expand.js'
import {
  callGitnexusQuery,
  callGitnexusRouteMap,
  type GitnexusQueryHit,
  type GitnexusRoute,
  type ToolDict,
} from '../gitnexus-callers.js'
import { keywordSearch, type KeywordHit } from '../keyword-search.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import type { RepoResolveResult } from '../repo-resolve.js'
import {
  emitInspectorEvent,
  getInspectorRunContext,
  previewJson,
  resolveRepoForWrapper,
} from '../run-context.js'
import type { MiniRepo, MiniRepoChunk, MiniRepoFile } from '../types.js'
import { emitMinirepoBuilt, withKeywordCall } from '../wrapper-telemetry.js'

export interface FindInCodebaseInput {
  /** Live gitnexus tool dict. shared with all wrappers in one agent. */
  readonly tools: ToolDict
  /** Agent's attached repos, pre-loaded. */
  readonly repos: readonly AttachedRepo[]
  /** User query forwarded by the LLM via the wrapper-tool input. */
  readonly query: string
  /** Optional friendly-label hint. */
  readonly repoHint?: string | null
  /** Cap files in mini-repo. default 12. */
  readonly maxFiles?: number
  /**
   * Agent's model config — drives the in-wrapper LLM term-expansion call
   * When omitted, the wrapper falls back to the raw query as
   * the only expansion (deterministic mode).
   */
  readonly modelConfig?: MastraModelConfig
}

/**
 * Runs the workflow and returns one mini-repo. Never throws on a
 * "no results" path — empty `files` + a `summary` explaining the miss
 * is a legitimate outcome.
 */
export async function runFindInCodebase(
  input: FindInCodebaseInput,
): Promise<MiniRepo> {
  const { tools, repos, query, repoHint, maxFiles = 12, modelConfig } = input

  const ctx = getInspectorRunContext()
  const runId = ctx?.runId ?? ''
  const startedAt = Date.now()

  // tool.called: every wrapper invocation gets a start frame.
  const argsPreview = previewJson(
    { query, repo_hint: repoHint, max_files: maxFiles },
    INSPECTOR_PREVIEW_BYTES_CAP,
  )
  await emitInspectorEvent('inspector.tool.called', {
    runId,
    wrapperName: 'find_in_codebase',
    argsPreview: argsPreview.preview,
    truncated: argsPreview.truncated,
  } satisfies InspectorToolCalledPayload)

  const trimmed = query.trim()
  if (trimmed.length === 0) {
    const result = finalizeMiniRepo(
      emptyDraft({
        summary: 'Empty query — nothing to search for.',
        warnings: ['empty query'],
      }),
    )
    await emitToolResult({
      runId,
      durationMs: Date.now() - startedAt,
      status: 'error',
      message: 'empty query',
    })
    return result
  }

  const resolution = resolveRepoForWrapper({
    repos,
    hint: repoHint,
    allowAll: true,
  })

  if (resolution.ok === false || resolution.ok === 'clarify') {
    const result = finalizeMiniRepo(
      emptyDraft({
        summary: buildResolutionFailureSummary(resolution),
        warnings: [resolution.message],
      }),
    )
    await emitToolResult({
      runId,
      durationMs: Date.now() - startedAt,
      status: 'error',
      message: resolution.message,
    })
    return result
  }

  const targets: readonly AttachedRepo[] =
    resolution.ok === true ? [resolution.repo] : resolution.repos

  // Term expansion + intent classification. Hard fallback to
  // raw query keeps the run alive on any LLM hiccup. Skipped entirely
  // when no `modelConfig` is supplied (deterministic mode,
  // useful for tests).
  const warnings: string[] = []
  let expansions: readonly string[] = [trimmed]
  let toolStatus: InspectorToolResultPayload['status'] = 'ok'
  if (modelConfig) {
    // Compute languages once and reuse for both the prompt preview
    // and the expand call. Detection involves an `fs.readdir` per
    // repo's source dir; the in-memory cache makes the second call
    // free, but we still want to avoid two awaits in a single block.
    const languages = await deriveLanguagesHint(targets)
    const promptPreview = previewJson(
      { query: trimmed, languages },
      INSPECTOR_PREVIEW_BYTES_CAP,
    )
    const llmModel =
      typeof modelConfig === 'object' && modelConfig !== null
        ? String(
            (modelConfig as Record<string, unknown>)['modelId'] ??
              (modelConfig as Record<string, unknown>)['id'] ??
              'unknown',
          )
        : 'unknown'
    await emitInspectorEvent('inspector.llm.called', {
      runId,
      wrapperName: 'find_in_codebase',
      purpose: 'expand',
      model: llmModel,
      promptPreview: promptPreview.preview,
      truncated: promptPreview.truncated,
    } satisfies InspectorLlmCalledPayload)
    const expanded = await classifyAndExpand({
      query: trimmed,
      modelConfig,
      languages,
    })
    const responsePreview = previewJson(
      expanded.responsePreview,
      INSPECTOR_PREVIEW_BYTES_CAP,
    )
    await emitInspectorEvent('inspector.llm.result', {
      runId,
      wrapperName: 'find_in_codebase',
      purpose: 'expand',
      durationMs: expanded.durationMs ?? 0,
      responsePreview: responsePreview.preview,
      truncated: responsePreview.truncated,
    } satisfies InspectorLlmResultPayload)
    expansions =
      expanded.expansions.length > 0 ? expanded.expansions : [trimmed]
    if (expanded.fallback) {
      toolStatus = 'fallback'
      warnings.push(
        `term expansion fell back: ${expanded.fallbackReason ?? 'unknown reason'}`,
      )
      await emitInspectorEvent('inspector.fallback', {
        runId,
        wrapperName: 'find_in_codebase',
        reason: expanded.fallbackReason ?? 'unknown reason',
      } satisfies InspectorFallbackPayload)
    }
  }

  // Fan out one gitnexus_query per (repo × expansion). Capped per-call
  // limit keeps wire payload bounded; the merged + dedupe pass below
  // collapses overlap. Parallel within a repo is fine — the gitnexus
  // subprocess multiplexes requests internally.
  const perCallLimit = Math.max(
    Math.ceil(maxFiles / Math.max(expansions.length, 1)),
    8,
  )
  type Pair = { repo: AttachedRepo; hits: readonly GitnexusQueryHit[] }
  const queryTasks: Array<Promise<Pair | null>> = []
  for (const r of targets) {
    for (const exp of expansions) {
      queryTasks.push(callInstrumentedQuery(r, exp, perCallLimit))
    }
  }

  // In parallel, run our local keyword retrieval (ripgrep)
  // alongside gitnexus. Stand-in for gitnexus's broken BM25 arm
  // (gitnexus#1287). One ripgrep spawn per repo with all expansions
  // OR'd via `-e PATTERN1 -e PATTERN2 …`. Failures fold into
  // `warnings` and don't block the gitnexus path. Deletable when
  // upstream lands a fix: drop these lines + the imports + the
  // keyword event kinds.
  const keywordTasks: Array<
    Promise<{ repo: AttachedRepo; hits: readonly KeywordHit[] }>
  > = targets.map(async (r) => {
    const sourceDir = repoSourceDir({
      id: r.repo_id,
      remoteUrl: r.remote_url,
      branch: r.branch,
    })
    const result = await withKeywordCall(
      'find_in_codebase',
      r.label,
      expansions,
      () =>
        keywordSearch({
          sourceDir,
          repoLabel: r.label,
          queries: expansions,
          limit: perCallLimit * 2,
        }),
    )
    if (!result.ok) {
      warnings.push(
        `keyword_search failed for repo "${r.label}": ${result.error ?? 'unknown'}`,
      )
      return { repo: r, hits: [] as readonly KeywordHit[] }
    }
    return { repo: r, hits: result.value ?? [] }
  })

  // Phase 1: search + keyword in parallel. These are the primary
  // recall arms and have no dependency on each other.
  const [settled, keywordSettled] = await Promise.all([
    Promise.all(queryTasks),
    Promise.all(keywordTasks),
  ])
  const allHits = settled.filter((p): p is Pair => p !== null)

  // Phase 2: Route-node enrichment. The OLD design gated `route_map`
  // on a regex matching `/api/...` shapes in the user's query string.
  // That missed semantically-route questions ("where is the checkout
  // endpoint?") where the user thinks in concepts, not paths. New
  // approach: let gitnexus tell us. If `gitnexus_query` returned any
  // hit tagged `type === 'Route'`, we KNOW the query semantically
  // matched an endpoint regardless of phrasing. Fire `route_map` for
  // each unique matched route to enrich with middleware + consumers.
  //
  // Trade-off vs the regex gate: this serialises `route_map` after the
  // query (no more parallel fire), adding ~50-200ms when it triggers.
  // In return we catch the "semantic route question" case which
  // probably outnumbers explicit-path cases in real usage. The dedupe
  // pass handles the overlap when both query and route_map surface
  // the same handler file.
  // Dedup key is `(repo_id, route_name)`. Same route name in different
  // repos (e.g. `POST /api/health` on api-service AND admin-service)
  // must each fire its own route_map call — they're independent
  // routes with independent middleware and consumer sets. Keying by
  // name alone would silently drop one repo's enrichment.
  const routeTargets = new Map<string, { name: string; repo: AttachedRepo }>()
  for (const pair of allHits) {
    for (const hit of pair.hits) {
      if (hit.type !== 'Route') continue
      // Gitnexus's Route.name carries the full route ("POST /api/users").
      // Prefer that as the filter; fall back to path-as-name when the
      // hit didn't carry an explicit symbol field.
      const routeName = hit.symbol ?? hit.path
      if (!routeName) continue
      const key = `${pair.repo.repo_id}::${routeName}`
      if (!routeTargets.has(key)) {
        routeTargets.set(key, { name: routeName, repo: pair.repo })
      }
    }
  }
  if (routeTargets.size > 0) {
    const routeTasks = [...routeTargets.values()].map(({ name, repo }) =>
      callInstrumentedRouteMap(repo, name),
    )
    const routeSettled = await Promise.all(routeTasks)
    for (const r of routeSettled) {
      if (r) allHits.push(r)
    }
  }

  /**
   * Single gitnexus_query call wrapped in `inspector.gitnexus.*` events.
   * Defined inline so it closes over `tools`, `runId`, `warnings`. Returns
   * the same `{repo, hits}` shape as the unwrapped path so the caller's
   * Pair fan-out logic stays unchanged. Failures emit a result event
   * with `ok: false` AND surface in the wrapper's `warnings`.
   */
  function callInstrumentedQuery(
    repo: AttachedRepo,
    expansion: string,
    limit: number,
  ): Promise<Pair | null> {
    const callStart = Date.now()
    const argsPreview = previewJson(
      { repo: repo.label, query: expansion, limit },
      INSPECTOR_PREVIEW_BYTES_CAP,
    )
    return emitInspectorEvent('inspector.gitnexus.called', {
      runId,
      wrapperName: 'find_in_codebase',
      tool: 'gitnexus_query',
      argsPreview: argsPreview.preview,
      truncated: argsPreview.truncated,
    } satisfies InspectorGitnexusCalledPayload)
      .then(() =>
        callGitnexusQuery({ tools, repo: repo.label, query: expansion, limit }),
      )
      .then(async ({ hits, warning }): Promise<Pair> => {
        const resultPreview = previewJson(hits, INSPECTOR_PREVIEW_BYTES_CAP)
        await emitInspectorEvent('inspector.gitnexus.result', {
          runId,
          wrapperName: 'find_in_codebase',
          tool: 'gitnexus_query',
          durationMs: Date.now() - callStart,
          resultPreview: resultPreview.preview,
          truncated: resultPreview.truncated,
          ok: true,
        } satisfies InspectorGitnexusResultPayload)
        // Route gitnexus's diagnostic warning into the wrapper's
        // `warnings[]` so a degraded BM25/FTS arm (or any other
        // server-side hint) shows up on the mini-repo instead of
        // disappearing into a silent zero-hit response.
        if (warning) {
          warnings.push(
            `gitnexus_query warning for repo "${repo.label}", expansion "${expansion}": ${warning}`,
          )
        }
        return { repo, hits: [...hits] }
      })
      .catch(async (err: unknown): Promise<null> => {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `gitnexus_query failed for repo "${repo.label}", expansion "${expansion}": ${message}`,
        )
        await emitInspectorEvent('inspector.gitnexus.result', {
          runId,
          wrapperName: 'find_in_codebase',
          tool: 'gitnexus_query',
          durationMs: Date.now() - callStart,
          resultPreview: message.slice(0, INSPECTOR_PREVIEW_BYTES_CAP),
          truncated: message.length > INSPECTOR_PREVIEW_BYTES_CAP,
          ok: false,
        } satisfies InspectorGitnexusResultPayload)
        return null
      })
  }

  /**
   * Wrap a `gitnexus_route_map` call with the standard
   * `inspector.gitnexus.{called,result}` telemetry pair. Synthesizes a
   * GitnexusQueryHit per route handler so the downstream merge code
   * doesn't need a special case. `ROUTE_MAP_SCORE` is chosen high so
   * route handlers outrank fuzzy text matches in the score-sorted
   * dedupe pass below: an exact route → handler binding is more
   * reliable evidence than a BM25/semantic similarity hit.
   */
  function callInstrumentedRouteMap(
    repo: AttachedRepo,
    routePath: string,
  ): Promise<Pair | null> {
    const ROUTE_MAP_SCORE = 100
    const ROUTE_MAP_CONSUMER_SCORE = 90
    const callStart = Date.now()
    const argsPreview = previewJson(
      { repo: repo.label, route: routePath },
      INSPECTOR_PREVIEW_BYTES_CAP,
    )
    return emitInspectorEvent('inspector.gitnexus.called', {
      runId,
      wrapperName: 'find_in_codebase',
      tool: 'gitnexus_route_map',
      argsPreview: argsPreview.preview,
      truncated: argsPreview.truncated,
    } satisfies InspectorGitnexusCalledPayload)
      .then(() =>
        callGitnexusRouteMap({
          tools,
          repo: repo.label,
          route: routePath,
        }),
      )
      .then(async (routes: readonly GitnexusRoute[]): Promise<Pair> => {
        const resultPreview = previewJson(routes, INSPECTOR_PREVIEW_BYTES_CAP)
        await emitInspectorEvent('inspector.gitnexus.result', {
          runId,
          wrapperName: 'find_in_codebase',
          tool: 'gitnexus_route_map',
          durationMs: Date.now() - callStart,
          resultPreview: resultPreview.preview,
          truncated: resultPreview.truncated,
          ok: true,
        } satisfies InspectorGitnexusResultPayload)
        // Project routes → synthetic GitnexusQueryHits so the merge
        // path treats them uniformly. Two kinds of hits come out of
        // a single route:
        //
        //   1. The HANDLER file — top-scored (`ROUTE_MAP_SCORE`).
        //      Reason carries the route, method, middleware chain,
        //      and a consumer-count hint so the LLM has the protect-
        //      ion + traffic context without a follow-up call.
        //   2. Each CONSUMER file (frontend component/hook that
        //      fetches the route) — scored slightly below the
        //      handler (`ROUTE_MAP_CONSUMER_SCORE`). Reason names
        //      the route they fetch + which response keys they read.
        //
        // Consumer hits are independent file rows in the mini-repo
        // (still deduped by `(repo, path)` in the merge pass), so
        // the LLM seeing "Where is /api/users handled?" gets both
        // the handler AND its callers in one tool call.
        const hits: GitnexusQueryHit[] = []
        for (const route of routes) {
          if (route.handlerPath) {
            const middlewareSuffix =
              route.middleware.length > 0
                ? `; middleware: ${route.middleware.join(', ')}`
                : ''
            const consumerSuffix =
              route.consumers.length > 0
                ? `; ${route.consumers.length} consumer${route.consumers.length === 1 ? '' : 's'}`
                : ''
            hits.push({
              repo: route.repo,
              path: route.handlerPath,
              line: null,
              symbol: route.handlerSymbol,
              score: ROUTE_MAP_SCORE,
              snippet: null,
              reason: `${route.method ? route.method + ' ' : ''}${route.route} handler (route_map${middlewareSuffix}${consumerSuffix})`,
              // Synthesized rows are not Route nodes themselves —
              // they're the handler file. Stay null so the Phase 2
              // Route detector doesn't loop on its own output.
              type: null,
              processLabel: null,
              processType: null,
              stepIndex: null,
            })
          }
          for (const consumer of route.consumers) {
            const keysSuffix =
              consumer.accessedKeys.length > 0
                ? `; reads keys: ${consumer.accessedKeys.join(', ')}`
                : ''
            hits.push({
              repo: route.repo,
              path: consumer.filePath,
              line: null,
              symbol: consumer.name,
              score: ROUTE_MAP_CONSUMER_SCORE,
              snippet: null,
              reason: `consumes ${route.route} (route_map${keysSuffix})`,
              type: null,
              processLabel: null,
              processType: null,
              stepIndex: null,
            })
          }
        }
        return { repo, hits }
      })
      .catch(async (err: unknown): Promise<null> => {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(
          `gitnexus_route_map failed for repo "${repo.label}", route "${routePath}": ${message}`,
        )
        await emitInspectorEvent('inspector.gitnexus.result', {
          runId,
          wrapperName: 'find_in_codebase',
          tool: 'gitnexus_route_map',
          durationMs: Date.now() - callStart,
          resultPreview: message.slice(0, INSPECTOR_PREVIEW_BYTES_CAP),
          truncated: message.length > INSPECTOR_PREVIEW_BYTES_CAP,
          ok: false,
        } satisfies InspectorGitnexusResultPayload)
        return null
      })
  }

  // Flatten + score-sort + dedupe by (repo, path), keep top maxFiles.
  // Same-path hits across expansions keep the highest-scoring entry.
  // Keyword hits union with gitnexus hits — same shape, dedupe pass
  // below picks one row per (repo, path). Gitnexus scores tend to be
  // <1 (semantic cosine), keyword scores are integer occurrence
  // counts, so a small normalization keeps the sort sensible.
  const gitnexusFlattened = allHits.flatMap(({ repo, hits }) =>
    hits.map((h) => ({ repo, hit: h, source: 'gitnexus' as const })),
  )
  const keywordFlattened = keywordSettled.flatMap(({ repo, hits }) =>
    hits.map((h) => ({
      repo,
      hit: h as GitnexusQueryHit, // KeywordHit is structurally compatible
      source: 'keyword' as const,
    })),
  )
  const flattened = [...gitnexusFlattened, ...keywordFlattened].sort(
    (a, b) => b.hit.score - a.hit.score,
  )

  const seen = new Set<string>()
  const files: MiniRepoFile[] = []
  for (const { repo, hit } of flattened) {
    if (files.length >= maxFiles) break
    const key = `${repo.repo_id}::${hit.path}`
    if (seen.has(key)) continue
    seen.add(key)

    const chunks: MiniRepoChunk[] = []
    if (hit.snippet && hit.snippet.length > 0) {
      const startLine = hit.line ?? 1
      const lineCount = hit.snippet.split('\n').length
      chunks.push({
        start_line: startLine,
        end_line: startLine + Math.max(0, lineCount - 1),
        content: hit.snippet,
      })
    }

    // Tag the why-string with the process flow this hit participates
    // in, when gitnexus surfaced one. Repos without entry points
    // (libraries, utilities) typically have no processes and this
    // stays a no-op. When present, gives the IDE narrative context:
    // "this match is in the Login flow" instead of just "matched."
    const processSuffix = hit.processLabel
      ? hit.stepIndex
        ? `; in ${hit.processLabel} flow (step ${hit.stepIndex})`
        : `; in ${hit.processLabel} flow`
      : ''
    files.push({
      repo_id: repo.repo_id,
      repo_label: repo.label,
      path: hit.path,
      language: inferLanguage(hit.path),
      chunks,
      why: `${hit.reason}${processSuffix}`,
    })
  }

  const totalHits = flattened.length
  const summary =
    files.length === 0
      ? totalHits === 0
        ? `No matches for "${trimmed}" across ${targets.length} repo(s) and ${expansions.length} term variant(s).`
        : `Gitnexus returned ${totalHits} match(es) but none parsed cleanly.`
      : `Found ${files.length} file match(es) for "${trimmed}" across ${targets.length} repo(s) using ${expansions.length} term variant(s).`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'find_in_codebase',
    summary,
    intent: 'find',
    expansions,
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
    warnings,
    ...(resolution.ok === true
      ? {
          resolved_repo: {
            repo_id: resolution.repo.repo_id,
            label: resolution.repo.label,
            matched_signal: resolution.matched_signal,
          },
        }
      : {}),
    confidence:
      files.length >= 3 ? 'high' : files.length >= 1 ? 'medium' : 'low',
  })

  // The shared `emitMinirepoBuilt` also persists the mini-repo
  // to `runs.minirepo_json`. Replaces the inline event emit so the
  // chat-tab tool-call cards + the IDE bridge envelope both see this
  // wrapper's output.
  await emitMinirepoBuilt('find_in_codebase', miniRepo)

  await emitToolResult({
    runId,
    durationMs: Date.now() - startedAt,
    status: toolStatus,
    ...(warnings.length > 0 ? { message: warnings[0] } : {}),
  })

  return miniRepo
}

interface ToolResultArgs {
  readonly runId: string
  readonly durationMs: number
  readonly status: InspectorToolResultPayload['status']
  readonly message?: string
}

async function emitToolResult(args: ToolResultArgs): Promise<void> {
  const payload: InspectorToolResultPayload = {
    runId: args.runId,
    wrapperName: 'find_in_codebase',
    durationMs: args.durationMs,
    status: args.status,
    ...(args.message ? { message: args.message } : {}),
  }
  await emitInspectorEvent('inspector.tool.result', payload)
}

/**
 * Process-local cache of detected languages per repo source directory.
 * Detection only reads the top-level files in the clone and matches
 * marker files (package.json, pyproject.toml, etc.), so it's cheap to
 * compute the first time and free on every subsequent wrapper call
 * for the lifetime of the worker process. We don't invalidate on
 * re-clone: source dirs are stable per (repo_id, branch), and
 * languages don't change between clones in any practical scenario.
 */
const languageCache = new Map<string, readonly string[]>()

/**
 * Detect the dominant language(s) for one cloned repo by inspecting
 * its top-level files. Uses two signals in order:
 *
 *   1. Build-system marker files (`package.json` → JS/TS,
 *      `pyproject.toml` / `setup.py` / `requirements.txt` → Python,
 *      `go.mod` → Go, etc.). One readdir, no recursion. Catches
 *      99% of repos because the marker file is conventionally at
 *      the root.
 *   2. Fall-back: extension scan of the top-level files. Useful for
 *      single-language repos without a manifest (e.g. a folder of
 *      scripts).
 *
 * Returns up to 3 language names ordered by detection. Empty array
 * on errors (clone gone, permission denied, etc.) — degrades to the
 * pre-existing behaviour of an empty hint, never throws.
 */
async function detectRepoLanguages(
  sourceDir: string,
): Promise<readonly string[]> {
  const cached = languageCache.get(sourceDir)
  if (cached) return cached
  let result: readonly string[] = []
  try {
    const entries = await readdir(sourceDir)
    const top = new Set(entries)
    const langs: string[] = []
    if (top.has('package.json')) {
      // package.json could be a JS-only or TS-aware repo. Both are
      // common enough that biasing the LLM toward either alone hurts
      // recall; emit both and let the LLM pick.
      langs.push('typescript', 'javascript')
    }
    if (
      top.has('pyproject.toml') ||
      top.has('setup.py') ||
      top.has('requirements.txt')
    ) {
      langs.push('python')
    }
    if (top.has('go.mod')) langs.push('go')
    if (top.has('Cargo.toml')) langs.push('rust')
    if (top.has('Gemfile')) langs.push('ruby')
    if (top.has('pom.xml')) langs.push('java')
    if (top.has('build.gradle') || top.has('build.gradle.kts')) {
      langs.push('kotlin', 'java')
    }
    if (top.has('Package.swift')) langs.push('swift')
    if (top.has('composer.json')) langs.push('php')
    if (top.has('mix.exs')) langs.push('elixir')
    if (top.has('Project.toml')) langs.push('julia')
    // Fall-back: scan top-level file extensions if no marker matched.
    if (langs.length === 0) {
      for (const entry of entries) {
        const lang = inferLanguage(entry)
        // Skip generic config / docs — they don't identify the repo's
        // primary language.
        if (
          lang === 'unknown' ||
          lang === 'json' ||
          lang === 'yaml' ||
          lang === 'markdown'
        ) {
          continue
        }
        langs.push(lang)
      }
    }
    // Dedupe + cap at 3 so the prompt stays short.
    result = [...new Set(langs)].slice(0, 3)
  } catch {
    // Source dir missing / unreadable. Treat as no signal.
    result = []
  }
  languageCache.set(sourceDir, result)
  return result
}

/**
 * Language-hint for the expand LLM call. Detects the dominant
 * language(s) of each matched repo by inspecting build-system marker
 * files in its cloned source directory, dedupes across repos, and
 * returns up to 3 names.
 *
 * Previously this function returned the operator-authored repo
 * descriptions — a misleading name/body mismatch. Now it actually
 * does what the name says. Empty array when no source dirs are
 * readable or no language signals are found; expand call degrades to
 * a no-language-hint prompt (same as before this change).
 */
async function deriveLanguagesHint(
  repos: readonly AttachedRepo[],
): Promise<readonly string[]> {
  const merged = new Set<string>()
  for (const r of repos) {
    const sourceDir = repoSourceDir({
      id: r.repo_id,
      remoteUrl: r.remote_url,
      branch: r.branch,
    })
    for (const lang of await detectRepoLanguages(sourceDir)) {
      merged.add(lang)
    }
  }
  // Stable ordering so the prompt preview is deterministic per repo
  // set (helps when comparing two runs).
  return [...merged].sort()
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function emptyDraft(args: {
  summary: string
  warnings?: readonly string[]
}): MiniRepoDraft {
  return {
    wrapper: 'find_in_codebase',
    summary: args.summary,
    intent: 'find',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_relationships: [],
    warnings: args.warnings,
  }
}

function buildResolutionFailureSummary(
  res: Extract<RepoResolveResult, { ok: false } | { ok: 'clarify' }>,
): string {
  if (res.ok === 'clarify') {
    const labels = res.candidates.map((c) => c.label)
    const list = labels.length > 0 ? ` Pick one: ${labels.join(', ')}.` : ''
    return `${res.message}.${list}`.trim()
  }
  const candidates =
    res.candidates.length > 0 ? `Available: ${res.candidates.join(', ')}.` : ''
  return `Could not resolve repo: ${res.message}. ${candidates}`.trim()
}

/**
 * Cheap path → language inference for the mini-repo's `language` field.
 * Just enough to drive the chat-tab card's syntax-highlighting hint;
 * the LLM gets the same info from the path anyway.
 */
function inferLanguage(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'unknown'
  const ext = path.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    php: 'php',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sql: 'sql',
    sh: 'bash',
    css: 'css',
    html: 'html',
  }
  return map[ext] ?? ext
}
