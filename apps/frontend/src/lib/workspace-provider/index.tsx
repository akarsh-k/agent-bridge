/**
 * WorkspaceProvider — mounts once at the app root and performs the initial
 * parallel fetch of every entity the global canvas renders.
 *
 * Loading strategy:
 *
 *   t=0   kick off 4 top-level fetches in parallel: agents, repos,
 *         mcpConnections, llmProviders.
 *   t=1   once `agents` resolves, fan out per-agent sub-resource fetches
 *         (skills, tools, attachedRepos, mcpAllowlist, repoEdges) in
 *         parallel across every agent.
 *
 * Any of the top-level fetches failing flips `status` to `'error'` (the
 * shell renders a retry overlay). Per-agent sub-resource errors surface as
 * `error` without hiding the canvas — the UI is still useful, just with
 * gaps in that agent's cluster.
 *
 * Mutations:
 *   - `createAgent`, `patchAgent`, `removeAgent` mutate local state on
 *     success; callers don't need to refetch. Deleting an agent also purges
 *     its `agentResources` slot.
 *   - `refresh()` bumps an internal tick to re-fetch everything (used on
 *     retry and after low-risk mutations).
 *
 * React 19 hygiene:
 *   - setState calls inside effects are either conditioned on actual
 *     diffs or deferred with `await Promise.resolve()` when the effect
 *     body runs synchronously (tripping the set-state-in-effect rule).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type {
  AgentCreateInput,
  AgentResponse,
  AgentUpdateInput,
  AllowlistEntryResponse,
  AttachRepoInput,
  AttachedRepoResponse,
  LlmProviderCreateInput,
  LlmProviderResponse,
  McpConnectionResponse,
  RepoCreateInput,
  RepoEdgeResponse,
  RepoResponse,
  SkillCreateInput,
  SkillResponse,
  ToolCreateInput,
  ToolResponse,
} from '@agent-bridge/shared'
import {
  WorkspaceContext,
  type AgentResources,
  type WorkspaceContextValue,
  type WorkspaceStatus,
} from '../workspace-context'
import { callApi, rpc } from '../rpc'

interface TopLevelData {
  agents: readonly AgentResponse[]
  repos: readonly RepoResponse[]
  mcpConnections: readonly McpConnectionResponse[]
  llmProviders: readonly LlmProviderResponse[]
}

const EMPTY_TOP_LEVEL: TopLevelData = {
  agents: [],
  repos: [],
  mcpConnections: [],
  llmProviders: [],
}

async function fetchTopLevel(): Promise<TopLevelData> {
  const [agents, repos, mcpConnections, llmProviders] = await Promise.all([
    callApi<{ ok: true; agents: readonly AgentResponse[] }>(
      rpc.api.agents.$get(),
    ).then((r) => r.agents),
    callApi<{ ok: true; repos: readonly RepoResponse[] }>(
      rpc.api.repos.$get(),
    ).then((r) => r.repos),
    callApi<{ ok: true; mcpConnections: readonly McpConnectionResponse[] }>(
      rpc.api['mcp-connections'].$get(),
    ).then((r) => r.mcpConnections),
    callApi<{ ok: true; llmProviders: readonly LlmProviderResponse[] }>(
      rpc.api['llm-providers'].$get(),
    ).then((r) => r.llmProviders),
  ])
  return { agents, repos, mcpConnections, llmProviders }
}

async function fetchAgentResources(agentId: string): Promise<AgentResources> {
  const [skills, tools, attachedRepos, mcpAllowlist, repoEdges] =
    await Promise.all([
      callApi<{ ok: true; skills: readonly SkillResponse[] }>(
        rpc.api.agents[':agentId'].skills.$get({ param: { agentId } }),
      ).then((r) => r.skills),
      callApi<{ ok: true; tools: readonly ToolResponse[] }>(
        rpc.api.agents[':agentId'].tools.$get({ param: { agentId } }),
      ).then((r) => r.tools),
      callApi<{ ok: true; attachments: readonly AttachedRepoResponse[] }>(
        rpc.api.agents[':agentId'].repos.$get({ param: { agentId } }),
      ).then((r) => r.attachments),
      callApi<{ ok: true; tools: readonly AllowlistEntryResponse[] }>(
        rpc.api.agents[':agentId']['mcp-tools'].$get({ param: { agentId } }),
      ).then((r) => r.tools),
      callApi<{ ok: true; edges: readonly RepoEdgeResponse[] }>(
        rpc.api.agents[':agentId']['repo-edges'].$get({ param: { agentId } }),
      ).then((r) => r.edges),
    ])
  return { skills, tools, attachedRepos, mcpAllowlist, repoEdges }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [topLevel, setTopLevel] = useState<TopLevelData>(EMPTY_TOP_LEVEL)
  const [agentResources, setAgentResources] = useState<
    Readonly<Record<string, AgentResources>>
  >({})
  const [status, setStatus] = useState<WorkspaceStatus>('loading')
  const [error, setError] = useState<Error | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // Top-level load + refetch on tick bump. All setState calls happen after
  // an `await` so the react-hooks/set-state-in-effect rule stays satisfied.
  useEffect(() => {
    let active = true
    ;(async () => {
      // Defer the "loading" flip so it happens after a microtask instead of
      // synchronously inside the effect body.
      await Promise.resolve()
      if (!active) return
      setStatus((s) => (s === 'loading' ? s : 'loading'))
      setError((e) => (e === null ? e : null))
      try {
        const data = await fetchTopLevel()
        if (!active) return
        setTopLevel(data)
        setStatus('ready')
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setStatus('error')
      }
    })()
    return () => {
      active = false
    }
  }, [refreshTick])

  // Per-agent resources fan-out. Runs whenever the agent list changes.
  useEffect(() => {
    let active = true
    const agentIds = topLevel.agents.map((a) => a.id)
    ;(async () => {
      if (agentIds.length === 0) {
        // Yield a microtask so the setState happens after a suspension point
        // (React 19 set-state-in-effect hygiene).
        await Promise.resolve()
        if (!active) return
        setAgentResources((prev) =>
          Object.keys(prev).length === 0 ? prev : {},
        )
        return
      }
      try {
        const pairs = await Promise.all(
          agentIds.map(async (id) => {
            const r = await fetchAgentResources(id)
            return [id, r] as const
          }),
        )
        if (!active) return
        const next: Record<string, AgentResources> = {}
        for (const [id, r] of pairs) next[id] = r
        setAgentResources(next)
      } catch (err) {
        if (!active) return
        // Keep top-level state usable; surface via `error` so the toast rail
        // can show it, but don't flip status to error.
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    })()
    return () => {
      active = false
    }
  }, [topLevel.agents, refreshTick])

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  const getAgent = useCallback(
    (id: string): AgentResponse | undefined =>
      topLevel.agents.find((a) => a.id === id),
    [topLevel.agents],
  )

  const createAgent = useCallback(
    async (input: AgentCreateInput): Promise<AgentResponse> => {
      const { agent } = await callApi<{ ok: true; agent: AgentResponse }>(
        rpc.api.agents.$post({ json: input }),
      )
      setTopLevel((prev) => ({ ...prev, agents: [...prev.agents, agent] }))
      // Seed an empty resource bundle so the canvas can render the solo
      // agent node immediately without flashing a "loading" slot.
      setAgentResources((prev) => ({
        ...prev,
        [agent.id]: {
          skills: [],
          tools: [],
          attachedRepos: [],
          mcpAllowlist: [],
          repoEdges: [],
        },
      }))
      return agent
    },
    [],
  )

  const patchAgent = useCallback(
    async (id: string, patch: AgentUpdateInput): Promise<AgentResponse> => {
      const { agent } = await callApi<{ ok: true; agent: AgentResponse }>(
        rpc.api.agents[':id'].$patch({ param: { id }, json: patch }),
      )
      setTopLevel((prev) => ({
        ...prev,
        agents: prev.agents.map((a) => (a.id === id ? agent : a)),
      }))
      return agent
    },
    [],
  )

  const removeAgent = useCallback(async (id: string): Promise<void> => {
    await callApi<{ ok: true; id: string }>(
      rpc.api.agents[':id'].$delete({ param: { id } }),
    )
    setTopLevel((prev) => ({
      ...prev,
      agents: prev.agents.filter((a) => a.id !== id),
    }))
    setAgentResources((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // ─── Per-agent resource mutations ──────────────────────────────────────

  const createSkill = useCallback(
    async (
      agentId: string,
      input: SkillCreateInput,
    ): Promise<SkillResponse> => {
      const { skill } = await callApi<{ ok: true; skill: SkillResponse }>(
        rpc.api.agents[':agentId'].skills.$post({
          param: { agentId },
          json: input,
        }),
      )
      setAgentResources((prev) => {
        const current: AgentResources = prev[agentId] ?? {
          skills: [],
          tools: [],
          attachedRepos: [],
          mcpAllowlist: [],
          repoEdges: [],
        }
        return {
          ...prev,
          [agentId]: { ...current, skills: [...current.skills, skill] },
        }
      })
      return skill
    },
    [],
  )

  const createTool = useCallback(
    async (agentId: string, input: ToolCreateInput): Promise<ToolResponse> => {
      const { tool } = await callApi<{ ok: true; tool: ToolResponse }>(
        rpc.api.agents[':agentId'].tools.$post({
          param: { agentId },
          json: input,
        }),
      )
      setAgentResources((prev) => {
        const current: AgentResources = prev[agentId] ?? {
          skills: [],
          tools: [],
          attachedRepos: [],
          mcpAllowlist: [],
          repoEdges: [],
        }
        return {
          ...prev,
          [agentId]: { ...current, tools: [...current.tools, tool] },
        }
      })
      return tool
    },
    [],
  )

  const attachRepo = useCallback(
    async (
      agentId: string,
      input: AttachRepoInput,
    ): Promise<AttachedRepoResponse> => {
      const { attachment } = await callApi<{
        ok: true
        attachment: AttachedRepoResponse
      }>(
        rpc.api.agents[':agentId'].repos.$post({
          param: { agentId },
          json: input,
        }),
      )
      setAgentResources((prev) => {
        const current: AgentResources = prev[agentId] ?? {
          skills: [],
          tools: [],
          attachedRepos: [],
          mcpAllowlist: [],
          repoEdges: [],
        }
        // Replace any existing attachment for the same repo id (shouldn't
        // happen — the server rejects duplicates — but defend against a race).
        const filtered = current.attachedRepos.filter(
          (a) => a.repo.id !== attachment.repo.id,
        )
        return {
          ...prev,
          [agentId]: {
            ...current,
            attachedRepos: [...filtered, attachment],
          },
        }
      })
      return attachment
    },
    [],
  )

  // ─── Shared-resource mutations ─────────────────────────────────────────

  const createRepo = useCallback(
    async (
      input: RepoCreateInput,
    ): Promise<{ repo: RepoResponse; existed: boolean }> => {
      const res = await callApi<{
        ok: true
        existed: boolean
        repo: RepoResponse
      }>(rpc.api.repos.$post({ json: input }))
      setTopLevel((prev) => {
        // Dedupe: if the returned row already sits in our list (existed=true
        // or a concurrent fetch raced ahead), leave it alone. Otherwise
        // append.
        if (prev.repos.some((r) => r.id === res.repo.id)) return prev
        return { ...prev, repos: [...prev.repos, res.repo] }
      })
      return { repo: res.repo, existed: res.existed }
    },
    [],
  )

  const createLlmProvider = useCallback(
    async (input: LlmProviderCreateInput): Promise<LlmProviderResponse> => {
      const { llmProvider } = await callApi<{
        ok: true
        llmProvider: LlmProviderResponse
      }>(rpc.api['llm-providers'].$post({ json: input }))
      setTopLevel((prev) => ({
        ...prev,
        llmProviders: [...prev.llmProviders, llmProvider],
      }))
      return llmProvider
    },
    [],
  )

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      status,
      error,
      agents: topLevel.agents,
      repos: topLevel.repos,
      mcpConnections: topLevel.mcpConnections,
      llmProviders: topLevel.llmProviders,
      agentResources,
      refresh,
      createAgent,
      patchAgent,
      removeAgent,
      getAgent,
      createSkill,
      createTool,
      attachRepo,
      createRepo,
      createLlmProvider,
    }),
    [
      status,
      error,
      topLevel,
      agentResources,
      refresh,
      createAgent,
      patchAgent,
      removeAgent,
      getAgent,
      createSkill,
      createTool,
      attachRepo,
      createRepo,
      createLlmProvider,
    ],
  )

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}
