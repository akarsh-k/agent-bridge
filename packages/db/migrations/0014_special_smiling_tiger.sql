ALTER TABLE "skills" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "always_include" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing skills predate lazy loading and have no description; default
-- them to eager (always include) to preserve current behaviour. New
-- skills get `false` from the column default and become lazy unless the
-- operator opts in via the skill-sheet checkbox.
UPDATE "skills" SET "always_include" = true;