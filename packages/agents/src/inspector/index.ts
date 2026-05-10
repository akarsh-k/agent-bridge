/**
 * Inspector wrapper-tool mount (`docs/ARCHITECTURE.md §10`).
 *
 * The agent's tool dict for the wrapper-tool architecture:
 *   - `find_in_codebase(query, repo_hint?)`: hybrid search via gitnexus_query.
 *   - `list_repos()`: synchronous inventory read.
 *   - `trace_flow`, `assess_change_impact`, `debug_help`,
 *     `understand_module` — same `tools` dict.
 *
 * Lifecycle:
 *   - `mountInspectorTools(...)` is called inside `buildAgent`.
 *   - It loads the agent's attached repos once and closes them over
 *     each tool's `execute`. Repo state is re-read every call only
 *     when correctness demands it (`list_repos` — to surface live
 *     status changes); search-style wrappers reuse the closure since
 *     mid-run repo additions/removals would invalidate gitnexus's
 *     own state anyway.
 *   - Returns null when no gitnexus subprocess is mounted (LLM-only
 *     agent). The agent still gets `list_repos`. inventory works
 *     without any subprocess. but search wrappers are not registered
 *     to keep the tool list honest.
 *
 * No subprocess of its own — every gitnexus_* call rides on the
 * existing `mountGitnexusMcp(...)` subprocess via the `tools` dict.
 */

import { createTool, type Tool } from '@mastra/core/tools'
import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'

import type { AgentBridgeDb } from '@agent-bridge/db'
import {
  inspectorToolDescription,
  type AttachedRepo,
} from '@agent-bridge/shared'

import { loadAttachedRepos } from '../coding-agent/repo-loader.js'

import type { ToolDict } from './gitnexus-callers.js'
import {
  runAssessChangeImpact,
  type ChangeKind,
} from './workflows/assess-change-impact.js'
import { runDebugHelp } from './workflows/debug-help.js'
import { runFindInCodebase } from './workflows/find-in-codebase.js'
import { runListRepos } from './workflows/list-repos.js'
import { runTraceFlow } from './workflows/trace-flow.js'
import { runUnderstandModule } from './workflows/understand-module.js'

// ─── Public surface ──────────────────────────────────────────────────────

export interface MountInspectorToolsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * Live gitnexus tool dict. when `null`, the agent has no indexed
   * repos and we register only `list_repos`. Search wrappers stay
   * unregistered so the LLM doesn't try to call them and get a
   * "subprocess not mounted" runtime error.
   */
  readonly gitnexusTools: ToolDict | null
  /**
   * Agent's model config. drives the in-wrapper LLM term-expansion
   * call. When omitted, wrappers run in deterministic mode
   * (raw query as the only expansion). Useful for tests + smoke
   * scripts that want to isolate gitnexus behaviour.
   */
  readonly modelConfig?: MastraModelConfig
}

export interface InspectorMountMeta {
  /** Always `true` — the inspector module always registers at least `list_repos`. */
  readonly mounted: boolean
  readonly toolCount: number
  readonly toolNames: readonly string[]
  /**
   * `true` iff the gitnexus subprocess was available at mount time.
   * When `false`, search-style wrappers are NOT registered — the agent
   * sees only `list_repos`.
   */
  readonly gitnexusBacked: boolean
  readonly repoCount: number
}

export interface MountedInspector {
  readonly tools: Record<string, Tool<any, any, any, any>>
  readonly meta: InspectorMountMeta
}

/**
 * Build the inspector tool dict. Always returns a non-null object —
 * unlike `mountGitnexusMcp` which returns `null` for LLM-only agents,
 * the inspector mount always provides at least `list_repos` so the
 * Mastra Agent has at least one tool to reach for.
 */
export async function mountInspectorTools(
  input: MountInspectorToolsInput,
): Promise<MountedInspector> {
  const { db, agentId, gitnexusTools, modelConfig } = input

  // Load once at mount; per-call state changes (e.g. a repo flipping
  // status mid-run) trigger a BuiltAgent cache invalidation in
  // `built-agent-cache.ts` so a fresh mount happens on next access.
  const repos = await loadAttachedRepos({ db, agentId, readyOnly: false })

  const tools: Record<string, Tool<any, any, any, any>> = {
    list_repos: buildListReposTool(repos),
  }

  if (gitnexusTools !== null) {
    tools['find_in_codebase'] = buildFindInCodebaseTool(
      repos,
      gitnexusTools,
      modelConfig,
    )
    tools['trace_flow'] = buildTraceFlowTool(repos, gitnexusTools)
    tools['assess_change_impact'] = buildAssessChangeImpactTool(
      repos,
      gitnexusTools,
      db,
      agentId,
    )
    tools['debug_help'] = buildDebugHelpTool(repos, gitnexusTools)
    tools['understand_module'] = buildUnderstandModuleTool(repos, gitnexusTools)
  }

  return {
    tools,
    meta: {
      mounted: true,
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools).sort(),
      gitnexusBacked: gitnexusTools !== null,
      repoCount: repos.length,
    },
  }
}

export function emptyInspectorMountMeta(): InspectorMountMeta {
  return {
    mounted: false,
    toolCount: 0,
    toolNames: [],
    gitnexusBacked: false,
    repoCount: 0,
  }
}

// ─── Tool factories ──────────────────────────────────────────────────────

const findInCodebaseInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(8000)
      .describe(
        'What to search for. Pass user-language: "where is translation handled?", "auth middleware", "useCart hook". Hybrid BM25 + semantic search — gitnexus does the heavy lifting.',
      ),
    repo_hint: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        'Friendly label of an attached repo (role / alias / URL tail). Omit when the agent has only one repo, or when you want to search across every attached repo.',
      ),
    max_files: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Cap files in the response. Default 12.'),
  })
  .strict()

function buildFindInCodebaseTool(
  repos: readonly AttachedRepo[],
  gitnexusTools: ToolDict,
  modelConfig: MastraModelConfig | undefined,
): Tool<any, any, any, any> {
  // No `outputSchema` — our `MiniRepo` type uses `readonly` arrays
  // (correct for an immutable payload), but Mastra's `createTool`
  // infers Zod's mutable `string[]` from `z.array(...)` and rejects the
  // assignment. Mastra still serialises the return value to the LLM as
  // JSON; we simply pay back the runtime validation we'd have got from
  // outputSchema (which is fine. we own this code path end-to-end).
  return createTool({
    id: 'find_in_codebase',
    description: inspectorToolDescription('find_in_codebase'),
    inputSchema: findInCodebaseInputSchema,
    execute: async (input) =>
      runFindInCodebase({
        tools: gitnexusTools,
        repos,
        query: input.query,
        repoHint: input.repo_hint ?? null,
        ...(input.max_files !== undefined ? { maxFiles: input.max_files } : {}),
        ...(modelConfig ? { modelConfig } : {}),
      }),
  })
}

const listReposInputSchema = z.object({}).strict()

function buildListReposTool(
  repos: readonly AttachedRepo[],
): Tool<any, any, any, any> {
  return createTool({
    id: 'list_repos',
    description: inspectorToolDescription('list_repos'),
    inputSchema: listReposInputSchema,
    // outputSchema omitted for the same readonly-array reason as
    // find_in_codebase; mirrors the closure we captured at mount.
    execute: async () => runListRepos({ repos }),
  })
}

// ─── trace_flow ──────────────────────────────────────────────────────────

const traceFlowInputSchema = z
  .object({
    start_path: z
      .string()
      .min(1)
      .max(400)
      .nullable()
      .optional()
      .describe(
        'File path to anchor the trace on. Pass either this or `start_symbol`.',
      ),
    start_symbol: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        'Function/class/method name to anchor on. Pass either this or `start_path`.',
      ),
    goal: z
      .string()
      .min(1)
      .max(2000)
      .nullable()
      .optional()
      .describe(
        'Optional. what you want to learn from the trace (e.g. "find where this API endpoint is consumed").',
      ),
    repo_hint: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe('Friendly label of the repo to trace inside (required for multi-repo agents).'),
  })
  .strict()

function buildTraceFlowTool(
  repos: readonly AttachedRepo[],
  gitnexusTools: ToolDict,
): Tool<any, any, any, any> {
  return createTool({
    id: 'trace_flow',
    description: inspectorToolDescription('trace_flow'),
    inputSchema: traceFlowInputSchema,
    execute: async (input) =>
      runTraceFlow({
        tools: gitnexusTools,
        repos,
        ...(input.start_path ? { startPath: input.start_path } : {}),
        ...(input.start_symbol ? { startSymbol: input.start_symbol } : {}),
        ...(input.goal ? { goal: input.goal } : {}),
        repoHint: input.repo_hint ?? null,
      }),
  })
}

// ─── assess_change_impact ────────────────────────────────────────────────

const assessChangeImpactInputSchema = z
  .object({
    anchors: z
      .array(z.string().min(1).max(400))
      .min(1)
      .max(10)
      .describe(
        'Files and/or symbols the change touches. Pass at least one. e.g. ["src/cart/total.ts", "computeTotal"].',
      ),
    change_kind: z
      .enum(['rename', 'remove', 'modify', 'add'])
      .describe('What the developer is doing.'),
    repo_hint: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        'Friendly label of the primary changed repo (required for multi-repo agents).',
      ),
  })
  .strict()

function buildAssessChangeImpactTool(
  repos: readonly AttachedRepo[],
  gitnexusTools: ToolDict,
  db: AgentBridgeDb,
  agentId: string,
): Tool<any, any, any, any> {
  return createTool({
    id: 'assess_change_impact',
    description: inspectorToolDescription('assess_change_impact'),
    inputSchema: assessChangeImpactInputSchema,
    execute: async (input) =>
      runAssessChangeImpact({
        tools: gitnexusTools,
        repos,
        db,
        agentId,
        anchors: input.anchors,
        changeKind: input.change_kind as ChangeKind,
        repoHint: input.repo_hint ?? null,
      }),
  })
}

// ─── debug_help ──────────────────────────────────────────────────────────

const debugHelpInputSchema = z
  .object({
    error_text: z
      .string()
      .min(1)
      .max(16000)
      .describe(
        'Raw error message and/or stack trace. Pass verbatim. file paths and symbol names extracted from this drive the search.',
      ),
    query: z
      .string()
      .min(1)
      .max(2000)
      .nullable()
      .optional()
      .describe('Optional. developer-supplied description of what is broken.'),
    repo_hint: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        'Friendly label of the repo to investigate. Omit to fan out across every repo.',
      ),
  })
  .strict()

function buildDebugHelpTool(
  repos: readonly AttachedRepo[],
  gitnexusTools: ToolDict,
): Tool<any, any, any, any> {
  return createTool({
    id: 'debug_help',
    description: inspectorToolDescription('debug_help'),
    inputSchema: debugHelpInputSchema,
    execute: async (input) =>
      runDebugHelp({
        tools: gitnexusTools,
        repos,
        errorText: input.error_text,
        ...(input.query ? { query: input.query } : {}),
        repoHint: input.repo_hint ?? null,
      }),
  })
}

// ─── understand_module ───────────────────────────────────────────────────

const understandModuleInputSchema = z
  .object({
    anchor: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'File path or symbol name to explain. e.g. "src/cart/total.ts" or "computeTotal".',
      ),
    repo_hint: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe('Friendly label of the repo (required for multi-repo agents).'),
  })
  .strict()

function buildUnderstandModuleTool(
  repos: readonly AttachedRepo[],
  gitnexusTools: ToolDict,
): Tool<any, any, any, any> {
  return createTool({
    id: 'understand_module',
    description: inspectorToolDescription('understand_module'),
    inputSchema: understandModuleInputSchema,
    execute: async (input) =>
      runUnderstandModule({
        tools: gitnexusTools,
        repos,
        anchor: input.anchor,
        repoHint: input.repo_hint ?? null,
      }),
  })
}
