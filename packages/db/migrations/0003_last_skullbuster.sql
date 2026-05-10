ALTER TABLE "agents" ADD COLUMN "inspector_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "callsite_json" jsonb;