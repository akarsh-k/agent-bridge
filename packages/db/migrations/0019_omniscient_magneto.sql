CREATE TABLE "mcp_connection_tools" (
	"mcp_connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_tools_mcp_connection_id_tool_name_pk" PRIMARY KEY("mcp_connection_id","tool_name")
);
--> statement-breakpoint
ALTER TABLE "mcp_connection_tools" ADD CONSTRAINT "mcp_connection_tools_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;