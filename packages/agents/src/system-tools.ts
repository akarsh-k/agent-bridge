/**
 * Read-only enumeration of the system-mounted tools the agent's LLM
 * actually sees — the six inspector wrappers (find_in_codebase,
 * list_repos, trace_flow, assess_change_impact, debug_help,
 * understand_module). Surfaces names + descriptions to the frontend
 * Resources tab so users can see what their agent automatically has
 * access to without spelunking through `inspector/index.ts`.
 *
 * Under the wrapper-tool architecture (`docs/ARCHITECTURE.md` §10), the
 * raw `gitnexus_*` tools are NOT exposed to the LLM directly — only the
 * wrappers can call them. So this catalog ships the wrappers, not the
 * underlying gitnexus surface. That keeps the Resources tab honest
 * about what the agent's LLM is shown.
 *
 * Data is fully static (no subprocess spawn, no network call) —
 * `INSPECTOR_TOOL_DEFINITIONS` ships with `@agent-bridge/shared` and is
 * already mirrored from the runtime `createTool({description})` calls
 * in `inspector/index.ts`. Drift there is a doc bug, not a runtime bug.
 *
 * Failure mode: none. The function always succeeds. Kept as
 * `Promise<...>` for backwards compat with the prior subprocess-based
 * loader's signature.
 */

import {
  EXPECTED_GITNEXUS_VERSION,
} from '@agent-bridge/shared/gitnexus'
import {
  INSPECTOR_TOOL_DEFINITIONS,
  type InspectorToolDefinition,
} from '@agent-bridge/shared'

export interface SystemToolDefinition {
  readonly name: string
  readonly description: string
}

export interface GitnexusSystemToolsOk {
  readonly ok: true
  readonly cliVersion: string
  readonly tools: readonly SystemToolDefinition[]
}
export interface GitnexusSystemToolsErr {
  readonly ok: false
  readonly message: string
}
export type GitnexusSystemToolsResult =
  | GitnexusSystemToolsOk
  | GitnexusSystemToolsErr

/**
 * Returns the inspector-toolkit catalog as the agent's "system tools".
 * The `cliVersion` field is preserved on the response so the frontend's
 * existing wire shape stays valid; in practice it now reports the
 * pinned gitnexus CLI the inspector wraps under the hood.
 */
export function loadGitnexusToolDefinitions(): Promise<GitnexusSystemToolsResult> {
  const tools: SystemToolDefinition[] = INSPECTOR_TOOL_DEFINITIONS.map(
    (t: InspectorToolDefinition): SystemToolDefinition => ({
      name: t.name,
      description: t.description,
    }),
  )
  return Promise.resolve({
    ok: true,
    cliVersion: EXPECTED_GITNEXUS_VERSION,
    tools,
  })
}

// Re-export for the public surface — saves the index.ts a separate
// type re-export.
export { EXPECTED_GITNEXUS_VERSION }
