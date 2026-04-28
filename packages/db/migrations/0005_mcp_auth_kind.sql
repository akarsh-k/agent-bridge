ALTER TABLE "mcp_connections" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
-- Backfill. Pre-Phase-4H the only HTTP auth story was "set `headers`".
-- Any row that already carries a headers envelope kept using it
-- implicitly; make that explicit now so the new discriminator matches
-- observable behavior without forcing operators to re-save each row.
UPDATE "mcp_connections"
SET "auth_kind" = 'headers'
WHERE "transport" IN ('http', 'sse')
  AND "headers_envelope" IS NOT NULL;