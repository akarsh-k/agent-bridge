/**
 * Zod schema mirroring `AgentMemoryConfig` (see domain.ts).
 *
 * This schema is the edge validator: every API handler that accepts a memory
 * config pipes the request body through `agentMemoryConfigSchema.parse(…)`
 * before touching the DB. The inferred type is kept assignment-compatible
 * with `AgentMemoryConfig` via a static assertion at the bottom of this file.
 *
 * Drift rule: if this schema and `AgentMemoryConfig` diverge, the static
 * assertion below will fail to compile. Fix the source of truth (domain.ts)
 * first, then mirror here. The Zod schema is stricter at runtime (it uses
 * `.strict()` on nested objects) so unknown Mastra options are rejected —
 * this surfaces drift early instead of silently passing garbage into Mastra.
 */

import { z } from 'zod'
import { memoryScopes, type AgentMemoryConfig } from '../domain.js'

const memoryScopeSchema = z.enum(memoryScopes)

const messageRangeSchema = z.union([
  z.number().int().nonnegative(),
  z
    .object({
      before: z.number().int().nonnegative(),
      after: z.number().int().nonnegative(),
    })
    .strict(),
])

const workingMemorySchema = z
  .object({
    enabled: z.boolean(),
    template: z.string().max(10_000).optional(),
    /**
     * JSON Schema describing structured working memory. We store it as an
     * opaque record — validating JSON Schema *itself* is out of scope; we let
     * Mastra surface errors at runtime if the shape is malformed.
     */
    schema: z.record(z.string(), z.unknown()).optional(),
    scope: memoryScopeSchema.optional(),
  })
  .strict()

const semanticRecallSchema = z
  .object({
    topK: z.number().int().positive().max(100).optional(),
    messageRange: messageRangeSchema.optional(),
    scope: memoryScopeSchema.optional(),
  })
  .strict()

export const agentMemoryConfigSchema = z
  .object({
    lastMessages: z
      .union([z.number().int().nonnegative().max(1_000), z.literal(false)])
      .optional(),
    workingMemory: workingMemorySchema.optional(),
    semanticRecall: semanticRecallSchema.optional(),
    generateTitle: z.boolean().optional(),
  })
  .strict()

export type AgentMemoryConfigInput = z.infer<typeof agentMemoryConfigSchema>

// Compile-time guard: the Zod-inferred shape must satisfy the TS interface.
// If Mastra's API evolves and we update domain.ts without mirroring here (or
// vice versa), this line stops compiling.
const _typecheck: AgentMemoryConfig = {} as AgentMemoryConfigInput
void _typecheck
