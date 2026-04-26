/**
 * Drizzle schema for Agent Bridge.
 *
 * Tables are added here phase-by-phase per `docs/PLAN.md`. This file is
 * currently an intentionally minimal scaffold so downstream packages can
 * depend on `@agent-bridge/db/schema` from Phase 0 onward without churning
 * their imports when real tables land in Phase 1.
 *
 * Phase 1 will add: agents, agent_memory_configs, llm_providers, tools,
 * skills, repos, repo_connections, mcp_connections, agent_mcp_connections,
 * mcp_tool_selections, chat_sessions, chat_messages, runs, run_events,
 * kg_indexes, wikis, canvas_layouts.
 */

import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * `_health` — Phase 0 smoke table. One row inserted on boot by the backend's
 * readiness probe so we can verify migrations ran and the DB is reachable.
 */
export const health = pgTable('_health', {
  id: serial('id').primaryKey(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type HealthRow = typeof health.$inferSelect
export type HealthInsert = typeof health.$inferInsert
