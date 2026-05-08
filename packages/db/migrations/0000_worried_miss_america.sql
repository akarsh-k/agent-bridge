CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
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
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
	"memory_enabled" boolean DEFAULT false NOT NULL,
	"memory_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"default_model" text,
	"api_key_envelope" text,
	"models_json" jsonb,
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
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"allow_host_home" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_state" (
	"mcp_connection_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"value_envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_state_mcp_connection_id_scope_key_pk" PRIMARY KEY("mcp_connection_id","scope_key")
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
	"wiki_status" text DEFAULT 'none' NOT NULL,
	"wiki_generated_at" timestamp with time zone,
	"wiki_pages" integer,
	"wiki_last_error" text,
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
	"mastra_thread_id" text,
	"mastra_resource_id" text,
	"bridge_tool_name" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"prompt_tokens" integer,
	"completion_tokens" integer,
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
CREATE TABLE "worker_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"payload_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "worker_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"job_kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config_events" ADD CONSTRAINT "agent_config_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_llm_provider_id_llm_providers_id_fk" FOREIGN KEY ("llm_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tools" ADD CONSTRAINT "bridge_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_from_repo_id_repos_id_fk" FOREIGN KEY ("from_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_edges" ADD CONSTRAINT "repo_edges_to_repo_id_repos_id_fk" FOREIGN KEY ("to_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_events" ADD CONSTRAINT "worker_events_job_id_worker_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."worker_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_jobs" ADD CONSTRAINT "worker_jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_config_events_agent_ts_idx" ON "agent_config_events" USING btree ("agent_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_uq" ON "agents" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_tools_name_uq" ON "bridge_tools" USING btree ("name");--> statement-breakpoint
CREATE INDEX "bridge_tools_agent_idx" ON "bridge_tools" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_label_uq" ON "llm_providers" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_embedding_singleton_uq" ON "llm_providers" USING btree ("role") WHERE "llm_providers"."role" = 'embedding';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_name_uq" ON "mcp_connections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "repo_edges_agent_idx" ON "repo_edges" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_url_branch_uq" ON "repos" USING btree ("remote_url","branch");--> statement-breakpoint
CREATE INDEX "run_events_run_ts_idx" ON "run_events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_stream_id_uq" ON "runs" USING btree ("stream_id");--> statement-breakpoint
CREATE INDEX "runs_agent_started_idx" ON "runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_mastra_thread_idx" ON "runs" USING btree ("mastra_thread_id","started_at") WHERE "runs"."mastra_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_agent_bridge_tool_idx" ON "runs" USING btree ("agent_id","bridge_tool_name","started_at") WHERE "runs"."bridge_tool_name" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_agent_name_uq" ON "skills" USING btree ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_agent_name_uq" ON "tools" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "worker_events_job_ts_idx" ON "worker_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX "worker_jobs_repo_started_idx" ON "worker_jobs" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE INDEX "worker_jobs_started_idx" ON "worker_jobs" USING btree ("started_at");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────
-- `updated_at` triggers — drizzle-kit doesn't emit triggers from the
-- schema DSL so they're appended here. Tables without an `updated_at`
-- column (agent_mcp_tools, run_events, agent_config_events,
-- worker_jobs, worker_events) are intentionally excluded.
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
CREATE TRIGGER trg_mcp_oauth_state_updated_at BEFORE UPDATE ON "mcp_oauth_state" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_bridge_tools_updated_at BEFORE UPDATE ON "bridge_tools" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_runs_updated_at BEFORE UPDATE ON "runs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();