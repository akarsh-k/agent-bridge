ALTER TABLE "repos" ADD COLUMN "wiki_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "wiki_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "wiki_pages" integer;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "wiki_last_error" text;