/**
 * `list_repos` wrapper. deterministic, no LLM, no gitnexus calls.
 * (`docs/ARCHITECTURE.md §10`).
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

import type { AttachedRepo } from '@agent-bridge/shared'

import { finalizeMiniRepo } from '../mini-repo.js'
import type { MiniRepo } from '../types.js'
import {
  emitMinirepoBuilt,
  emitToolCalled,
  emitToolResult,
} from '../wrapper-telemetry.js'

export interface ListReposInput {
  readonly repos: readonly AttachedRepo[]
  /** Per-call mini-repo token cap; falls back to the module default when omitted. */
  readonly miniRepoTokenCap?: number
}

/**
 * The pure-function `runListRepos` is now async because it emits
 * inspector telemetry events through the run-context AsyncLocalStorage.
 * The work itself is still synchronous; await is only there to
 * sequence event publishes.
 *
 * Routed through `emitMinirepoBuilt` so the resulting mini-repo lands
 * on `runs.minirepo_json` like every other wrapper. That makes
 * `list_repos` visible in the chat-tab tool-call cards and the IDE
 * D17 envelope, and gives the `no_repos_attached` warning a path to
 * the event payload.
 */
export async function runListRepos(input: ListReposInput): Promise<MiniRepo> {
  const { repos, miniRepoTokenCap } = input
  const handle = await emitToolCalled('list_repos', {})

  const miniRepo = buildListReposMiniRepo(repos, miniRepoTokenCap)

  await emitMinirepoBuilt('list_repos', miniRepo)
  await emitToolResult({
    handle,
    wrapperName: 'list_repos',
    status: 'ok',
  })

  return miniRepo
}

function buildListReposMiniRepo(
  repos: readonly AttachedRepo[],
  cap: number | undefined,
): MiniRepo {
  if (repos.length === 0) {
    return finalizeMiniRepo(
      {
        wrapper: 'list_repos',
        summary: 'This agent has no repos attached.',
        intent: 'list_repos',
        expansions: [],
        files: [],
        graph_subset: { nodes: [], edges: [] },
        cross_repo_relationships: [],
        warnings: ['no_repos_attached'],
      },
      cap,
    )
  }

  // Render the inventory inline in `summary` so the LLM picks it up
  // even from a heavily-truncated mini-repo. `cross_repo_relationships` is
  // left empty here. `assess_change_impact` is responsible for
  // that data when it actually lands.
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

  return finalizeMiniRepo(
    {
      wrapper: 'list_repos',
      summary,
      intent: 'list_repos',
      expansions: [],
      files: [],
      graph_subset: { nodes: [], edges: [] },
      cross_repo_relationships: [],
      warnings: [],
    },
    cap,
  )
}
