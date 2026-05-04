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
ALTER TABLE "worker_events" ADD CONSTRAINT "worker_events_job_id_worker_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."worker_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_jobs" ADD CONSTRAINT "worker_jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_events_job_ts_idx" ON "worker_events" USING btree ("job_id","ts");--> statement-breakpoint
CREATE INDEX "worker_jobs_repo_started_idx" ON "worker_jobs" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE INDEX "worker_jobs_started_idx" ON "worker_jobs" USING btree ("started_at");