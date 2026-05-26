/**
 * Codebase-inspection-report assembler (`docs/ARCHITECTURE.md §10` + §5
 * truncation rules).
 *
 * Pure functions only — no I/O, no side effects. Wrapper tools build a
 * draft `CodebaseInspectionReport` from gitnexus + disk reads, hand it to
 * `finalizeCodebaseInspectionReport` which:
 *
 *   1. Estimates tokens (char-count / 4).
 *   2. If over `CODEBASE_INSPECTION_REPORT_TOKEN_CAP`, truncates per §5:
 *      - Drop chunks bottom-up from the lowest-relevance file (last in
 *        `files`) until under cap.
 *      - If still over, drop graph nodes/edges past depth 2.
 *      - If still over, drop the oldest `cross_repo_relationships` entries.
 *      - `summary` is never touched.
 *   3. Stamps `tokens_used` + `tokens_cap` + `warnings`.
 *
 * Truncation order is deliberate: chunks contribute the most weight by
 * a wide margin, the graph subset is medium, cross-repo relationships are
 * tiny but lowest-relevance. Files themselves are NEVER dropped — a
 * file with zero chunks still tells the LLM the path matched, which is
 * useful even without a span.
 */

import type {
  CodebaseInspectionReport,
  CodebaseInspectionReportChunk,
  CodebaseInspectionReportFile,
  InspectorGroundedness,
} from './types.js'
import {
  CHARS_PER_TOKEN,
  CODEBASE_INSPECTION_REPORT_TOKEN_CAP,
  SUMMARY_CHAR_CAP,
} from './types.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface CodebaseInspectionReportDraft
  extends Omit<
    CodebaseInspectionReport,
    'tokens_used' | 'tokens_cap' | 'warnings'
  > {
  readonly warnings?: readonly string[]
}

/**
 * Compute final `tokens_used`, apply truncation if over cap, and stamp the
 * cap + any warnings the truncation produced. Idempotent. calling twice
 * with the result of the first call is a no-op.
 */
export function finalizeCodebaseInspectionReport(
  draft: CodebaseInspectionReportDraft,
  cap: number = CODEBASE_INSPECTION_REPORT_TOKEN_CAP,
): CodebaseInspectionReport {
  const summary = clampSummary(draft.summary)
  const warnings: string[] = [...(draft.warnings ?? [])]

  let files: readonly CodebaseInspectionReportFile[] = draft.files
  let nodes = draft.graph_subset.nodes
  let edges = draft.graph_subset.edges
  let crossRepoRelationships = draft.cross_repo_relationships

  let tokens = estimateTokens({
    summary,
    files,
    nodes,
    edges,
    crossRepoRelationships,
    expansions: draft.expansions,
  })

  // Pass 1: trim chunks. We walk files in reverse (lowest relevance first)
  // and pop chunks one by one until we either fit or run out of chunks.
  if (tokens > cap) {
    const trimmed = trimChunksUntilUnderCap(files, () => {
      return estimateTokens({
        summary,
        files: trimmed.snapshot ?? files,
        nodes,
        edges,
        crossRepoRelationships,
        expansions: draft.expansions,
      })
    }, cap)
    files = trimmed.files
    if (trimmed.droppedChunks > 0) {
      warnings.push(
        `dropped ${trimmed.droppedChunks} chunk(s) to fit under ${cap}-token cap`,
      )
    }
    tokens = estimateTokens({
      summary,
      files,
      nodes,
      edges,
      crossRepoRelationships,
      expansions: draft.expansions,
    })
  }

  // Pass 2: drop graph nodes/edges. Currently we don't track per-node
  // depth, so for now we just drop the second half of each
  // array as the "past depth 2" proxy.
  if (tokens > cap && (nodes.length > 0 || edges.length > 0)) {
    const cutNodes = Math.floor(nodes.length / 2)
    const cutEdges = Math.floor(edges.length / 2)
    nodes = nodes.slice(0, cutNodes)
    edges = edges.slice(0, cutEdges)
    if (cutNodes > 0 || cutEdges > 0) {
      warnings.push(
        `dropped ${nodes.length === 0 ? 'all' : 'half of'} graph subset to fit under ${cap}-token cap`,
      )
    }
    tokens = estimateTokens({
      summary,
      files,
      nodes,
      edges,
      crossRepoRelationships,
      expansions: draft.expansions,
    })
  }

  // Pass 3: cross-repo relationships (cheapest signal, dropped last).
  if (tokens > cap && crossRepoRelationships.length > 0) {
    crossRepoRelationships = []
    warnings.push(`dropped cross-repo relationships to fit under ${cap}-token cap`)
    tokens = estimateTokens({
      summary,
      files,
      nodes,
      edges,
      crossRepoRelationships,
      expansions: draft.expansions,
    })
  }

  return {
    wrapper: draft.wrapper,
    summary,
    intent: draft.intent,
    expansions: draft.expansions,
    files,
    graph_subset: { nodes, edges },
    cross_repo_relationships: crossRepoRelationships,
    tokens_used: tokens,
    tokens_cap: cap,
    warnings,
    ...(draft.resolved_repo ? { resolved_repo: draft.resolved_repo } : {}),
    // Default groundedness: count files vs files-with-chunks. Wrappers
    // can pass an explicit `groundedness` on the draft to override
    // (e.g. `list_repos` which has no files but isn't ungrounded).
    ...(draft.groundedness !== undefined
      ? { groundedness: draft.groundedness }
      : { groundedness: deriveGroundedness(files) }),
    ...(draft.confidence ? { confidence: draft.confidence } : {}),
  }
}

/**
 * Compute the default groundedness for a finalized report. Files are
 * "grounded" when they carry at least one chunk (actual code content
 * was surfaced); files with zero chunks were path-only matches.
 */
function deriveGroundedness(
  files: readonly CodebaseInspectionReportFile[],
): InspectorGroundedness {
  let grounded = 0
  for (const f of files) {
    if (f.chunks.length > 0) grounded += 1
  }
  return {
    claims: files.length,
    grounded,
    ungrounded: files.length - grounded,
  }
}

/**
 * Fast standalone token estimate without truncation. Useful for telemetry
 * (the `inspector.report.built` event carries tokens_used in payload).
 */
export function estimateCodebaseInspectionReportTokens(
  draft: CodebaseInspectionReportDraft,
): number {
  return estimateTokens({
    summary: clampSummary(draft.summary),
    files: draft.files,
    nodes: draft.graph_subset.nodes,
    edges: draft.graph_subset.edges,
    crossRepoRelationships: draft.cross_repo_relationships,
    expansions: draft.expansions,
  })
}

// ─── Internals ───────────────────────────────────────────────────────────

interface EstimateInput {
  summary: string
  files: readonly CodebaseInspectionReportFile[]
  nodes: readonly { id: string; kind: string; path: string; name: string }[]
  edges: readonly { from: string; to: string; kind: string }[]
  crossRepoRelationships: readonly {
    from_repo: string
    to_repo: string
    connector: string
    description: string | null
  }[]
  expansions: readonly string[]
}

function estimateTokens(input: EstimateInput): number {
  let chars = input.summary.length
  for (const exp of input.expansions) chars += exp.length + 2 // ", " separator
  for (const f of input.files) {
    chars += f.path.length + f.repo_label.length + f.why.length + 32 // overhead
    for (const c of f.chunks) chars += c.content.length + 16
  }
  for (const n of input.nodes) {
    chars += n.id.length + n.kind.length + n.path.length + n.name.length + 16
  }
  for (const e of input.edges) {
    chars += e.from.length + e.to.length + e.kind.length + 8
  }
  for (const c of input.crossRepoRelationships) {
    chars += c.from_repo.length + c.to_repo.length + c.connector.length + 8
    if (c.description) chars += c.description.length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

interface TrimResult {
  readonly files: readonly CodebaseInspectionReportFile[]
  readonly droppedChunks: number
  readonly snapshot?: readonly CodebaseInspectionReportFile[]
}

/**
 * Walk files in reverse, pop chunks one at a time. The supplied
 * `recompute` closure recalculates tokens against the current snapshot.
 * Stops at the first under-cap state OR when no chunks remain.
 */
function trimChunksUntilUnderCap(
  files: readonly CodebaseInspectionReportFile[],
  // The recompute function isn't actually used with a closure capture
  // here (we pass a snapshot in directly) — keeping the parameter for
  // future flexibility but using a direct estimate below.
  _recompute: () => number,
  cap: number,
): TrimResult {
  const mutable: CodebaseInspectionReportChunk[][] = files.map((f) => [
    ...f.chunks,
  ])
  let dropped = 0

  // We need a way to estimate without rebuilding the file list every
  // iteration. Pre-compute the static-overhead char count + per-file
  // overhead, then track chunk-content chars as a single mutable sum.
  let chunkChars = 0
  for (const chunks of mutable) {
    for (const c of chunks) chunkChars += c.content.length + 16
  }
  const staticChars = staticCharsOf(files)

  // Iterate files from last (lowest relevance) to first, popping the
  // last chunk of each file. Drains a file's chunks before moving on.
  let fi = mutable.length - 1
  while (fi >= 0 && Math.ceil((staticChars + chunkChars) / CHARS_PER_TOKEN) > cap) {
    const chunks = mutable[fi]!
    if (chunks.length === 0) {
      fi -= 1
      continue
    }
    const popped = chunks.pop()!
    chunkChars -= popped.content.length + 16
    dropped += 1
  }

  const out: CodebaseInspectionReportFile[] = files.map((f, i) => ({
    repo_id: f.repo_id,
    repo_label: f.repo_label,
    path: f.path,
    language: f.language,
    why: f.why,
    chunks: mutable[i]!,
  }))

  return { files: out, droppedChunks: dropped }
}

function staticCharsOf(files: readonly CodebaseInspectionReportFile[]): number {
  let chars = 0
  for (const f of files) {
    chars += f.path.length + f.repo_label.length + f.why.length + 32
  }
  return chars
}

function clampSummary(summary: string): string {
  if (summary.length <= SUMMARY_CHAR_CAP) return summary
  return `${summary.slice(0, SUMMARY_CHAR_CAP - 1)}…`
}
