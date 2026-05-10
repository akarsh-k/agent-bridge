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
 *   - `cross_repo_edges` (`assess_change_impact`).
 */

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
  type GitnexusQueryHit,
  type ToolDict,
} from '../gitnexus-callers.js'
import {
  keywordSearch,
  type KeywordHit,
} from '../keyword-search.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import {
  resolveRepoFromHint,
  type RepoResolveResult,
} from '../repo-resolve.js'
import {
  emitInspectorEvent,
  getInspectorRunContext,
  previewJson,
} from '../run-context.js'
import type {
  MiniRepo,
  MiniRepoChunk,
  MiniRepoFile,
} from '../types.js'
import {
  emitMinirepoBuilt,
  withKeywordCall,
} from '../wrapper-telemetry.js'

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
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Empty query — nothing to search for.',
      warnings: ['empty query'],
    }))
    await emitToolResult({
      runId,
      durationMs: Date.now() - startedAt,
      status: 'error',
      message: 'empty query',
    })
    return result
  }

  const resolution = resolveRepoFromHint({
    repos,
    hint: repoHint,
    allowAll: true,
  })

  if (resolution.ok === false) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: buildResolutionFailureSummary(resolution),
      warnings: [resolution.message],
    }))
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
    const promptPreview = previewJson(
      { query: trimmed, languages: deriveLanguagesHint(targets) },
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
      languages: deriveLanguagesHint(targets),
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
    expansions = expanded.expansions.length > 0 ? expanded.expansions : [trimmed]
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
  const perCallLimit = Math.max(Math.ceil(maxFiles / Math.max(expansions.length, 1)), 8)
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
  const keywordTasks: Array<Promise<{ repo: AttachedRepo; hits: readonly KeywordHit[] }>> =
    targets.map(async (r) => {
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

  const [settled, keywordSettled] = await Promise.all([
    Promise.all(queryTasks),
    Promise.all(keywordTasks),
  ])
  const allHits = settled.filter((p): p is Pair => p !== null)

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
      .then(async (hits): Promise<Pair> => {
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
        return { repo, hits }
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

    files.push({
      repo_id: repo.repo_id,
      repo_label: repo.label,
      path: hit.path,
      language: inferLanguage(hit.path),
      chunks,
      why: hit.reason,
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
    cross_repo_edges: [],
    warnings,
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
 * Best-effort languages-hint for the expand call. Pulls top-level
 * extension counts from the matched repos' `description` (a quick
 * proxy until a real language-detection pass on
 * `gitnexus_context` results).
 *
 * For now we just hand the repo labels — the LLM uses them as a hint
 * about repo identity which is often enough to bias terminology
 * (a JS/TS repo name biases the expansion toward JS/TS idioms; a
 * Python repo name biases it toward Python).
 */
function deriveLanguagesHint(repos: readonly AttachedRepo[]): readonly string[] {
  const out: string[] = []
  for (const r of repos) {
    if (r.description) out.push(r.description)
  }
  return out
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
    cross_repo_edges: [],
    warnings: args.warnings,
  }
}

function buildResolutionFailureSummary(
  res: Extract<RepoResolveResult, { ok: false }>,
): string {
  const candidates =
    res.candidates.length > 0
      ? `Available: ${res.candidates.join(', ')}.`
      : ''
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
