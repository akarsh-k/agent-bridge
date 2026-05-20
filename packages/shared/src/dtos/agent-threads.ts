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

// ─── Active run for thread ───────────────────────────────────────────────

/**
 * Returned by `GET /api/agents/:agentId/threads/:threadId/active-run`.
 * `run` is null when no pending/running row exists for the thread
 * (the common case for past conversations). When non-null, the chat
 * tab uses `runId` to re-subscribe to the SSE stream, restoring the
 * stream after a route change.
 */
export const agentThreadActiveRunResponseSchema = z.object({
  ok: z.literal(true),
  run: z
    .object({
      runId: z.uuid(),
      streamId: z.string(),
      status: z.enum(['pending', 'running']),
      /** The dispatched prompt text. Lets the chat UI reconstruct the
       *  user bubble when Mastra has not yet persisted the message to
       *  its store (the small but real window between POST /runs and
       *  the run's `finish` chunk). May begin with a callsite block. */
      inputPrompt: z.string(),
      /** When the run began. Used to keep the user bubble's createdAt
       *  consistent with the audit log. */
      startedAt: z.iso.datetime(),
    })
    .nullable(),
})
export type AgentThreadActiveRunResponse = z.infer<
  typeof agentThreadActiveRunResponseSchema
>
