CREATE TABLE "repo_index_summary" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL,
	"indexed_commit_sha" text,
	"files" integer,
	"nodes" integer,
	"edges" integer,
	"communities" integer,
	"processes" integer,
	"embeddings" integer,
	"raw_meta_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_index_summary" ADD CONSTRAINT "repo_index_summary_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Mirror of the trigger-attachment pattern from 0000: drizzle-kit doesn't
-- emit triggers from the schema DSL, so we append this here. `set_updated_at()`
-- is already defined (initial migration) and re-used as-is.
CREATE TRIGGER trg_repo_index_summary_updated_at BEFORE UPDATE ON "repo_index_summary" FOR EACH ROW EXECUTE FUNCTION set_updated_at();