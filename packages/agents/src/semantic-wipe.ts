/**
 * Wipe an agent's semantic-recall vectors. Used when the embedding
 * model serving an agent's vector store effectively changes — either
 * because the provider's `defaultEmbeddingModel` was edited or
 * because the agent was reassigned to a different provider with a
 * different (or no) embedding model.
 *
 * Stale vectors live in the same vector store but in an unusable
 * vector space (different model = different geometry). Querying
 * against them returns garbage results without erroring, so we
 * actively delete them and let semantic recall rebuild from the next
 * conversation onward.
 *
 * Side note: working memory + recent-message replay are NOT touched
 * by this — they're text-only and don't depend on embeddings. Only
 * the vector index gets reset.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import { PgVector } from '@mastra/pg'

const MASTRA_SCHEMA_NAME = 'mastra'
const MEMORY_OBSERVATION_PREFIX = 'memory_observations_'

let processVector: PgVector | null = null

/**
 * Reuse the same PgVector singleton `buildAgent` uses so connections
 * are pooled across this and the live runtime. Cheap to construct on
 * demand if `buildAgent` hasn't run yet (e.g. fresh process serving
 * just the wipe endpoint).
 */
function getProcessVector(connectionString: string): PgVector {
  if (processVector) return processVector
  processVector = new PgVector({
    id: 'agent-bridge-vector',
    connectionString,
    schemaName: MASTRA_SCHEMA_NAME,
  })
  return processVector
}

export interface WipeSemanticVectorsResult {
  /** Agents whose vectors we attempted to wipe. */
  readonly agentIds: readonly string[]
  /** Indexes touched (one per dimension Mastra has created). */
  readonly indexNames: readonly string[]
}

/**
 * Best-effort wipe: iterates every `memory_observations_*` index
 * Mastra has created, then for each (agent, index) pair issues a
 * `deleteVectors` call filtered by `resource_id`. Per-index failures
 * (e.g. a dimension that no longer matches anything) are swallowed
 * — the goal is to clear what we can and not block the user's edit
 * if a stray index is misbehaving.
 */
export async function wipeSemanticVectorsForAgents(
  db: AgentBridgeDb,
  agentIds: readonly string[],
): Promise<WipeSemanticVectorsResult> {
  if (agentIds.length === 0) {
    return { agentIds: [], indexNames: [] }
  }
  const vector = getProcessVector(db.connectionString)
  let allIndexes: string[]
  try {
    allIndexes = await vector.listIndexes()
  } catch {
    // No indexes yet (fresh DB, no semantic recall ever ran). Nothing
    // to wipe — return cleanly.
    return { agentIds, indexNames: [] }
  }
  const memoryIndexes = allIndexes.filter((n) =>
    n.startsWith(MEMORY_OBSERVATION_PREFIX),
  )
  if (memoryIndexes.length === 0) {
    return { agentIds, indexNames: [] }
  }
  await Promise.all(
    agentIds.flatMap((agentId) => {
      const resourceId = `agent:${agentId}`
      return memoryIndexes.map(async (indexName) => {
        try {
          await vector.deleteVectors({
            indexName,
            filter: { resource_id: resourceId },
          })
        } catch {
          // Per-index failures are non-fatal. Common cause: a stale
          // index from a previous embedding model whose dimension is
          // no longer in use. We don't want one bad index to block
          // the wipe across the rest.
        }
      })
    }),
  )
  return { agentIds, indexNames: memoryIndexes }
}
