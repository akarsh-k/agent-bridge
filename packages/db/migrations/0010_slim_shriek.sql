DROP INDEX "repos_url_branch_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "repos_url_branch_uq" ON "repos" USING btree ("remote_url","branch") WHERE "repos"."deletion_pending" = false;