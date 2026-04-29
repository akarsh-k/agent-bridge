CREATE TABLE "bridge_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_template" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_tools_name_not_reserved" CHECK ("bridge_tools"."name" NOT LIKE 'query\_%' ESCAPE '\'),
	CONSTRAINT "bridge_tools_name_format" CHECK ("bridge_tools"."name" ~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "bridge_tool_name" text;--> statement-breakpoint
ALTER TABLE "bridge_tools" ADD CONSTRAINT "bridge_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_tools_name_uq" ON "bridge_tools" USING btree ("name");--> statement-breakpoint
CREATE INDEX "bridge_tools_agent_idx" ON "bridge_tools" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "runs_agent_bridge_tool_idx" ON "runs" USING btree ("agent_id","bridge_tool_name","started_at") WHERE "runs"."bridge_tool_name" IS NOT NULL;--> statement-breakpoint
-- Phase 7a: wire `bridge_tools` into the shared `set_updated_at()` trigger
-- list. The function itself was installed in `0000_solid_runaways.sql`;
-- per-table triggers are added manually because drizzle-kit doesn't
-- generate them from the schema DSL.
CREATE TRIGGER trg_bridge_tools_updated_at BEFORE UPDATE ON "bridge_tools" FOR EACH ROW EXECUTE FUNCTION set_updated_at();