/**
 * Wrapper-tool type surface (`docs/ARCHITECTURE.md §10` Phase B).
 *
 * `MiniRepo` is the structured payload every wrapper tool returns. It's
 * what the bridge accumulates onto `runs.minirepo_json` (D17 envelope's
 * `mini_repos[]` array) and what the chat tab renders inline as a
 * tool-call card.
 *
 * The shape is locked in `docs/ARCHITECTURE.md §10` §5; this file is the
 * compile-time mirror. If you change one, change the other.
 *
 * Browser-safe — only consumed by Node code today, but kept dependency-
 * free so the frontend's tool-call card can `import type` from it.
 */

/** Inferred high-level intent of the user query. Phase B sets this to the wrapper's name; Phase C lets the LLM expand it. */
export type InspectorIntent =
  | 'find'
  | 'trace'
  | 'impact'
  | 'debug'
  | 'understand'
  | 'list_repos'

/**
 * One file in the mini-repo, with one or more excerpted chunks. `chunks`
 * is intentionally an array — the same file may contribute several spans
 * (function body + tests + a comment block). Each chunk's `content` is
 * sliced from disk verbatim, NOT synthesised.
 */
export interface MiniRepoFile {
  readonly repo_id: string
  readonly repo_label: string
  readonly path: string
  /** Best-effort language tag (lower-case). `'unknown'` when we can't infer. */
  readonly language: string
  readonly chunks: readonly MiniRepoChunk[]
  /** One-line "why this file is here" — sourced from gitnexus's match reason. */
  readonly why: string
}

export interface MiniRepoChunk {
  /** 1-based, inclusive. */
  readonly start_line: number
  /** 1-based, inclusive. */
  readonly end_line: number
  readonly content: string
}

export interface MiniRepoGraphNode {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly name: string
}

export interface MiniRepoGraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: string
}

export interface MiniRepoCrossRepoEdge {
  readonly from_repo: string
  readonly to_repo: string
  readonly connector: string
  readonly description: string | null
}

/**
 * The full structured payload one wrapper invocation appends to
 * `runs.minirepo_json` (D17). Counts/sizes also feed the
 * `inspector.minirepo.built` event (A4).
 */
export interface MiniRepo {
  /** Which wrapper produced this. used by the chat-tab card and by Logs. */
  readonly wrapper: string
  /** One-paragraph human-readable hint. capped at 400 chars at build time. */
  readonly summary: string
  readonly intent: InspectorIntent
  /** Term variants that drove the gitnexus queries. `[query]` when no LLM expansion ran. */
  readonly expansions: readonly string[]
  readonly files: readonly MiniRepoFile[]
  readonly graph_subset: {
    readonly nodes: readonly MiniRepoGraphNode[]
    readonly edges: readonly MiniRepoGraphEdge[]
  }
  readonly cross_repo_edges: readonly MiniRepoCrossRepoEdge[]
  /** Char-based estimate. ~4 chars ≈ 1 token; close enough for our budget. */
  readonly tokens_used: number
  readonly tokens_cap: number
  readonly warnings: readonly string[]
}

/** Token cap per-mini-repo (`docs/ARCHITECTURE.md §10` §5). */
export const MINI_REPO_TOKEN_CAP = 12_000 as const

/** Char ≈ token estimator constant. Same approximation Mastra uses internally. */
export const CHARS_PER_TOKEN = 4 as const

/** Summary field hard cap. Anything longer is truncated with an ellipsis. */
export const SUMMARY_CHAR_CAP = 400 as const
