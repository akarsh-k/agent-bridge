/**
 * WorkspaceProvider — mounts once at the app root and performs the initial
 * parallel fetch of every entity the global canvas renders.
 *
 * Loading strategy:
 *
 *   t=0   kick off 4 top-level fetches in parallel: agents, repos,
 *         mcpConnections, llmProviders.
 *   t=1   once `agents` resolves, fan out per-agent sub-resource fetches
 *         (skills, tools, attachedRepos, mcpAllowlist, repoRelationships) in
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
  AgentFileAttachInput,
  AgentFileResponse,
  AgentResponse,
  AgentUpdateInput,
  AllowlistEntry,
  AllowlistEntryResponse,
  AttachRepoInput,
  AttachRepoUpdateInput,
  AttachedRepoResponse,
  FileResponse,
  FileUpdateInput,
  LlmProviderCreateInput,
  LlmProviderResponse,
  LlmProviderUpdateInput,
  McpConnectionCreateInput,
  McpConnectionResponse,
  McpConnectionUpdateInput,
  RepoCreateInput,
  RepoRelationshipCreateInput,
  RepoRelationshipResponse,
  RepoRelationshipUpdateInput,
  RepoResponse,
  RepoUpdateInput,
  SkillCreateInput,
  SkillResponse,
  SkillUpdateInput,
  ToolCreateInput,
  ToolResponse,
  ToolUpdateInput,
} from '@agent-bridge/shared'
import {
  WorkspaceContext,
  type AgentResources,
  type AttachedFile,
  type WorkspaceContextValue,
  type WorkspaceStatus,
} from '../workspace-context'
import { ApiError, apiBaseUrl, callApi, rpc } from '../rpc'

interface TopLevelData {
  agents: readonly AgentResponse[]
  repos: readonly RepoResponse[]
  files: readonly FileResponse[]
  mcpConnections: readonly McpConnectionResponse[]
  llmProviders: readonly LlmProviderResponse[]
}

const EMPTY_TOP_LEVEL: TopLevelData = {
  agents: [],
  repos: [],
  files: [],
  mcpConnections: [],
  llmProviders: [],
}

async function fetchTopLevel(): Promise<TopLevelData> {
  const [agents, repos, files, mcpConnections, llmProviders] =
    await Promise.all([
      callApi<{ ok: true; agents: readonly AgentResponse[] }>(
        rpc.api.agents.$get(),
      ).then((r) => r.agents),
      callApi<{ ok: true; repos: readonly RepoResponse[] }>(
        rpc.api.repos.$get(),
      ).then((r) => r.repos),
      callApi<{ ok: true; files: readonly FileResponse[] }>(
        rpc.api.files.$get(),
      ).then((r) => r.files),
      callApi<{ ok: true; mcpConnections: readonly McpConnectionResponse[] }>(
        rpc.api['mcp-connections'].$get(),
      ).then((r) => r.mcpConnections),
      callApi<{ ok: true; llmProviders: readonly LlmProviderResponse[] }>(
        rpc.api['llm-providers'].$get(),
      ).then((r) => r.llmProviders),
    ])
  return { agents, repos, files, mcpConnections, llmProviders }
}

async function fetchAgentResources(agentId: string): Promise<AgentResources> {
  // `Promise.allSettled` so a single per-resource endpoint failure
  // doesn't wipe out the whole panel. Earlier this used `Promise.all`,
  // and when the `agents/:agentId/files` route 500'd on a stale DTO
  // converter every other resource (repos, skills, MCP, etc.) also
  // disappeared from the Resources panel because the parent promise
  // rejected. Each resource now degrades to an empty list with a
  // console.error so the failure is visible but isolated; the rest of
  // the panel continues to render normally.
  const settle = <T,>(
    label: string,
    p: Promise<T>,
    fallback: T,
  ): Promise<T> =>
    p.catch((err) => {
      console.error(
        `[workspace] fetchAgentResources: ${label} failed for agent ${agentId}:`,
        err,
      )
      return fallback
    })

  const [
    skills,
    tools,
    attachedRepos,
    attachedFiles,
    mcpAllowlist,
    repoRelationships,
  ] = await Promise.all([
    settle(
      'skills',
      callApi<{ ok: true; skills: readonly SkillResponse[] }>(
        rpc.api.agents[':agentId'].skills.$get({ param: { agentId } }),
      ).then((r) => r.skills),
      [] as readonly SkillResponse[],
    ),
    settle(
      'tools',
      callApi<{ ok: true; tools: readonly ToolResponse[] }>(
        rpc.api.agents[':agentId'].tools.$get({ param: { agentId } }),
      ).then((r) => r.tools),
      [] as readonly ToolResponse[],
    ),
    settle(
      'repos',
      callApi<{ ok: true; attachments: readonly AttachedRepoResponse[] }>(
        rpc.api.agents[':agentId'].repos.$get({ param: { agentId } }),
      ).then((r) => r.attachments),
      [] as readonly AttachedRepoResponse[],
    ),
    settle(
      'files',
      callApi<{
        ok: true
        attachments: readonly {
          attachment: AgentFileResponse
          file: FileResponse
        }[]
      }>(
        rpc.api.agents[':agentId'].files.$get({ param: { agentId } }),
      ).then((r) => r.attachments),
      [] as readonly { attachment: AgentFileResponse; file: FileResponse }[],
    ),
    settle(
      'mcp-tools',
      callApi<{ ok: true; tools: readonly AllowlistEntryResponse[] }>(
        rpc.api.agents[':agentId']['mcp-tools'].$get({ param: { agentId } }),
      ).then((r) => r.tools),
      [] as readonly AllowlistEntryResponse[],
    ),
    settle(
      'repo-relationships',
      callApi<{ ok: true; relationships: readonly RepoRelationshipResponse[] }>(
        rpc.api.agents[':agentId']['repo-relationships'].$get({
          param: { agentId },
        }),
      ).then((r) => r.relationships),
      [] as readonly RepoRelationshipResponse[],
    ),
  ])
  return {
    skills,
    tools,
    attachedRepos,
    attachedFiles,
    mcpAllowlist,
    repoRelationships,
  }
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

  /**
   * Fingerprint of the MCP connection catalogue. When connections are
   * added / removed / replaced (via `refresh()`, create/remove hooks,
   * etc.), this string changes and the per-agent fan-out below refetches
   * `mcp-tools` from the server — so `agent_mcp_tools` rows dropped by
   * an FK cascade disappear from the tray without a full page reload.
   *
   * Relying on `topLevel.agents` alone is not enough: wiping
   * `mcp_connections` in SQL does not change the agent row, but every
   * allowlist entry became invalid server-side.
   */
  const mcpConnectionSig = useMemo(
    () => topLevel.mcpConnections.map((c) => c.id).sort().join('|'),
    [topLevel.mcpConnections],
  )

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
  }, [topLevel.agents, refreshTick, mcpConnectionSig])

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
          attachedFiles: [],
          mcpAllowlist: [],
          repoRelationships: [],
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
          attachedFiles: [],
          mcpAllowlist: [],
          repoRelationships: [],
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
          attachedFiles: [],
          mcpAllowlist: [],
          repoRelationships: [],
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

  const patchSkill = useCallback(
    async (
      agentId: string,
      skillId: string,
      patch: SkillUpdateInput,
    ): Promise<SkillResponse> => {
      const { skill } = await callApi<{ ok: true; skill: SkillResponse }>(
        rpc.api.agents[':agentId'].skills[':id'].$patch({
          param: { agentId, id: skillId },
          json: patch,
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            skills: cur.skills.map((s) => (s.id === skillId ? skill : s)),
          },
        }
      })
      return skill
    },
    [],
  )

  const patchTool = useCallback(
    async (
      agentId: string,
      toolId: string,
      patch: ToolUpdateInput,
    ): Promise<ToolResponse> => {
      const { tool } = await callApi<{ ok: true; tool: ToolResponse }>(
        rpc.api.agents[':agentId'].tools[':id'].$patch({
          param: { agentId, id: toolId },
          json: patch,
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            tools: cur.tools.map((t) => (t.id === toolId ? tool : t)),
          },
        }
      })
      return tool
    },
    [],
  )

  const removeSkill = useCallback(
    async (agentId: string, skillId: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api.agents[':agentId'].skills[':id'].$delete({
          param: { agentId, id: skillId },
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            skills: cur.skills.filter((s) => s.id !== skillId),
          },
        }
      })
    },
    [],
  )

  const removeTool = useCallback(
    async (agentId: string, toolId: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api.agents[':agentId'].tools[':id'].$delete({
          param: { agentId, id: toolId },
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            tools: cur.tools.filter((t) => t.id !== toolId),
          },
        }
      })
    },
    [],
  )

  const createRepoRelationship = useCallback(
    async (
      agentId: string,
      input: RepoRelationshipCreateInput,
    ): Promise<RepoRelationshipResponse> => {
      const { relationship } = await callApi<{ ok: true; relationship: RepoRelationshipResponse }>(
        rpc.api.agents[':agentId']['repo-relationships'].$post({
          param: { agentId },
          json: input,
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            repoRelationships: [...cur.repoRelationships, relationship],
          },
        }
      })
      return relationship
    },
    [],
  )

  const patchRepoRelationship = useCallback(
    async (
      agentId: string,
      relationshipId: string,
      patch: RepoRelationshipUpdateInput,
    ): Promise<RepoRelationshipResponse> => {
      const { relationship } = await callApi<{ ok: true; relationship: RepoRelationshipResponse }>(
        rpc.api.agents[':agentId']['repo-relationships'][':relationshipId'].$patch({
          param: { agentId, relationshipId },
          json: patch,
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            repoRelationships: cur.repoRelationships.map((e) => (e.id === relationshipId ? relationship : e)),
          },
        }
      })
      return relationship
    },
    [],
  )

  const removeRepoRelationship = useCallback(
    async (agentId: string, relationshipId: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api.agents[':agentId']['repo-relationships'][':relationshipId'].$delete({
          param: { agentId, relationshipId },
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            repoRelationships: cur.repoRelationships.filter((e) => e.id !== relationshipId),
          },
        }
      })
    },
    [],
  )

  const patchAttachedRepo = useCallback(
    async (
      agentId: string,
      repoId: string,
      patch: AttachRepoUpdateInput,
    ): Promise<AttachedRepoResponse> => {
      const { attachment } = await callApi<{
        ok: true
        attachment: AttachedRepoResponse
      }>(
        rpc.api.agents[':agentId'].repos[':repoId'].$patch({
          param: { agentId, repoId },
          json: patch,
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            attachedRepos: cur.attachedRepos.map((a) =>
              a.repo.id === repoId ? attachment : a,
            ),
          },
        }
      })
      return attachment
    },
    [],
  )

  const detachRepo = useCallback(
    async (agentId: string, repoId: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api.agents[':agentId'].repos[':repoId'].$delete({
          param: { agentId, repoId },
        }),
      )
      setAgentResources((prev) => {
        const cur = prev[agentId]
        if (!cur) return prev
        return {
          ...prev,
          [agentId]: {
            ...cur,
            attachedRepos: cur.attachedRepos.filter(
              (a) => a.repo.id !== repoId,
            ),
            // Also drop relationships referencing the detached repo.
            repoRelationships: cur.repoRelationships.filter(
              (e) => e.fromRepoId !== repoId && e.toRepoId !== repoId,
            ),
          },
        }
      })
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
          attachedFiles: [],
          mcpAllowlist: [],
          repoRelationships: [],
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

  const patchLlmProviderModels = useCallback(
    (id: string, models: LlmProviderResponse['models']): void => {
      setTopLevel((prev) => ({
        ...prev,
        llmProviders: prev.llmProviders.map((p) =>
          p.id === id ? { ...p, models } : p,
        ),
      }))
    },
    [],
  )

  const patchLlmProvider = useCallback(
    async (
      id: string,
      patch: LlmProviderUpdateInput,
    ): Promise<LlmProviderResponse> => {
      const { llmProvider } = await callApi<{
        ok: true
        llmProvider: LlmProviderResponse
      }>(
        rpc.api['llm-providers'][':id'].$patch({
          param: { id },
          json: patch,
        }),
      )
      setTopLevel((prev) => ({
        ...prev,
        llmProviders: prev.llmProviders.map((p) =>
          p.id === id ? llmProvider : p,
        ),
      }))
      return llmProvider
    },
    [],
  )

  const removeLlmProvider = useCallback(async (id: string): Promise<void> => {
    await callApi<{ ok: true }>(
      rpc.api['llm-providers'][':id'].$delete({ param: { id } }),
    )
    setTopLevel((prev) => ({
      ...prev,
      llmProviders: prev.llmProviders.filter((p) => p.id !== id),
      // Server cascades agents.llm_provider_id → null. Reflect locally.
      agents: prev.agents.map((a) =>
        a.llmProviderId === id
          ? { ...a, llmProviderId: null, model: null }
          : a,
      ),
    }))
  }, [])

  const patchRepo = useCallback(
    async (id: string, patch: RepoUpdateInput): Promise<RepoResponse> => {
      const { repo } = await callApi<{ ok: true; repo: RepoResponse }>(
        rpc.api.repos[':id'].$patch({ param: { id }, json: patch }),
      )
      setTopLevel((prev) => ({
        ...prev,
        repos: prev.repos.map((r) => (r.id === id ? repo : r)),
      }))
      return repo
    },
    [],
  )

  const removeRepo = useCallback(async (id: string): Promise<void> => {
    await callApi<{ ok: true }>(
      rpc.api.repos[':id'].$delete({ param: { id } }),
    )
    setTopLevel((prev) => ({
      ...prev,
      repos: prev.repos.filter((r) => r.id !== id),
    }))
    // Mirror the server-side FK cascade in local state. The backend
    // drops both `agent_repos` (attached-repo entries) AND `repo_relationships`
    // that reference the deleted repo; if we only update one, the
    // relationships UI shows orphan rows with no resolvable from/to repo.
    setAgentResources((prev) => {
      let changed = false
      const next: Record<string, AgentResources> = {}
      for (const [agentId, bundle] of Object.entries(prev)) {
        const filteredAttached = bundle.attachedRepos.filter(
          (a) => a.repo.id !== id,
        )
        const filteredRelationships = bundle.repoRelationships.filter(
          (e) => e.fromRepoId !== id && e.toRepoId !== id,
        )
        if (
          filteredAttached.length === bundle.attachedRepos.length &&
          filteredRelationships.length === bundle.repoRelationships.length
        ) {
          next[agentId] = bundle
          continue
        }
        changed = true
        next[agentId] = {
          ...bundle,
          attachedRepos: filteredAttached,
          repoRelationships: filteredRelationships,
        }
      }
      return changed ? next : prev
    })
  }, [])

  // ─── Knowledge files ───────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (args: {
      file: File
      name?: string
      threadId?: string
      ephemeral?: boolean
      contextualRetrieval?: boolean
    }): Promise<{ file: FileResponse; duplicate: boolean }> => {
      // Hono's typed RPC doesn't expose a multipart helper; build the
      // FormData by hand and route through `callApi` (which handles the
      // structured-error envelope identically to typed calls).
      const formData = new FormData()
      formData.append('file', args.file)
      if (args.name) formData.append('name', args.name)
      if (args.threadId) formData.append('threadId', args.threadId)
      if (args.ephemeral) formData.append('ephemeral', 'true')
      if (args.contextualRetrieval)
        formData.append('contextualRetrieval', 'true')
      const result = await callApi<{
        ok: true
        file: FileResponse
        duplicate: boolean
      }>(
        fetch(`${apiBaseUrl}/api/files`, {
          method: 'POST',
          body: formData,
        }),
      )
      setTopLevel((prev) => {
        // Dedup if the server returned an existing row.
        const filtered = prev.files.filter((f) => f.id !== result.file.id)
        return { ...prev, files: [result.file, ...filtered] }
      })
      return { file: result.file, duplicate: result.duplicate }
    },
    [],
  )

  const patchFile = useCallback(
    async (id: string, patch: FileUpdateInput): Promise<FileResponse> => {
      const { file } = await callApi<{ ok: true; file: FileResponse }>(
        rpc.api.files[':id'].$patch({ param: { id }, json: patch }),
      )
      setTopLevel((prev) => ({
        ...prev,
        files: prev.files.map((f) => (f.id === id ? file : f)),
      }))
      // Mirror into per-agent attached files so the Resources panel
      // sees the new name/description without a refetch.
      setAgentResources((prev) => {
        let changed = false
        const next: Record<string, AgentResources> = {}
        for (const [agentId, bundle] of Object.entries(prev)) {
          const updated = bundle.attachedFiles.map((a) =>
            a.file.id === id ? { ...a, file } : a,
          )
          if (
            updated.length === bundle.attachedFiles.length &&
            updated.every((a, i) => a === bundle.attachedFiles[i])
          ) {
            next[agentId] = bundle
            continue
          }
          changed = true
          next[agentId] = { ...bundle, attachedFiles: updated }
        }
        return changed ? next : prev
      })
      return file
    },
    [],
  )

  const removeFile = useCallback(async (id: string): Promise<void> => {
    await callApi<{ ok: true }>(
      rpc.api.files[':id'].$delete({ param: { id } }),
    )
    setTopLevel((prev) => ({
      ...prev,
      files: prev.files.filter((f) => f.id !== id),
    }))
    // Server's FK cascade drops `agent_files` rows; mirror it.
    setAgentResources((prev) => {
      let changed = false
      const next: Record<string, AgentResources> = {}
      for (const [agentId, bundle] of Object.entries(prev)) {
        const filtered = bundle.attachedFiles.filter(
          (a) => a.file.id !== id,
        )
        if (filtered.length === bundle.attachedFiles.length) {
          next[agentId] = bundle
          continue
        }
        changed = true
        next[agentId] = { ...bundle, attachedFiles: filtered }
      }
      return changed ? next : prev
    })
  }, [])

  const reingestFile = useCallback(
    async (id: string): Promise<FileResponse> => {
      // Optimistic flip to `pending` BEFORE the POST goes out. The
      // FileRow on the Library page subscribes to `file:<id>` only
      // when the row is in flight; without this flip the SSE
      // subscription only opens AFTER the server response — which
      // races against the ingest pipeline's first publish (Redis
      // pub/sub doesn't buffer). Flipping locally first means the
      // EventSource is already established when the backend
      // publishes the first `knowledge.ingest.started` event.
      setTopLevel((prev) => ({
        ...prev,
        files: prev.files.map((f) =>
          f.id === id
            ? {
                ...f,
                ingestStatus: 'pending',
                ingestError: null,
                chunksDone: 0,
              }
            : f,
        ),
      }))
      try {
        const { file } = await callApi<{ ok: true; file: FileResponse }>(
          rpc.api.files[':id'].reingest.$post({ param: { id } }),
        )
        setTopLevel((prev) => ({
          ...prev,
          files: prev.files.map((f) => (f.id === id ? file : f)),
        }))
        return file
      } catch (err) {
        // POST failed. Don't snapshot-restore: another mutation could
        // have landed between the optimistic flip and now (e.g., a
        // concurrent description edit), and restoring a pre-flip snapshot
        // would clobber it. Re-fetch the row from the server instead —
        // that gives us the truth without overwriting anything.
        try {
          await refreshFile(id)
        } catch {
          /* swallowed — the original error below is the real story */
        }
        throw err
      }
    },
    // refreshFile is defined just below in the same provider; declared
    // via useCallback with [] deps so its identity is stable across
    // renders. Listing it here just to satisfy the lint without
    // re-creating reingestFile on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const refreshFile = useCallback(
    async (id: string): Promise<FileResponse | null> => {
      try {
        const { file } = await callApi<{
          ok: true
          file: FileResponse
          chunkCount: number
        }>(rpc.api.files[':id'].$get({ param: { id } }))
        setTopLevel((prev) => ({
          ...prev,
          files: prev.files.map((f) => (f.id === id ? file : f)),
        }))
        return file
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found') return null
        throw err
      }
    },
    [],
  )

  const attachFile = useCallback(
    async (
      agentId: string,
      fileId: string,
      input?: AgentFileAttachInput,
    ): Promise<AttachedFile> => {
      const result = await callApi<{
        ok: true
        attachment: AgentFileResponse
        file: FileResponse
      }>(
        rpc.api.agents[':agentId'].files[':fileId'].$post({
          param: { agentId, fileId },
          json: input ?? {},
        }),
      )
      const attached: AttachedFile = {
        attachment: result.attachment,
        file: result.file,
      }
      setAgentResources((prev) => {
        const current: AgentResources = prev[agentId] ?? {
          skills: [],
          tools: [],
          attachedRepos: [],
          attachedFiles: [],
          mcpAllowlist: [],
          repoRelationships: [],
        }
        return {
          ...prev,
          [agentId]: {
            ...current,
            attachedFiles: [
              ...current.attachedFiles.filter(
                (a) => a.file.id !== fileId,
              ),
              attached,
            ],
          },
        }
      })
      return attached
    },
    [],
  )

  const detachFile = useCallback(
    async (agentId: string, fileId: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api.agents[':agentId'].files[':fileId'].$delete({
          param: { agentId, fileId },
        }),
      )
      setAgentResources((prev) => {
        const current = prev[agentId]
        if (!current) return prev
        return {
          ...prev,
          [agentId]: {
            ...current,
            attachedFiles: current.attachedFiles.filter(
              (a) => a.file.id !== fileId,
            ),
          },
        }
      })
    },
    [],
  )

  const createMcpConnection = useCallback(
    async (
      input: McpConnectionCreateInput,
    ): Promise<McpConnectionResponse> => {
      const { mcpConnection } = await callApi<{
        ok: true
        mcpConnection: McpConnectionResponse
      }>(rpc.api['mcp-connections'].$post({ json: input }))
      setTopLevel((prev) => ({
        ...prev,
        mcpConnections: [...prev.mcpConnections, mcpConnection],
      }))
      return mcpConnection
    },
    [],
  )

  const patchMcpConnection = useCallback(
    async (
      id: string,
      patch: McpConnectionUpdateInput,
    ): Promise<McpConnectionResponse> => {
      const { mcpConnection } = await callApi<{
        ok: true
        mcpConnection: McpConnectionResponse
      }>(
        rpc.api['mcp-connections'][':id'].$patch({
          param: { id },
          json: patch,
        }),
      )
      setTopLevel((prev) => ({
        ...prev,
        mcpConnections: prev.mcpConnections.map((c) =>
          c.id === id ? mcpConnection : c,
        ),
      }))
      // An update may rename the connection; mirror that into every
      // agent's `mcpAllowlist` entry so the tray label stays in sync
      // without a full refetch. We don't recompute `enabled` / tool
      // names — only the joined `mcpConnectionName` column is denormed.
      setAgentResources((prev) => {
        let changed = false
        const next: Record<string, AgentResources> = {}
        for (const [agentId, bundle] of Object.entries(prev)) {
          const hit = bundle.mcpAllowlist.some(
            (e) => e.mcpConnectionId === id,
          )
          if (!hit) {
            next[agentId] = bundle
            continue
          }
          changed = true
          next[agentId] = {
            ...bundle,
            mcpAllowlist: bundle.mcpAllowlist.map((e) =>
              e.mcpConnectionId === id
                ? { ...e, mcpConnectionName: mcpConnection.name }
                : e,
            ),
          }
        }
        return changed ? next : prev
      })
      return mcpConnection
    },
    [],
  )

  const removeMcpConnection = useCallback(
    async (id: string): Promise<void> => {
      await callApi<{ ok: true }>(
        rpc.api['mcp-connections'][':id'].$delete({
          param: { id },
        }),
      )
      setTopLevel((prev) => ({
        ...prev,
        mcpConnections: prev.mcpConnections.filter((c) => c.id !== id),
      }))
      // Drop every allowlist entry referencing the deleted connection.
      // The backend FK already cascaded; this keeps client state in sync.
      setAgentResources((prev) => {
        let changed = false
        const next: Record<string, AgentResources> = {}
        for (const [agentId, bundle] of Object.entries(prev)) {
          const before = bundle.mcpAllowlist.length
          const filtered = bundle.mcpAllowlist.filter(
            (e) => e.mcpConnectionId !== id,
          )
          if (filtered.length === before) {
            next[agentId] = bundle
            continue
          }
          changed = true
          next[agentId] = { ...bundle, mcpAllowlist: filtered }
        }
        return changed ? next : prev
      })
    },
    [],
  )

  const setAgentMcpTools = useCallback(
    async (
      agentId: string,
      tools: readonly AllowlistEntry[],
    ): Promise<readonly AllowlistEntryResponse[]> => {
      const { tools: next } = await callApi<{
        ok: true
        tools: readonly AllowlistEntryResponse[]
      }>(
        rpc.api.agents[':agentId']['mcp-tools'].$put({
          param: { agentId },
          json: { tools: [...tools] },
        }),
      )
      setAgentResources((prev) => {
        const bundle = prev[agentId]
        if (!bundle) return prev
        return {
          ...prev,
          [agentId]: { ...bundle, mcpAllowlist: next },
        }
      })
      return next
    },
    [],
  )

  // Single-row refresh. Patches both `repos[]` and any `attachedRepos`
  // entries in place — the latter matter because `RepoInspector` and the
  // repo group node both read the embedded copy. Used after a terminal
  // clone event arrives so the UI swaps the optimistic "cloning" state
  // for the authoritative server value without a full workspace refetch.
  const refreshRepo = useCallback(
    async (repoId: string): Promise<RepoResponse | null> => {
      try {
        const { repo } = await callApi<{ ok: true; repo: RepoResponse }>(
          rpc.api.repos[':id'].$get({ param: { id: repoId } }),
        )
        setTopLevel((prev) => ({
          ...prev,
          repos: prev.repos.map((r) => (r.id === repoId ? repo : r)),
        }))
        setAgentResources((prev) => {
          let changed = false
          const next: Record<string, AgentResources> = {}
          for (const [agentId, bundle] of Object.entries(prev)) {
            const hit = bundle.attachedRepos.some(
              (a) => a.repo.id === repoId,
            )
            if (!hit) {
              next[agentId] = bundle
              continue
            }
            changed = true
            next[agentId] = {
              ...bundle,
              attachedRepos: bundle.attachedRepos.map((a) =>
                a.repo.id === repoId ? { ...a, repo } : a,
              ),
            }
          }
          return changed ? next : prev
        })
        return repo
      } catch (err) {
        // A 404 is a normal outcome if the repo was deleted mid-clone.
        // Surface it to the console but don't tear the store.
        console.warn(`[workspace] refreshRepo(${repoId}) failed:`, err)
        return null
      }
    },
    [],
  )

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      status,
      error,
      agents: topLevel.agents,
      repos: topLevel.repos,
      files: topLevel.files,
      mcpConnections: topLevel.mcpConnections,
      llmProviders: topLevel.llmProviders,
      agentResources,
      refresh,
      createAgent,
      patchAgent,
      removeAgent,
      getAgent,
      createSkill,
      patchSkill,
      removeSkill,
      createTool,
      patchTool,
      removeTool,
      attachRepo,
      patchAttachedRepo,
      detachRepo,
      createRepoRelationship,
      patchRepoRelationship,
      removeRepoRelationship,
      createRepo,
      createLlmProvider,
      patchLlmProvider,
      removeLlmProvider,
      patchLlmProviderModels,
      patchRepo,
      removeRepo,
      uploadFile,
      patchFile,
      removeFile,
      reingestFile,
      refreshFile,
      attachFile,
      detachFile,
      createMcpConnection,
      patchMcpConnection,
      removeMcpConnection,
      setAgentMcpTools,
      refreshRepo,
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
      patchSkill,
      removeSkill,
      createTool,
      patchTool,
      removeTool,
      attachRepo,
      patchAttachedRepo,
      detachRepo,
      createRepoRelationship,
      patchRepoRelationship,
      removeRepoRelationship,
      createRepo,
      createLlmProvider,
      patchLlmProvider,
      removeLlmProvider,
      patchLlmProviderModels,
      patchRepo,
      removeRepo,
      uploadFile,
      patchFile,
      removeFile,
      reingestFile,
      refreshFile,
      attachFile,
      detachFile,
      createMcpConnection,
      patchMcpConnection,
      removeMcpConnection,
      setAgentMcpTools,
      refreshRepo,
    ],
  )

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}
