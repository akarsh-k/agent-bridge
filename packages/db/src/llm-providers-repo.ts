/**
 * `llm_providers` read helpers. Currently a single `getForWorker` —
 * mirrors `repos-repo.ts`'s shape so future LLM-provider state
 * transitions (e.g. a `last_tested_at` column) live here too.
 *
 * Other than reads, the LLM-providers table is mutated exclusively by
 * the backend's CRUD routes (`apps/backend/src/routes/llm-providers.ts`)
 * which call drizzle directly — same separation of concerns the rest of
 * the schema follows.
 *
 * Node-only.
 */

import { eq } from 'drizzle-orm'
import type { AgentBridgeDb } from './client.js'
import { llmProviders, type LlmProviderRow } from './schema.js'

/**
 * Worker-side read of an LLM provider row. Used by the wiki worker to
 * grab the encrypted apiKey envelope + baseUrl + model at spawn time.
 *
 * Returns `null` if the row was deleted between enqueue and dequeue, in
 * which case the job handler should short-circuit gracefully.
 */
export async function getForWorker(
  handle: AgentBridgeDb,
  providerId: string,
): Promise<LlmProviderRow | null> {
  const [row] = await handle.db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.id, providerId))
    .limit(1)
  return row ?? null
}
