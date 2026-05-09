/**
 * `list_repos` wrapper. deterministic, no LLM, no gitnexus calls.
 * (`docs/ARCHITECTURE.md §10` Phase B B5).
 *
 * Reads from the agent's `attached repos` slice that the inspector
 * mount already loaded. Returns a mini-repo with zero `files` (this
 * tool's job is to give the LLM the inventory, not gather code).
 *
 * Why this is a wrapper at all rather than a fact baked into the
 * system prompt: the prompt no longer carries the repo inventory
 * (D9/F5 — auto-attached blocks dropped). The agent's LLM calls
 * `list_repos` once at the start of a conversation when it doesn't
 * know which repos it has, and uses the returned `summary` + `warnings`
 * to pick a `repo_hint` for subsequent wrapper calls.
 */

import type {
  AttachedRepo,
  InspectorMinirepoBuiltPayload,
  InspectorToolCalledPayload,
  InspectorToolResultPayload,
} from '@agent-bridge/shared'
import { INSPECTOR_PREVIEW_BYTES_CAP } from '@agent-bridge/shared'

import { finalizeMiniRepo } from '../mini-repo.js'
import {
  emitInspectorEvent,
  getInspectorRunContext,
  previewJson,
} from '../run-context.js'
import type { MiniRepo } from '../types.js'

export interface ListReposInput {
  readonly repos: readonly AttachedRepo[]
}

/**
 * Phase B's pure-function `runListRepos` is now async because it emits
 * inspector telemetry events through the run-context AsyncLocalStorage.
 * The work itself is still synchronous; await is only there to
 * sequence event publishes.
 */
export async function runListRepos(input: ListReposInput): Promise<MiniRepo> {
  const { repos } = input
  const ctx = getInspectorRunContext()
  const runId = ctx?.runId ?? ''
  const startedAt = Date.now()

  const argsPreview = previewJson({}, INSPECTOR_PREVIEW_BYTES_CAP)
  await emitInspectorEvent('inspector.tool.called', {
    runId,
    wrapperName: 'list_repos',
    argsPreview: argsPreview.preview,
    truncated: argsPreview.truncated,
  } satisfies InspectorToolCalledPayload)

  const miniRepo = buildListReposMiniRepo(repos)

  await emitInspectorEvent('inspector.minirepo.built', {
    runId,
    wrapperName: 'list_repos',
    fileCount: 0,
    chunkCount: 0,
    tokensUsed: miniRepo.tokens_used,
    tokensCap: miniRepo.tokens_cap,
    truncated: false,
  } satisfies InspectorMinirepoBuiltPayload)
  await emitInspectorEvent('inspector.tool.result', {
    runId,
    wrapperName: 'list_repos',
    durationMs: Date.now() - startedAt,
    status: 'ok',
  } satisfies InspectorToolResultPayload)

  return miniRepo
}

function buildListReposMiniRepo(repos: readonly AttachedRepo[]): MiniRepo {
  if (repos.length === 0) {
    return finalizeMiniRepo({
      wrapper: 'list_repos',
      summary: 'This agent has no repos attached.',
      intent: 'list_repos',
      expansions: [],
      files: [],
      graph_subset: { nodes: [], edges: [] },
      cross_repo_edges: [],
      warnings: ['no_repos_attached'],
    })
  }

  // Render the inventory inline in `summary` so the LLM picks it up
  // even from a heavily-truncated mini-repo. `cross_repo_edges` is
  // left empty here. `assess_change_impact` is responsible for
  // that data when it actually lands in Phase E.
  const lines = repos.map((r) => {
    const role = r.role ? ` [${r.role}]` : ''
    const status = r.status === 'ready' ? '' : ` (${r.status})`
    const aliases =
      r.aliases.length > 0 ? `; aliases: ${r.aliases.join(', ')}` : ''
    const desc = r.description ? `; ${r.description}` : ''
    return `- ${r.label}${role}${status} — ${r.remote_url}#${r.branch}${aliases}${desc}`
  })

  const summary = [
    `${repos.length} repo${repos.length === 1 ? '' : 's'} attached:`,
    ...lines,
  ].join('\n')

  return finalizeMiniRepo({
    wrapper: 'list_repos',
    summary,
    intent: 'list_repos',
    expansions: [],
    files: [],
    graph_subset: { nodes: [], edges: [] },
    cross_repo_edges: [],
    warnings: [],
  })
}
