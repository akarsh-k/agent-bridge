import type { Job } from 'bullmq'
import { z } from 'zod'

/**
 * Phase 0 smoke-test job. Proves the whole pipe is wired:
 *   backend/worker boot → Redis → BullMQ Queue → BullMQ Worker → handler runs.
 *
 * No GitNexus / DB / LLM dependency here. Those jobs land in Phase 1.
 */

export const pingJobSchema = z.object({
  note: z.string().trim().min(1).max(500),
  issuedAt: z.number().int().optional(),
})

export type PingJobInput = z.infer<typeof pingJobSchema>

export interface PingJobResult {
  readonly note: string
  readonly receivedAt: number
  readonly latencyMs: number
}

export async function handlePingJob(
  job: Job<unknown, PingJobResult>,
): Promise<PingJobResult> {
  const input = pingJobSchema.parse(job.data)
  const receivedAt = Date.now()
  const latencyMs = input.issuedAt ? receivedAt - input.issuedAt : 0

  await job.updateProgress({ stage: 'processing', pct: 50 })
  await job.log(`ping received: "${input.note}"`)
  await job.updateProgress({ stage: 'done', pct: 100 })

  return { note: input.note, receivedAt, latencyMs }
}
