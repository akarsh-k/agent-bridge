-- Rename "mini-repo" columns to "codebase_inspection_report" so the
-- naming reflects what the payload actually is (a structured codebase
-- inspection report, not a repository). The data shape is unchanged;
-- only the column names move.
ALTER TABLE "runs" RENAME COLUMN "minirepo_json" TO "codebase_inspection_reports_json";
ALTER TABLE "agents" RENAME COLUMN "mini_repo_token_cap" TO "codebase_inspection_report_token_cap";
