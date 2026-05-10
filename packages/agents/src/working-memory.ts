/**
 * Read the current working-memory scratchpad for an agent. Powers the
 * "Current scratchpad" panel on the Memory tab — the surface that
 * makes the Skill-vs-Working-memory distinction tangible by showing
 * what the LLM has actually written into its notebook over time.
 *
 * Read-only on purpose. Resetting/editing the scratchpad server-side
 * requires routing through Mastra's `updateWorkingMemory` API —
 * straightforward but out of scope for the viewer pass.
 *
 * Storage backend: Mastra's PostgresStore reads from the `mastra`
 * schema. We construct a minimal Memory instance (storage only — no
 * vector arm needed for working memory) and call its
 * `getWorkingMemory({ resourceId, threadId, memoryConfig })` method.
 * Mastra handles the scope dispatch (per-thread vs per-resource)
 * based on the memoryConfig we pass.
 */

import { eq } from 'drizzle-orm'
import { Memory } from '@mastra/memory'
import { PostgresStore } from '@mastra/pg'
import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import type { AgentMemoryConfig } from '@agent-bridge/shared'

const MASTRA_SCHEMA_NAME = 'mastra'
const MASTRA_STORE_ID = 'agent-bridge-main'

export interface CurrentWorkingMemory {
  /** Markdown content the LLM has written. Empty string when the
   *  scratchpad exists but is blank; null when working memory is
   *  disabled or no row has been created yet. */
  readonly content: string | null
  /** Echoes the scope from the agent's memoryConfig so the UI knows
   *  whether the value is per-thread or per-agent. */
  readonly scope: 'thread' | 'resource'
  /** True when the agent has memoryEnabled=false or no working-memory
   *  config — UI shows a friendly "not enabled" state. */
  readonly disabled: boolean
}

export async function getCurrentWorkingMemory(
  handle: AgentBridgeDb,
  agentId: string,
  threadId?: string,
): Promise<CurrentWorkingMemory> {
  const { db } = handle

  const [agentRow] = await db
    .select({
      memoryEnabled: schema.agents.memoryEnabled,
      memoryConfig: schema.agents.memoryConfig,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1)
  if (!agentRow) {
    throw new Error(`[working-memory] agent ${agentId} not found`)
  }

  const config = agentRow.memoryConfig as AgentMemoryConfig | null
  const wm = config?.workingMemory
  const wmEnabled = wm?.enabled === true
  const scope: 'thread' | 'resource' = wm?.scope ?? 'resource'

  if (!agentRow.memoryEnabled || !wmEnabled) {
    return { content: null, scope, disabled: true }
  }

  // Per-thread scope without a thread id: caller can't possibly want a
  // specific thread's scratchpad. Tell the UI the slot is empty rather
  // than guessing at one — picking "the latest thread" silently would
  // hide the fact that the user hasn't selected one.
  if (scope === 'thread' && !threadId) {
    return { content: null, scope, disabled: false }
  }

  const storage = new PostgresStore({
    id: MASTRA_STORE_ID,
    pool: handle.pool,
    schemaName: MASTRA_SCHEMA_NAME,
  })

  // Strip semanticRecall before constructing Memory: Mastra refuses
  // to instantiate Memory with `semanticRecall` configured unless a
  // vector store is also wired up — but this viewer is read-only and
  // doesn't need (or want) the vector arm. buildAgent does the same
  // dance via `stripSemanticRecall` for the same reason. We also
  // drop `lastMessages` since we only care about working memory
  // here; no point hauling in the message-replay config either.
  type MemoryArg = ConstructorParameters<typeof Memory>[0]
  type MemoryOptions = NonNullable<MemoryArg>['options']
  const viewerConfig: AgentMemoryConfig = {
    ...(config?.workingMemory ? { workingMemory: config.workingMemory } : {}),
  }
  const memory = new Memory({
    storage,
    options: viewerConfig as unknown as MemoryOptions,
  })

  const resourceId = `agent:${agentId}`

  // Mastra requires `threadId` even when reading resource-scoped WM.
  // For resource scope, supply a stable sentinel — Mastra will read
  // the resource-scoped store regardless of the thread id supplied.
  const effectiveThreadId =
    scope === 'thread'
      ? threadId!
      : (threadId ?? `agent-resource-readonly-${agentId}`)

  try {
    const content = await memory.getWorkingMemory({
      threadId: effectiveThreadId,
      resourceId,
    })
    return { content: content ?? '', scope, disabled: false }
  } catch (err) {
    // Mastra throws when the thread id doesn't exist in storage. For
    // the resource-scope case that's expected on a fresh agent — the
    // resource row hasn't been created yet because no run has touched
    // it. Treat as "empty" rather than propagating the error.
    const msg = err instanceof Error ? err.message : ''
    if (
      msg.includes('not found') ||
      msg.toLowerCase().includes('does not exist')
    ) {
      return { content: '', scope, disabled: false }
    }
    throw err
  }
}
