/**
 * Unified workspace store — Context + hook. The matching Provider component
 * lives in `./workspace-provider.tsx` so this file stays JSX-free (React
 * Fast Refresh requires component-only files for HMR).
 *
 * The workspace holds three classes of data:
 *
 *   1. Agents — the canonical list (one vertex per agent on the canvas).
 *   2. Shared resources — `repos`, `mcpConnections`, `llmProviders`. Global;
 *      one row, many attachment edges.
 *   3. Per-agent resources — `skills`, `tools`, `attachedRepos`, `mcpAllowlist`,
 *      `repoEdges`. Keyed by agent id so the canvas can look them up without
 *      re-scanning the whole list.
 *
 * Loading is "fetch-on-mount" and parallelised; see `WorkspaceProvider` for
 * the mechanics. Mutations mutate local state directly so the canvas reacts
 * without a roundtrip refetch.
 */

import { createContext, useContext } from 'react'
import type {
  AgentCreateInput,
  AgentResponse,
  AgentUpdateInput,
  AllowlistEntry,
  AllowlistEntryResponse,
  AttachRepoInput,
  AttachRepoUpdateInput,
  AttachedRepoResponse,
  LlmProviderCreateInput,
  LlmProviderResponse,
  LlmProviderUpdateInput,
  McpConnectionCreateInput,
  McpConnectionResponse,
  McpConnectionUpdateInput,
  RepoCreateInput,
  RepoEdgeCreateInput,
  RepoEdgeResponse,
  RepoResponse,
  RepoUpdateInput,
  SkillCreateInput,
  SkillResponse,
  SkillUpdateInput,
  ToolCreateInput,
  ToolResponse,
  ToolUpdateInput,
} from '@agent-bridge/shared'

export type WorkspaceStatus = 'loading' | 'ready' | 'error'

/** Bundle of per-agent dependent data keyed off an agent id. */
export interface AgentResources {
  skills: readonly SkillResponse[]
  tools: readonly ToolResponse[]
  attachedRepos: readonly AttachedRepoResponse[]
  mcpAllowlist: readonly AllowlistEntryResponse[]
  repoEdges: readonly RepoEdgeResponse[]
}

export interface WorkspaceContextValue {
  status: WorkspaceStatus
  error: Error | null

  // Top-level entities
  agents: readonly AgentResponse[]
  repos: readonly RepoResponse[]
  mcpConnections: readonly McpConnectionResponse[]
  llmProviders: readonly LlmProviderResponse[]

  // Keyed by agent id. Missing key ⇒ still loading for that agent.
  agentResources: Readonly<Record<string, AgentResources>>

  // Focused / forced refresh
  refresh: () => void

  // Agent mutations
  createAgent: (input: AgentCreateInput) => Promise<AgentResponse>
  patchAgent: (id: string, patch: AgentUpdateInput) => Promise<AgentResponse>
  removeAgent: (id: string) => Promise<void>
  getAgent: (id: string) => AgentResponse | undefined

  // Per-agent resource mutations (Phase 1H quick-add menu)
  createSkill: (
    agentId: string,
    input: SkillCreateInput,
  ) => Promise<SkillResponse>
  patchSkill: (
    agentId: string,
    skillId: string,
    patch: SkillUpdateInput,
  ) => Promise<SkillResponse>
  removeSkill: (agentId: string, skillId: string) => Promise<void>
  createTool: (
    agentId: string,
    input: ToolCreateInput,
  ) => Promise<ToolResponse>
  patchTool: (
    agentId: string,
    toolId: string,
    patch: ToolUpdateInput,
  ) => Promise<ToolResponse>
  removeTool: (agentId: string, toolId: string) => Promise<void>
  attachRepo: (
    agentId: string,
    input: AttachRepoInput,
  ) => Promise<AttachedRepoResponse>
  patchAttachedRepo: (
    agentId: string,
    repoId: string,
    patch: AttachRepoUpdateInput,
  ) => Promise<AttachedRepoResponse>
  detachRepo: (agentId: string, repoId: string) => Promise<void>
  createRepoEdge: (
    agentId: string,
    input: RepoEdgeCreateInput,
  ) => Promise<RepoEdgeResponse>
  removeRepoEdge: (agentId: string, edgeId: string) => Promise<void>

  // Shared-resource mutations (net-new rows usable from any quick-add picker)
  createRepo: (
    input: RepoCreateInput,
  ) => Promise<{ repo: RepoResponse; existed: boolean }>
  createLlmProvider: (
    input: LlmProviderCreateInput,
  ) => Promise<LlmProviderResponse>
  /**
   * Patch an llm-provider row's `models_json` cache in local state with
   * a fresh response from the refresh endpoint. Used by the
   * "Refresh models" affordance on the LLM provider inspector — the
   * backend has already persisted, so we just sync the in-memory list
   * so dropdowns elsewhere (agent inspector, wiki button) see the new
   * choices without a full refetch.
   */
  patchLlmProviderModels: (
    id: string,
    models: LlmProviderResponse['models'],
  ) => void
  patchLlmProvider: (
    id: string,
    patch: LlmProviderUpdateInput,
  ) => Promise<LlmProviderResponse>
  removeLlmProvider: (id: string) => Promise<void>
  patchRepo: (id: string, patch: RepoUpdateInput) => Promise<RepoResponse>
  removeRepo: (id: string) => Promise<void>
  createMcpConnection: (
    input: McpConnectionCreateInput,
  ) => Promise<McpConnectionResponse>
  patchMcpConnection: (
    id: string,
    patch: McpConnectionUpdateInput,
  ) => Promise<McpConnectionResponse>
  /**
   * Delete an MCP connection and cascade the removal across every
   * agent's allowlist in local state. The backend's FK cascade handles
   * the DB side.
   */
  removeMcpConnection: (id: string) => Promise<void>
  /**
   * Set-replace an agent's MCP tool allowlist. Mirrors the backend's
   * `PUT /api/agents/:agentId/mcp-tools` semantic — the `tools` array
   * becomes the canonical allowlist, replacing any previous state.
   */
  setAgentMcpTools: (
    agentId: string,
    tools: readonly AllowlistEntry[],
  ) => Promise<readonly AllowlistEntryResponse[]>

  /**
   * Refetch a single repo row from the server and patch it into both the
   * top-level `repos[]` list and every `agentResources[*].attachedRepos`
   * entry that references it. Used by the clone/index inspectors to
   * replace an optimistic in-flight state ("cloning") with the canonical
   * server truth ("cloned" / "error") after a terminal SSE event arrives,
   * without triggering a full workspace refetch.
   */
  refreshRepo: (repoId: string) => Promise<RepoResponse | null>
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
)

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) {
    throw new Error('useWorkspace must be used within <WorkspaceProvider>')
  }
  return ctx
}
