-- Contextual Retrieval becomes a per-file opt-in.
--
-- 1. `files.contextual_retrieval` — set from the upload toggle or the
--    Files-page action; replaces the env-var gate (which remains a
--    global force-on for tests).
-- 2. Rebuild `file_chunks.tsv` to include `context_blurb`, so BM25
--    searches the same contextual prefix the embedding input gets.
--    Dropping the column drops the dependent GIN index; both are
--    recreated, and the STORED column recomputes for existing rows
--    (blurb is NULL pre-feature, so coalesce keeps them intact).
ALTER TABLE "files" ADD COLUMN "contextual_retrieval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_chunks" DROP COLUMN "tsv";--> statement-breakpoint
ALTER TABLE "file_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("context_blurb", '') || ' ' || "text")) STORED;--> statement-breakpoint
CREATE INDEX "file_chunks_tsv_idx" ON "file_chunks" USING gin ("tsv");
