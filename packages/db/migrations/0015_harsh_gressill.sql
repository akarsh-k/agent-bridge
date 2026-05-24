CREATE TABLE "agent_files" (
	"agent_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_files_agent_id_file_id_pk" PRIMARY KEY("agent_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"parent_id" uuid,
	"chunk_index" integer NOT NULL,
	"page" integer,
	"section_path" text,
	"text" text NOT NULL,
	"context_blurb" text,
	"embedding_model" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"filename" text NOT NULL,
	"kind" text NOT NULL,
	"bytes" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"page_count" integer,
	"storage_path" text NOT NULL,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"chunks_done" integer DEFAULT 0 NOT NULL,
	"ingest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_files" (
	"thread_id" text NOT NULL,
	"file_id" uuid NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_files_thread_id_file_id_pk" PRIMARY KEY("thread_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_parent_id_file_chunks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."file_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_files" ADD CONSTRAINT "thread_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_chunks_file_idx" ON "file_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_chunks_parent_idx" ON "file_chunks" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_content_hash_uq" ON "files" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "thread_files_thread_idx" ON "thread_files" USING btree ("thread_id");--> statement-breakpoint
-- ─── Generated tsvector column for BM25 + GIN index ────────────────────────
-- drizzle-kit doesn't emit STORED GENERATED columns; appended by hand.
-- The 'english' dictionary is a v1 default; Phase 3 introduces a language-
-- detection step and switches per-row.
ALTER TABLE "file_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;--> statement-breakpoint
CREATE INDEX "file_chunks_tsv_idx" ON "file_chunks" USING gin ("tsv");--> statement-breakpoint
-- ─── HNSW index for cosine similarity ──────────────────────────────────────
-- pgvector's USING hnsw clause isn't supported by drizzle's index DSL yet.
-- Cosine ops because retrieval normalises to similarity, not distance.
CREATE INDEX "file_chunks_embedding_idx" ON "file_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- ─── updated_at trigger for files ──────────────────────────────────────────
CREATE TRIGGER trg_files_updated_at BEFORE UPDATE ON "files" FOR EACH ROW EXECUTE FUNCTION set_updated_at();