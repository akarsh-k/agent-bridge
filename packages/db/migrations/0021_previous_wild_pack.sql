CREATE TABLE "scorecard_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"top_k" integer NOT NULL,
	"query_count" integer NOT NULL,
	"judged_count" integer NOT NULL,
	"embedding_model" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"strategy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aggregates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scorecard_runs" ADD CONSTRAINT "scorecard_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scorecard_runs_agent_idx" ON "scorecard_runs" USING btree ("agent_id","created_at");