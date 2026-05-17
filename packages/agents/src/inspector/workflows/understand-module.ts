/**
 * `understand_module` wrapper (`docs/ARCHITECTURE.md §10`).
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
 *     Wiki integration deferred because the wiki tools
 *     were dropped from the agent — we'd be re-implementing
 *     the path-traversal-safe slug lookup here. For now, surface the
 *     structural data only.
 */

import type { AttachedRepo } from '@agent-bridge/shared'

import {
  callGitnexusContext,
  callGitnexusImpact,
  type GitnexusContextResult,
  type ToolDict,
} from '../gitnexus-callers.js'
import { finalizeMiniRepo, type MiniRepoDraft } from '../mini-repo.js'
import { readFileChunkFromDisk } from '../read-source.js'
import { resolveRepoForWrapper } from '../run-context.js'
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

  const resolution = resolveRepoForWrapper({ repos, hint: repoHint, allowAll: false })
  if (resolution.ok !== true) {
    const message =
      resolution.ok === 'all'
        ? 'understand_module operates on a single repo; pass `repo_hint`.'
        : resolution.message
    const summary =
      resolution.ok === 'clarify'
        ? `${message}. Pick one: ${resolution.candidates.map((c) => c.label).join(', ')}.`
        : `Could not resolve repo: ${message}`
    const result = finalizeMiniRepo(emptyDraft({
      summary,
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
  const looksLikePath = /[\\/]/.test(trimmed) || /\.[a-zA-Z0-9]{1,8}$/.test(trimmed)

  // Anchor file body. The most important payload. Two paths:
  //   - Path-anchored: read the file directly from disk; no gitnexus call.
  //   - Symbol-anchored: ask gitnexus_context for the symbol's record (uid,
  //     filePath, line range), then slice that range from disk. Note that
  //     gitnexus_context is graph-only — it returns metadata + edges, not
  //     file content — so the disk read is mandatory either way.
  let symbolContext: GitnexusContextResult | null = null
  let anchorFilePath: string | null = null
  let anchorStartLine: number | null = null
  let anchorEndLine: number | null = null

  if (looksLikePath) {
    anchorFilePath = trimmed
  } else {
    try {
      symbolContext = await withGitnexusCall(
        'understand_module',
        'gitnexus_context',
        { repo: target.label, name: trimmed },
        () =>
          callGitnexusContext({ tools, repo: target.label, name: trimmed }),
      )
      if (symbolContext) {
        anchorFilePath = symbolContext.symbol.filePath
        anchorStartLine = symbolContext.symbol.startLine
        anchorEndLine = symbolContext.symbol.endLine
      } else {
        warnings.push(
          `gitnexus_context returned no symbol for "${trimmed}" — try a fully-qualified uid or a different name.`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`gitnexus_context failed: ${message}`)
    }
  }

  if (anchorFilePath) {
    const chunk = await readFileChunkFromDisk({
      repo: target,
      filePath: anchorFilePath,
      startLine: anchorStartLine,
      endLine: anchorEndLine,
      padLines: anchorStartLine != null ? 4 : 0,
    })
    if (chunk) {
      const chunks: MiniRepoChunk[] = [
        {
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          content: chunk.content,
        },
      ]
      files.push({
        repo_id: target.repo_id,
        repo_label: target.label,
        path: anchorFilePath,
        language: chunk.language,
        chunks,
        why: looksLikePath ? 'anchor file body' : `body of ${symbolContext?.symbol.kind ?? 'symbol'} ${trimmed}`,
      })
      if (chunk.truncated) {
        warnings.push(`anchor body truncated to ${chunk.content.length} bytes`)
      }
    } else {
      warnings.push(
        `Couldn't read "${anchorFilePath}" from disk in repo ${target.label}.`,
      )
    }
  }

  // Outgoing edges (when we have a symbol context). Surface each callee /
  // import as a dependency file with a small body slice — gitnexus already
  // told us where they live.
  if (symbolContext) {
    const flatEdges = flattenContextEdges(symbolContext.outgoing)
    for (const edge of flatEdges.slice(0, MAX_DEPENDENCY_FILES)) {
      const chunk = await readFileChunkFromDisk({
        repo: target,
        filePath: edge.filePath,
      })
      files.push({
        repo_id: target.repo_id,
        repo_label: target.label,
        path: edge.filePath,
        language: chunk?.language ?? 'unknown',
        chunks: chunk
          ? [{ start_line: chunk.startLine, end_line: chunk.endLine, content: chunk.content }]
          : [],
        why: `outgoing ${edge.relation} → ${edge.name}`,
      })
    }
  }

  // Outgoing dependencies via gitnexus_impact — depth>=2 reach. Adds files
  // we wouldn't see from one-hop context edges alone.
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

  const seenPaths = new Set<string>(files.map((f) => f.path))
  const sortedDeps = [...dependencyRows]
    .sort((a, b) => a.depth - b.depth)
    .filter((row) => !seenPaths.has(row.path))
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
      : `Anchor "${trimmed}" in ${target.label}: ${files.length} file(s) — body + ${Math.max(0, files.length - 1)} dependency(ies) (depth ≤ ${DEPENDENCY_DEPTH}).`

  const miniRepo = finalizeMiniRepo({
    wrapper: 'understand_module',
    summary,
    intent: 'understand',
    expansions: [trimmed],
    files,
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings,
    resolved_repo: {
      repo_id: target.repo_id,
      label: target.label,
      matched_signal: resolution.matched_signal,
    },
    // "high" when the anchor + at least one dependency landed; "medium"
    // when only the anchor came back; "low" when nothing did.
    confidence:
      files.length >= 2 ? 'high' : files.length >= 1 ? 'medium' : 'low',
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

interface FlatContextEdge {
  readonly relation: string
  readonly name: string
  readonly filePath: string
  readonly uid: string
}

function flattenContextEdges(
  edgeMap: Record<string, readonly { uid: string; name: string; filePath: string }[]>,
): FlatContextEdge[] {
  const out: FlatContextEdge[] = []
  for (const [relation, edges] of Object.entries(edgeMap)) {
    for (const e of edges) out.push({ relation, ...e })
  }
  return out
}
