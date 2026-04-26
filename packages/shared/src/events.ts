import { z } from 'zod'

/**
 * Shared SSE event envelope. Backend emits these on `/api/events/:streamId`;
 * frontend consumes them verbatim.
 *
 * Browser-safe.
 */

export const runEventKinds = [
  'run.started',
  'run.token',
  'run.step.started',
  'run.step.finished',
  'run.tool.called',
  'run.tool.result',
  'run.error',
  'run.finished',
  'worker.progress',
  'worker.log',
  'worker.finished',
  'worker.error',
  'ping',
] as const

export type RunEventKind = (typeof runEventKinds)[number]

export const runEventSchema = z.object({
  kind: z.enum(runEventKinds),
  ts: z.number().int(),
  streamId: z.string().min(1),
  data: z.unknown().optional(),
})

export type RunEvent = z.infer<typeof runEventSchema>

/** Format an event object as a single SSE frame. */
export function formatSseFrame(event: RunEvent): string {
  const payload = JSON.stringify(event)
  return `event: ${event.kind}\ndata: ${payload}\n\n`
}
