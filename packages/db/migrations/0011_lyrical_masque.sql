CREATE TABLE "agent_config_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"label" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "agent_config_events" ADD CONSTRAINT "agent_config_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_config_events_agent_ts_idx" ON "agent_config_events" USING btree ("agent_id","ts");