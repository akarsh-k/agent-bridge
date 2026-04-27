ALTER TABLE "runs" ADD COLUMN "mastra_thread_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mastra_resource_id" text;--> statement-breakpoint
CREATE INDEX "runs_mastra_thread_idx" ON "runs" USING btree ("mastra_thread_id","started_at") WHERE "runs"."mastra_thread_id" IS NOT NULL;