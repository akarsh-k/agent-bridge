CREATE TABLE "agent_mcp_tools" (
	"agent_id" uuid NOT NULL,
	"mcp_connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_tools_agent_id_mcp_connection_id_tool_name_pk" PRIMARY KEY("agent_id","mcp_connection_id","tool_name")
);
--> statement-breakpoint
CREATE TABLE "agent_repos" (
	"agent_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"role" text,
	"description" text,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_repos_agent_id_repo_id_pk" PRIMARY KEY("agent_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text DEFAULT '' NOT NULL,
	"llm_provider_id" uuid,
	"model" text,
	"memory_enabled" boolean DEFAULT false NOT NULL,
	"memory_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"default_model" text,
	"api_key_envelope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command_or_url" text NOT NULL,
	"args_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_envelope" text,
	"headers_envelope" text,
	"allow_host_home" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"from_repo_id" uuid NOT NULL,
	"to_repo_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_edges_distinct_repos" CHECK ("repo_edges"."from_repo_id" <> "repo_edges"."to_repo_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"local_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"last_error" text,
	"git_pat_envelope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"payload_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input_prompt" text NOT NULL,
	"output_summary" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"markdown_body" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_llm_provider_id_llm_providers_id_fk" FOREIGN KEY ("llm_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_from_repo_id_repos_id_fk" FOREIGN KEY ("from_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_to_repo_id_repos_id_fk" FOREIGN KEY ("to_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_uq" ON "agents" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_label_uq" ON "llm_providers" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_name_uq" ON "mcp_connections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "repo_edges_agent_idx" ON "repo_edges" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_url_branch_uq" ON "repos" USING btree ("remote_url","branch");--> statement-breakpoint
CREATE INDEX "run_events_run_ts_idx" ON "run_events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_stream_id_uq" ON "runs" USING btree ("stream_id");--> statement-breakpoint
CREATE INDEX "runs_agent_started_idx" ON "runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_agent_name_uq" ON "skills" USING btree ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_agent_name_uq" ON "tools" USING btree ("agent_id","name");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────
-- `updated_at` triggers. Drizzle-kit does not emit triggers from the schema
-- DSL, so they are appended here as part of the initial migration. Kept in
-- one migration so the schema is always shipped as a single atomic unit.
-- Tables without an `updated_at` column (agent_mcp_tools, run_events) are
-- intentionally excluded.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_llm_providers_updated_at BEFORE UPDATE ON "llm_providers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_agents_updated_at BEFORE UPDATE ON "agents" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_skills_updated_at BEFORE UPDATE ON "skills" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_tools_updated_at BEFORE UPDATE ON "tools" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_repos_updated_at BEFORE UPDATE ON "repos" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_agent_repos_updated_at BEFORE UPDATE ON "agent_repos" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_repo_edges_updated_at BEFORE UPDATE ON "repo_edges" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_mcp_connections_updated_at BEFORE UPDATE ON "mcp_connections" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_runs_updated_at BEFORE UPDATE ON "runs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();