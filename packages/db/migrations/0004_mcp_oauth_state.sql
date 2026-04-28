CREATE TABLE "mcp_oauth_state" (
	"mcp_connection_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"value_envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_state_mcp_connection_id_scope_key_pk" PRIMARY KEY("mcp_connection_id","scope_key")
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- `updated_at` trigger for the new table. Drizzle-kit does not emit triggers
-- from the schema DSL; the shared `set_updated_at()` function was installed
-- by the initial migration (`0000_solid_runaways.sql`), so we only wire the
-- per-table trigger here.
CREATE TRIGGER trg_mcp_oauth_state_updated_at BEFORE UPDATE ON "mcp_oauth_state" FOR EACH ROW EXECUTE FUNCTION set_updated_at();