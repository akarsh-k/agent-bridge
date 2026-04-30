/**
 * Agent conversation threads — wraps Mastra's `mastra.threads` +
 * `mastra.messages` storage so the chat UI can list past
 * conversations, replay one, and delete it.
 *
 * Mastra owns the storage; we just expose typed read/delete endpoints
 * over it. Thread IDs are UUIDs the frontend mints when starting a
 * fresh conversation. The resourceId pattern is `agent:<agentId>` —
 * the same one the dispatcher passes on every run.
 */

import { z } from 'zod'

// ─── List ────────────────────────────────────────────────────────────────

export const agentThreadSummarySchema = z.object({
  /** Mastra thread id — what the frontend sends as `threadId` on runs. */
  threadId: z.string(),
  /**
   * Operator-friendly label. Mastra auto-fills this when memory
   * generates one; otherwise the backend derives a short preview from
   * the first user message. `null` if neither exists yet.
   */
  title: z.string().nullable(),
  /** ISO8601 timestamps from `mastra.threads`. */
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Number of messages in the thread. Cheap to compute via `count(*)`
   * on `mastra.messages` keyed by thread; the chat UI uses it to
   * suppress empty threads and show a quick preview density.
   */
  messageCount: z.number().int().nonnegative(),
})
export type AgentThreadSummary = z.infer<typeof agentThreadSummarySchema>

export const agentThreadListResponseSchema = z.object({
  ok: z.literal(true),
  threads: z.array(agentThreadSummarySchema),
})

// ─── Messages (replay) ───────────────────────────────────────────────────

export const agentThreadMessageRoleEnum = z.enum([
  'user',
  'assistant',
  'system',
  'tool',
])
export type AgentThreadMessageRole = z.infer<typeof agentThreadMessageRoleEnum>

export const agentThreadMessageSchema = z.object({
  id: z.string(),
  role: agentThreadMessageRoleEnum,
  /** Plain-text content — Mastra's structured parts joined for display. */
  text: z.string(),
  createdAt: z.iso.datetime(),
})
export type AgentThreadMessage = z.infer<typeof agentThreadMessageSchema>

export const agentThreadMessagesResponseSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
  messages: z.array(agentThreadMessageSchema),
})

// ─── Path / param schemas ────────────────────────────────────────────────

export const agentThreadParamSchema = z.object({
  agentId: z.uuid(),
  threadId: z.string().min(1),
})
export type AgentThreadParam = z.infer<typeof agentThreadParamSchema>
