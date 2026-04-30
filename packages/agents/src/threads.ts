/**
 * Conversation thread accessor — wraps Mastra's `mastra.threads` +
 * `mastra.messages` storage so the backend can list/replay/delete an
 * agent's chat threads without spinning up a full `BuiltAgent`.
 *
 * Mastra owns the schema (per `docs/ARCHITECTURE.md` §7.1). The agent
 * dispatcher passes `resourceId = "agent:<agentId>"` on every run; we
 * filter by the same resourceId here to scope a list to one agent.
 *
 * The Mastra boundary stays inside this package — backend just calls
 * the exported functions.
 */

import type { AgentBridgeDb } from '@agent-bridge/db'
import { PostgresStore } from '@mastra/pg'
import type {
  MastraDBMessage,
  MastraMessageContentV2,
  MastraMessagePart,
} from '@mastra/core/agent'
import type { StorageThreadType } from '@mastra/core/memory'

const MASTRA_SCHEMA_NAME = 'mastra'
const MASTRA_STORE_ID = 'agent-bridge-main'

// ─── Types ───────────────────────────────────────────────────────────────

export interface AgentThreadSummary {
  readonly threadId: string
  readonly title: string | null
  readonly resourceId: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly messageCount: number
}

export type AgentThreadMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface AgentThreadMessage {
  readonly id: string
  readonly role: AgentThreadMessageRole
  readonly text: string
  readonly createdAt: Date
}

// ─── Storage handle ──────────────────────────────────────────────────────

/**
 * Cache one PostgresStore per AgentBridgeDb pool, plus its in-flight
 * init() promise. The store's `init()` creates the `mastra.*` tables
 * if they don't exist — necessary on a fresh install where no agent
 * has run yet, otherwise the first listThreads call fails with
 * `relation "mastra.messages" does not exist`. Awaiting the cached
 * promise on every call is free after the first; init returns
 * immediately when the schema is already there.
 */
interface StoreEntry {
  readonly store: PostgresStore
  readonly initPromise: Promise<void>
}
const storesByDb = new WeakMap<AgentBridgeDb, StoreEntry>()

function getStoreEntry(db: AgentBridgeDb): StoreEntry {
  let entry = storesByDb.get(db)
  if (!entry) {
    const store = new PostgresStore({
      id: MASTRA_STORE_ID,
      pool: db.pool,
      schemaName: MASTRA_SCHEMA_NAME,
    })
    entry = {
      store,
      initPromise: store.init().catch((err: unknown) => {
        // Don't swallow — re-throw so the next call retries (we don't
        // want to lock in a permanent failure if the DB blipped).
        storesByDb.delete(db)
        throw err
      }),
    }
    storesByDb.set(db, entry)
  }
  return entry
}

function resourceIdFor(agentId: string): string {
  return `agent:${agentId}`
}

// Mastra exposes domain stores via `getStore('memory')` (async). The
// memory domain is what owns `listThreads` / `listMessages` /
// `deleteThread`. We narrow to the methods we need.
type MemoryDomain = {
  listThreads(args: {
    filter?: { resourceId?: string }
    perPage?: number
    page?: number
    orderBy?: { field: string; direction: 'ASC' | 'DESC' }
  }): Promise<{ threads: StorageThreadType[] }>
  listMessages(args: {
    threadId: string
    perPage?: number | false
    page?: number
  }): Promise<{ messages: MastraDBMessage[] }>
  deleteThread(args: { threadId: string }): Promise<void>
}

async function getMemoryDomain(db: AgentBridgeDb): Promise<MemoryDomain> {
  const { store, initPromise } = getStoreEntry(db)
  await initPromise
  const memory = await store.getStore('memory')
  if (!memory) {
    throw new Error(
      '[threads] Mastra PostgresStore returned no memory domain after init',
    )
  }
  return memory as unknown as MemoryDomain
}

// ─── List ────────────────────────────────────────────────────────────────

/**
 * Return every thread Mastra has stored for an agent, newest first.
 * `messageCount` comes from a single `count(*)` per thread — cheap on
 * indexed `mastra.messages.thread_id`.
 *
 * `title` falls back to a short preview derived from the first user
 * message when Mastra hasn't generated one (memory-disabled agents
 * never produce one). If both are missing, returns `null` and the UI
 * shows "Untitled".
 */
export async function listAgentThreads(
  db: AgentBridgeDb,
  agentId: string,
  options: { limit?: number } = {},
): Promise<AgentThreadSummary[]> {
  const memory = await getMemoryDomain(db)
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200))

  const { threads } = await memory.listThreads({
    filter: { resourceId: resourceIdFor(agentId) },
    perPage: limit,
    page: 0,
    orderBy: { field: 'updatedAt', direction: 'DESC' },
  })

  const ids = threads.map((t) => t.id)
  const previews = await loadThreadPreviews(db, ids)

  return threads.map((t) => {
    const preview = previews.get(t.id)
    const title = (t.title?.trim() || preview?.title || null) ?? null
    return {
      threadId: t.id,
      title,
      resourceId: t.resourceId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: preview?.count ?? 0,
    }
  })
}

interface ThreadPreview {
  count: number
  title: string | null
}

async function loadThreadPreviews(
  db: AgentBridgeDb,
  threadIds: ReadonlyArray<string>,
): Promise<Map<string, ThreadPreview>> {
  const out = new Map<string, ThreadPreview>()
  if (threadIds.length === 0) return out

  // Count messages + grab the first-user-message text per thread in
  // one round-trip. Postgres aggregates so we reconstruct rows in JS.
  //
  // Table name nuance: Mastra's `MASTRA_SCHEMA_NAME = 'mastra'` is the
  // SCHEMA namespace, but the table itself is prefixed `mastra_*`. So
  // the fully-qualified name is `mastra.mastra_messages`, not
  // `mastra.messages` (the latter doesn't exist and trips
  // "relation not found").
  const result = await db.pool.query<{
    thread_id: string
    count: string
    first_user_text: string | null
  }>(
    `
    SELECT
      m.thread_id,
      COUNT(*)::bigint AS count,
      (
        SELECT mu.content::text
        FROM mastra.mastra_messages mu
        WHERE mu.thread_id = m.thread_id
          AND mu.role = 'user'
        ORDER BY mu."createdAt" ASC
        LIMIT 1
      ) AS first_user_text
    FROM mastra.mastra_messages m
    WHERE m.thread_id = ANY($1::text[])
    GROUP BY m.thread_id
    `,
    [threadIds.slice()],
  )

  for (const row of result.rows) {
    const count = Number(row.count)
    const title = derivePreviewTitle(row.first_user_text)
    out.set(row.thread_id, { count, title })
  }
  return out
}

/**
 * Best-effort title from the first user message's serialised content.
 * Mastra stores `content` as a JSON blob; parts have `{type:'text',
 * text:'...'}`. We strip down to the first non-empty text run and clip
 * to ~60 chars. Returns `null` if nothing parseable surfaces.
 */
function derivePreviewTitle(raw: string | null): string | null {
  if (!raw) return null
  let text: string | null = null
  try {
    const parsed = JSON.parse(raw) as Partial<MastraMessageContentV2> & {
      content?: string
    }
    if (typeof parsed.content === 'string') {
      text = parsed.content
    } else if (Array.isArray(parsed.parts)) {
      const textPart = parsed.parts.find(
        (p): p is Extract<MastraMessagePart, { type: 'text' }> =>
          (p as { type?: unknown }).type === 'text' &&
          typeof (p as { text?: unknown }).text === 'string',
      )
      text = textPart ? (textPart as { text: string }).text : null
    }
  } catch {
    return null
  }
  if (!text) return null
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return null
  return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed
}

// ─── Messages (replay) ───────────────────────────────────────────────────

/**
 * Return the full message list for a thread, oldest first. Used by the
 * chat UI when the user switches to an existing thread to render its
 * history. Each message's structured Mastra content is flattened to
 * a single text string for display.
 */
export async function getAgentThreadMessages(
  db: AgentBridgeDb,
  threadId: string,
): Promise<AgentThreadMessage[]> {
  const memory = await getMemoryDomain(db)
  const result = await memory.listMessages({
    threadId,
    perPage: 200,
    page: 0,
  })
  // listMessages may return latest-first; force chronological for replay.
  const sorted = result.messages
    .slice()
    .sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )
  return sorted.map((m) => ({
    id: m.id,
    role: m.role as AgentThreadMessageRole,
    text: extractTextFromContent(m.content),
    createdAt: m.createdAt,
  }))
}

function extractTextFromContent(content: MastraMessageContentV2): string {
  if (typeof content.content === 'string' && content.content.length > 0) {
    return content.content
  }
  if (!Array.isArray(content.parts)) return ''
  const textRuns: string[] = []
  for (const part of content.parts) {
    if (
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      textRuns.push((part as { text: string }).text)
    }
  }
  return textRuns.join('')
}

// ─── Delete ──────────────────────────────────────────────────────────────

/**
 * Remove a thread + all of its messages from Mastra storage. Cascade
 * is handled by Mastra's `deleteThread` (which removes the
 * `mastra.messages` rows for the thread under the same transaction).
 */
export async function deleteAgentThread(
  db: AgentBridgeDb,
  threadId: string,
): Promise<void> {
  const memory = await getMemoryDomain(db)
  await memory.deleteThread({ threadId })
}
