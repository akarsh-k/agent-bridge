/**
 * Derive a per-agent readiness checklist from workspace state.
 *
 * "Ready" is computed, never stored — we look at what the agent + its
 * workspace actually have, not a `published` flag. This keeps a single
 * source of truth: the moment the missing piece lands, the check
 * flips, and the moment it goes away, the check regresses.
 *
 * The checks are tailored:
 *   - Every agent needs a system prompt + a chat provider.
 *   - Inspector-enabled agents (the "coding helper" template) also
 *     need an embedding provider in the workspace AND at least one
 *     repo attached — without those, every inspector tool call comes
 *     back with "0 attached repos" and the agent looks broken.
 */

import { useMemo } from 'react'
import type {
  AgentResponse,
  AttachedRepoResponse,
  LlmProviderResponse,
  RepoResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'

export type ReadinessCheckId =
  | 'systemPrompt'
  | 'chatProvider'
  | 'embeddingProvider'
  | 'attachedRepo'

export type ReadinessAction =
  | {
      kind: 'tab'
      tab: 'configure' | 'resources'
      /** Optional DOM id to scroll into view after the tab mounts. The
       *  card polls for the element via requestAnimationFrame so it
       *  works through the tab's Suspense boundary. */
      scrollTo?: string
    }
  | { kind: 'open-provider-sheet'; defaultRole: 'chat' | 'embedding' }
  | { kind: 'open-attach-repo-sheet' }
  | { kind: 'navigate'; href: string }

export interface ReadinessCheck {
  id: ReadinessCheckId
  label: string
  body: string
  done: boolean
  actionLabel: string
  action: ReadinessAction
}

export interface Readiness {
  ready: boolean
  remaining: number
  checks: readonly ReadinessCheck[]
}

export function useAgentReadiness(agentId: string): Readiness {
  const { agents, llmProviders, repos, agentResources } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)
  // Stable per (agentId, resources) reference so the inner memo
  // dep-array doesn't churn every render.
  const attached = agentResources[agentId]?.attachedRepos

  return useMemo<Readiness>(
    () => computeReadiness(agent, llmProviders, repos, attached ?? []),
    [agent, llmProviders, repos, attached],
  )
}

/**
 * Pure version of the hook — call from places that already hold the
 * workspace data (e.g. the agents list page mapping over many agents).
 * The hook above is just a thin `useMemo` wrapper around this.
 */
export function computeReadiness(
  agent: AgentResponse | undefined,
  llmProviders: readonly LlmProviderResponse[],
  repos: readonly RepoResponse[],
  attached: readonly AttachedRepoResponse[],
): Readiness {
  if (!agent) {
    return { ready: false, remaining: 0, checks: [] }
  }
  const checks = computeChecks(agent, llmProviders, repos, attached)
  const remaining = checks.filter((c) => !c.done).length
  return { ready: remaining === 0, remaining, checks }
}

function computeChecks(
  agent: AgentResponse,
  llmProviders: readonly LlmProviderResponse[],
  repos: readonly RepoResponse[],
  attached: readonly AttachedRepoResponse[],
): readonly ReadinessCheck[] {
  const hasSystemPrompt =
    !!agent.systemPrompt && agent.systemPrompt.trim().length > 0
  const hasChatProvider = !!agent.llmProviderId
  const hasEmbedder = llmProviders.some((p) => p.role === 'embedding')
  const hasAttached = attached.length > 0
  const hasAnyRepo = repos.length > 0

  const checks: ReadinessCheck[] = [
    {
      id: 'systemPrompt',
      label: 'Set a system prompt',
      body: 'Tells the agent what it is and how to behave. Without one, replies fall back to a generic assistant tone.',
      done: hasSystemPrompt,
      actionLabel: 'Open Configure',
      action: {
        kind: 'tab',
        tab: 'configure',
        scrollTo: 'agent-prompt-section',
      },
    },
    {
      id: 'chatProvider',
      label: 'Assign a chat provider',
      body: 'The model that answers each turn. Pick from any chat-role provider in your workspace.',
      done: hasChatProvider,
      actionLabel:
        llmProviders.some((p) => p.role === 'chat')
          ? 'Open Configure'
          : 'Add chat provider',
      action: llmProviders.some((p) => p.role === 'chat')
        ? {
            kind: 'tab',
            tab: 'configure',
            scrollTo: 'agent-provider-section',
          }
        : { kind: 'open-provider-sheet', defaultRole: 'chat' },
    },
  ]

  if (agent.inspectorEnabled) {
    checks.push({
      id: 'embeddingProvider',
      label: 'Add an embedding provider',
      body: 'Workspace-wide. Powers code search and indexing for the inspector toolkit. One per workspace covers every coding agent.',
      done: hasEmbedder,
      actionLabel: 'Add embedding provider',
      action: { kind: 'open-provider-sheet', defaultRole: 'embedding' },
    })
    checks.push({
      id: 'attachedRepo',
      label: hasAnyRepo
        ? 'Attach a repo to this agent'
        : 'Add a repo to your workspace',
      body: hasAnyRepo
        ? 'Pick one of the repos in your library. The agent can only inspect repos it is attached to.'
        : 'Clone a repo into the workspace library first, then attach it here. Inspector tools return "0 repos" until something is attached.',
      done: hasAttached,
      actionLabel: hasAnyRepo ? 'Attach repo' : 'Add repo to library',
      action: hasAnyRepo
        ? { kind: 'open-attach-repo-sheet' }
        : { kind: 'navigate', href: '/library/repos' },
    })
  }

  return checks
}
