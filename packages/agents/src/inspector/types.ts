/**
 * Wrapper-tool type surface (`docs/ARCHITECTURE.md §10`).
 *
 * `CodebaseInspectionReport` is the structured payload every wrapper tool
 * returns. It's what the bridge accumulates onto
 * `runs.codebase_inspection_reports_json` (D17 envelope's
 * `codebase_inspection_reports[]` array) and what the chat tab renders
 * inline as a tool-call card.
 *
 * The shape is locked in `docs/ARCHITECTURE.md §10` §5; this file is the
 * compile-time mirror. If you change one, change the other.
 *
 * Browser-safe — only consumed by Node code today, but kept dependency-
 * free so the frontend's tool-call card can `import type` from it.
 */

/** Inferred high-level intent of the user query. Set to the wrapper's name; LLM expansion can override. */
export type InspectorIntent =
  | 'find'
  | 'trace'
  | 'impact'
  | 'debug'
  | 'understand'
  | 'list_repos'

/**
 * One file in the inspection report, with one or more excerpted chunks.
 * `chunks` is intentionally an array — the same file may contribute several
 * spans (function body + tests + a comment block). Each chunk's `content`
 * is sliced from disk verbatim, NOT synthesised.
 */
export interface CodebaseInspectionReportFile {
  readonly repo_id: string
  readonly repo_label: string
  readonly path: string
  /** Best-effort language tag (lower-case). `'unknown'` when we can't infer. */
  readonly language: string
  readonly chunks: readonly CodebaseInspectionReportChunk[]
  /** One-line "why this file is here" — sourced from gitnexus's match reason. */
  readonly why: string
}

export interface CodebaseInspectionReportChunk {
  /** 1-based, inclusive. */
  readonly start_line: number
  /** 1-based, inclusive. */
  readonly end_line: number
  readonly content: string
}

export interface CodebaseInspectionReportGraphNode {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly name: string
}

export interface CodebaseInspectionReportGraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: string
}

export interface CodebaseInspectionReportCrossRepoRelationship {
  readonly from_repo: string
  readonly to_repo: string
  readonly connector: string
  readonly description: string | null
}

/**
 * Which repo a single-repo wrapper invocation worked on, and which IDE
 * signal (or fallback) produced the choice. Populated by wrappers that
 * call `resolveRepoForWrapper` and got back `ok: true`. Lets the chat
 * card / Logs panel answer "why this repo?" without re-running the
 * scorer.
 */
export interface CodebaseInspectionReportResolvedRepo {
  readonly repo_id: string
  readonly label: string
  /** Mirrors `MatchedSignal` from repo-resolve.ts (kept as string here
   *  so this type stays dependency-free and importable from the frontend). */
  readonly matched_signal: string
}

/**
 * Self-graded confidence the wrapper attached to its own result. `low`
 * MUST co-occur with at least one entry in `CodebaseInspectionReport.warnings`
 * so the reader can see WHY the wrapper isn't confident.
 *
 * Computed deterministically from observable signals (number of hits,
 * graph coverage, candidate-extraction success), NOT from an LLM
 * self-grade. Keeps the value cheap and reproducible.
 */
export type InspectorConfidence = 'high' | 'medium' | 'low'

/**
 * Coarse breakdown of "claims vs evidence" for the wrapper's output.
 * For inspector wrappers (deterministic, evidence-first) this is a
 * direct count of files-referenced vs files-with-actual-content:
 *
 *   - `claims`: total files in the report's `files[]`.
 *   - `grounded`: files with `chunks.length > 0` (actual code excerpts).
 *   - `ungrounded`: `claims - grounded` (path-only matches with no
 *     content surfaced).
 *
 * Surfaces the difference between "I found 8 candidate files" (claims)
 * and "I read 3 of them and showed you their code" (grounded).
 */
export interface InspectorGroundedness {
  readonly claims: number
  readonly grounded: number
  readonly ungrounded: number
}

/**
 * The full structured payload one wrapper invocation appends to
 * `runs.codebase_inspection_reports_json` (D17). Counts/sizes also feed
 * the `inspector.report.built` event (A4).
 */
export interface CodebaseInspectionReport {
  /** Which wrapper produced this. used by the chat-tab card and by Logs. */
  readonly wrapper: string
  /** One-paragraph human-readable hint. capped at 400 chars at build time. */
  readonly summary: string
  readonly intent: InspectorIntent
  /** Term variants that drove the gitnexus queries. `[query]` when no LLM expansion ran. */
  readonly expansions: readonly string[]
  readonly files: readonly CodebaseInspectionReportFile[]
  readonly graph_subset: {
    readonly nodes: readonly CodebaseInspectionReportGraphNode[]
    readonly edges: readonly CodebaseInspectionReportGraphEdge[]
  }
  readonly cross_repo_relationships: readonly CodebaseInspectionReportCrossRepoRelationship[]
  /** Char-based estimate. ~4 chars ≈ 1 token; close enough for our budget. */
  readonly tokens_used: number
  readonly tokens_cap: number
  readonly warnings: readonly string[]
  /**
   * Which repo this wrapper invocation resolved to, with the IDE signal
   * (or fallback) that drove the choice. Omitted for fan-out calls
   * (`find_in_codebase` across all repos) where there's no single
   * resolved repo, and for `list_repos` which doesn't resolve.
   */
  readonly resolved_repo?: CodebaseInspectionReportResolvedRepo
  /**
   * Wrapper's self-assessment of result quality. See `InspectorConfidence`.
   * Optional so wrappers can opt in incrementally; the bridge envelope
   * surfaces it on each report when present.
   */
  readonly confidence?: InspectorConfidence
  /** Evidence vs claims breakdown. See `InspectorGroundedness`. */
  readonly groundedness?: InspectorGroundedness
}

/** Token cap per codebase inspection report (`docs/ARCHITECTURE.md §10` §5). */
export const CODEBASE_INSPECTION_REPORT_TOKEN_CAP = 12_000 as const

/**
 * The `codebase_inspection_reports_json` bundle (the evidence array the IDE
 * bridge + chat-tab cards consume) is budgeted at this multiple of the
 * per-report cap. At 2× ≈ 24k tokens for the default cap, the bundle holds
 * roughly two full reports, or one full report plus many summary-only stubs:
 * older evidence is kept as a summary rather than dropped wholesale. See
 * `packReportBundle`.
 */
export const CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER = 2 as const

/** Char ≈ token estimator constant. Same approximation Mastra uses internally. */
export const CHARS_PER_TOKEN = 4 as const

/** Summary field hard cap. Anything longer is truncated with an ellipsis. */
export const SUMMARY_CHAR_CAP = 400 as const
