/**
 * Agent-run DTOs. Browser-safe; the SSE-tail and dispatcher code shares
 * these shapes with the frontend chat window (Phase 3e).
 *
 * Design notes:
 *   - `POST /api/agents/:agentId/runs` is 202-then-SSE, same pattern as
 *     the repo clone/index jobs (`repos-jobs.ts`). The response carries
 *     `runId` (the DB row id) and `streamId` (the SSE channel); the
 *     browser opens `GET /api/events/:streamId` immediately after.
 *   - `threadId` + `resourceId` are optional so the backend can default
 *     to `threadId = runId` and `resourceId = agent:<agentId>` for
 *     one-shot runs. When a chat client wants conversation continuity
 *     (Phase 3e) it passes the thread it was using previously.
 *   - We do NOT expose Mastra's thread id column on `runs` in this
 *     phase — the DB schema change ships with Phase 3g. Until then the
 *     values live only for the duration of the in-memory run.
 *   - `prompt` max is deliberately small (16 KB). A chat turn that
 *     large is almost always an accidental paste; a real "analyze this
 *     50 KB file" flow belongs behind a file-upload or a repo-scoped
 *     gitnexus tool, not on the chat body.
 *   - Identifier rules for `threadId` / `resourceId` mirror
 *     `streamId` (URL-safe, ≤128 chars). Mastra itself accepts any
 *     string, but we constrain so the UI can put them in URLs without
 *     percent-encoding surprises.
 */

import { z } from 'zod'

/**
 * Mirrors the `STREAM_ID` regex in `apps/backend/src/routes/events.ts`.
 * Duplicated here to keep the DTO module browser-safe (no backend
 * import) and so Zod can run it on the same input the SSE handler
 * already validates.
 */
const RUN_ID_LIKE = /^[a-zA-Z0-9_\-:.]{1,128}$/

export const agentRunCreateInputSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1, 'prompt is required')
      .max(16_000, 'prompt must be \u2264 16,000 characters'),
    /**
     * Memory thread to resume. Only used when the agent has
     * `memoryEnabled=true`. Omit for one-shot runs.
     */
    threadId: z.string().regex(RUN_ID_LIKE).optional(),
    /**
     * Memory resource. Defaults to `agent:<agentId>` server-side. Pass
     * explicitly to group multiple agents' threads under one user /
     * workspace.
     */
    resourceId: z.string().regex(RUN_ID_LIKE).optional(),
  })
  .strict()

export type AgentRunCreateInput = z.infer<typeof agentRunCreateInputSchema>

/**
 * 202 response shape for `POST /api/agents/:id/runs`. Kept deliberately
 * minimal — everything else the UI needs arrives via SSE as a
 * `run.started` frame, so there's no duplication between the POST body
 * and the first SSE event.
 */
export const agentRunCreateResponseSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  streamId: z.string().regex(RUN_ID_LIKE),
})

export type AgentRunCreateResponse = z.infer<typeof agentRunCreateResponseSchema>

/** `:agentId` URL param for the nested runs router. */
export const agentRunsAgentIdParamSchema = z.object({ agentId: z.uuid() })
export type AgentRunsAgentIdParam = z.infer<typeof agentRunsAgentIdParamSchema>
