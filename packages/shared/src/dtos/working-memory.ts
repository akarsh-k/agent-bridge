/**
 * Read-only snapshot of an agent's working-memory scratchpad. The
 * Memory tab uses this to show "what the LLM has actually written"
 * vs the operator-authored template.
 */

import { z } from 'zod'

export const workingMemoryResponseSchema = z.object({
  ok: z.literal(true),
  /** Markdown content; empty string means "exists but blank";
   *  null means working memory isn't enabled or no row yet. */
  content: z.string().nullable(),
  /** Echoes the configured scope so the UI can decide whether to
   *  show the per-thread picker. */
  scope: z.enum(['thread', 'resource']),
  /** True when memoryEnabled=false or workingMemory is disabled on
   *  the agent's config. UI shows a friendly "not enabled" state. */
  disabled: z.boolean(),
})
export type WorkingMemoryResponse = z.infer<typeof workingMemoryResponseSchema>
