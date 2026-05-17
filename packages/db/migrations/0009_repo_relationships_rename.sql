-- Rename `repo_edges` → `repo_relationships`. Operator-curated cross-repo
-- relationships keep their data; only the table identifier changes. Index,
-- check constraint, and the three foreign-key constraints are renamed
-- alongside so a future schema dump stays internally consistent.

ALTER TABLE "repo_edges" RENAME TO "repo_relationships";
--> statement-breakpoint
ALTER INDEX "repo_edges_agent_idx" RENAME TO "repo_relationships_agent_idx";
--> statement-breakpoint
ALTER TABLE "repo_relationships" RENAME CONSTRAINT "repo_edges_distinct_repos" TO "repo_relationships_distinct_repos";
--> statement-breakpoint
ALTER TABLE "repo_relationships" RENAME CONSTRAINT "repo_edges_agent_id_agents_id_fk" TO "repo_relationships_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "repo_relationships" RENAME CONSTRAINT "repo_edges_from_repo_id_repos_id_fk" TO "repo_relationships_from_repo_id_repos_id_fk";
--> statement-breakpoint
ALTER TABLE "repo_relationships" RENAME CONSTRAINT "repo_edges_to_repo_id_repos_id_fk" TO "repo_relationships_to_repo_id_repos_id_fk";
