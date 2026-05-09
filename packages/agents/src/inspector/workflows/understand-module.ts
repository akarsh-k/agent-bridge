/**
 * `understand_module` wrapper (`docs/ARCHITECTURE.md §10` Phase E E4).
 *
 * Takes a single anchor (file path OR symbol) and returns enough
 * mini-repo content for the LLM to explain what it does:
 *   - `gitnexus_context` on the anchor → main file body as the
 *     primary chunk.
 *   - `gitnexus_impact` downstream depth=2 → the modules this anchor
 *     reaches; included as additional `files` so the LLM can ground
 *     the explanation in dependencies, not just the entry point.
 *   - Optionally enriched with the wiki page when `repos.wikiStatus`
 *     reports `'ready'` and a page slug matches the anchor's basename.
 *     Wiki integration deferred until Phase F because the wiki tools
 *     were dropped from the agent in B6 — we'd be re-implementing
 *     the path-traversal-safe slug lookup here. For now, surface the
 *     structural data only.
 */

import type { AttachedRepo } from '@agent-bridge/shared'

import {
  callGitnexusContext,
  callGitnexusImpact,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import { resolveRepoFromHint } from '../repo-resolve.js'
import type {
  MiniRepo,
  MiniRepoChunk,
  MiniRepoFile,
} from '../types.js'
import {
  emitMinirepoBuilt,
  emitToolCalled,
  emitToolResult,
  withGitnexusCall,
} from '../wrapper-telemetry.js'

const DEPENDENCY_DEPTH = 2 as const
const MAX_DEPENDENCY_FILES = 6 as const

export interface UnderstandModuleInput {
  readonly tools: ToolDict
  readonly repos: readonly AttachedRepo[]
  /** File path OR symbol name. */
  readonly anchor: string
  readonly repoHint?: string | null
}

export async function runUnderstandModule(
  input: UnderstandModuleInput,
): Promise<MiniRepo> {
  const { tools, repos, anchor, repoHint } = input
  const handle = await emitToolCalled('understand_module', {
    anchor,
    repo_hint: repoHint,
  })

  const trimmed = anchor.trim()
  if (trimmed.length === 0) {
    const result = finalizeMiniRepo(emptyDraft({
      summary: 'Pass an `anchor` (file path or symbol) to explain.',
      warnings: ['empty anchor'],
    }))
    await emitMinirepoBuilt('understand_module', result)
    await emitToolResult({
      handle,
      wrapperName: 'understand_module',
      status: 'error',
      message: 'empty anchor',
    })
    return result
  }

  const resolution = resolveRepoFromHint({ repos, hint: repoHint, allowAll: false })
  if (resolution.ok === false || resolution.ok === 'all') {
    const message =
      resolution.ok === 'all'
        ? 'understand_module operates on a single repo; pass `repo_hint`.'
        : resolution.message
    const result = finalizeMiniRepo(emptyDraft({
      summary: `Could not resolve repo: ${message}`,
      warnings: [message],
    }))
    await emitMinirepoBuilt('understand_module', result)
    await emitToolResult({
      handle,
      wrapperName: 'understand_module',
      status: 'error',
      message,
    })
    return result
  }
  const target = resolution.repo

  const warnings: string[] = []
  const files: MiniRepoFile[] = []

  // Anchor file body. The most important payload.
  try {
    const ctx = await withGitnexusCall(
      'understand_module',
      'gitnexus_context',
      { repo: target.label, path: trimmed },
      () =>
        callGitnexusContext({ tools, repo: target.label, path: trimmed }),
    )
    if (ctx) {
      const chunks: MiniRepoChunk[] = [
        {
          start_line: ctx.startLine ?? 1,
          end_line:
            ctx.endLine ??
            (ctx.startLine ?? 1) +
              Math.max(0, ctx.content.split('\n').length - 1),
          content: ctx.content,
        },
      ]
      files.push({
        repo_id: target.repo_id,
        repo_label: target.label,
        path: ctx.path,
        language: ctx.language ?? 'unknown',
        chunks,
        why: 'anchor file body',
      })
    } else {
      warnings.push(
        `gitnexus_context returned no body for "${trimmed}" — file may not exist or path may need adjusting`,
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`gitnexus_context failed: ${message}`)
  }

  // Outgoing dependencies — what this anchor reaches.
  let dependencyRows: Awaited<ReturnType<typeof callGitnexusImpact>> = []
  try {
    dependencyRows = await withGitnexusCall(
      'understand_module',
      'gitnexus_impact',
      {
        repo: target.label,
        target: trimmed,
        direction: 'downstream',
        depth: DEPENDENCY_DEPTH,
      },
      () =>
        callGitnexusImpact({
          tools,
          repo: target.label,
          target: trimmed,
          direction: 'downstream',
          depth: DEPENDENCY_DEPTH,
        }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`gitnexus_impact failed: ${message}`)
  }

  const sortedDeps = [...dependencyRows]
    .sort((a, b) => a.depth - b.depth)
    .slice(0, MAX_DEPENDENCY_FILES)

  for (const row of sortedDeps) {
    files.push({
      repo_id: target.repo_id,
      repo_label: target.label,
      path: row.path,
      language: 'unknown',
      chunks: [],
      why: `dependency at depth ${row.depth}`,
    })
  }

  const summary =
    files.length === 0
      ? `Couldn't find "${trimmed}" in repo ${target.label}. The path/symbol may not be indexed; try a more specific name.`
      : `Anchor "${trimmed}" in ${target.label}: 1 main file + ${sortedDeps.length} dependency(ies) (depth ≤ ${DEPENDENCY_DEPTH}).`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'understand_module',
    summary,
    intent: 'understand',
    expansions: [trimmed],
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings,
  })

  await emitMinirepoBuilt('understand_module', miniRepo)
  await emitToolResult({
    handle,
    wrapperName: 'understand_module',
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
    wrapper: 'understand_module',
    summary: args.summary,
    intent: 'understand',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings: args.warnings,
  }
}
