CREATE TABLE "scorecard_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"query" text NOT NULL,
	"expected_snippets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_page" integer,
	"note" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scorecard_queries" ADD CONSTRAINT "scorecard_queries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scorecard_queries_agent_idx" ON "scorecard_queries" USING btree ("agent_id");