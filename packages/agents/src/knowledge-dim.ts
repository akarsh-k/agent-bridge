/**
 * `file_chunks.embedding` is the only runtime-sized vector column we
 * own (gitnexus manages its own subprocess storage; Mastra creates
 * `memory_observations_<dim>` indexes lazily per dim). When the
 * workspace embedding provider's reported dim drifts away from the
 * column's current dim, we have to rewrite the type — pgvector can't
 * mix dims in one column.
 *
 * Two entry points:
 *
 *   - `ensureFileChunksDim` — non-destructive. ALTERs the column when
 *     the table is empty (fresh install picking up its first provider,
 *     or post-rebuild reingest). Refuses with an explicit error when
 *     chunks already exist, so the caller routes through the
 *     destructive path on purpose.
 *
 *   - `rebuildFileChunksAtDim` — destructive. TRUNCATEs `file_chunks`,
 *     drops the HNSW index, ALTERs the column type, recreates the
 *     index. Used by the provider PATCH handler (when the operator
 *     confirms an embedding-model change) and the Library "Rebuild
 *     knowledge index" button.
 *
 * Both run as ordinary SQL via `db.pool.query` (drizzle's index DSL
 * can't model `USING hnsw`; we already manage this index by hand in
 * `0015_harsh_gressill.sql`).
 */

import type { PoolClient } from 'pg'

import type { AgentBridgeDb } from '@agent-bridge/db'

/** Name of the HNSW cosine index on `file_chunks.embedding`. Mirrors
 *  `0015_harsh_gressill.sql:67`. Kept in sync by hand. */
const HNSW_INDEX = 'file_chunks_embedding_idx'

/** Per-database advisory lock id used to serialize column-type DDL on
 *  `file_chunks.embedding`. Two ingests starting in parallel will both
 *  read the column dim, both see it doesn't match, and both try to
 *  DROP INDEX / ALTER COLUMN / CREATE INDEX — the second ones race
 *  with errors like "relation file_chunks_embedding_idx already
 *  exists". `pg_advisory_lock` on this id makes them queue up
 *  serially; the second caller wakes up to see the dim already
 *  matches and no-ops cleanly. The number is arbitrary; it just has
 *  to be unique across all advisory-lock namespaces in the database
 *  (Mastra uses none currently; gitnexus runs in its own process). */
const DIM_SYNC_LOCK_ID = 8674113201

/**
 * Run `fn` while holding the dim-sync advisory lock on a single pinned
 * client. `fn` receives the same client and MUST do all of its SQL
 * through it — otherwise we deadlock: with N concurrent callers and an
 * M-connection pool (M < N), every waiter holds one client while
 * blocked on `pg_advisory_lock`, the lock-holder would then need a
 * second client for the inner DDL but the pool is exhausted, and
 * nobody can make progress.
 *
 * Wrapping the work in a transaction lets us use `pg_advisory_xact_lock`
 * which auto-releases on COMMIT / ROLLBACK — even a thrown exception
 * inside `fn` frees the lock without needing a separate cleanup
 * statement.
 */
async function withDimLock<T>(
  db: AgentBridgeDb,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        DIM_SYNC_LOCK_ID,
      ])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        /* rollback errors aren't actionable — surface the real one */
      })
      throw err
    }
  } finally {
    client.release()
  }
}

/** Read the column dim + chunk count using a specific client. The
 *  public {@link readFileChunksDim} forwards to this via a pool client
 *  for callers outside the lock; the locked path calls it directly so
 *  the read happens on the same connection as the subsequent DDL. */
async function readFileChunksDimViaClient(
  client: PoolClient,
): Promise<FileChunksDimSnapshot> {
  const typeRes = await client.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
      WHERE attrelid = 'file_chunks'::regclass
        AND attname = 'embedding'
        AND NOT attisdropped`,
  )
  const raw = typeRes.rows[0]?.type ?? ''
  const match = raw.match(/vector\((\d+)\)/)
  const columnDim = match ? Number(match[1]) : null

  const countRes = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM file_chunks`,
  )
  const chunkCount = Number(countRes.rows[0]?.n ?? '0')

  return { columnDim, chunkCount }
}

export interface FileChunksDimSnapshot {
  readonly columnDim: number | null
  readonly chunkCount: number
}

/**
 * Read the current `vector(N)` parametrisation of `file_chunks.embedding`
 * plus the row count, in one pass. Returns `columnDim=null` if the
 * column type isn't a sized `vector` (shouldn't happen in practice —
 * migration 0015 created it as `vector(1024)`).
 */
export async function readFileChunksDim(
  db: AgentBridgeDb,
): Promise<FileChunksDimSnapshot> {
  const typeRes = await db.pool.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
      WHERE attrelid = 'file_chunks'::regclass
        AND attname = 'embedding'
        AND NOT attisdropped`,
  )
  const raw = typeRes.rows[0]?.type ?? ''
  const match = raw.match(/vector\((\d+)\)/)
  const columnDim = match ? Number(match[1]) : null

  const countRes = await db.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM file_chunks`,
  )
  const chunkCount = Number(countRes.rows[0]?.n ?? '0')

  return { columnDim, chunkCount }
}

export interface DimSyncResult {
  readonly changed: boolean
  readonly previousDim: number | null
  readonly currentDim: number
}

/**
 * Non-destructive sync. Called from `ingestKnowledgeFile` before the
 * first embed batch so a fresh workspace adapts to whatever dim the
 * configured embedding provider reports, without forcing the operator
 * to click anything.
 *
 * If chunks already exist at a different dim, throws — the caller
 * must route through `rebuildFileChunksAtDim` (via the provider PATCH
 * or the Library Rebuild button), which is the only place that
 * acknowledges the destructive side effect.
 */
export async function ensureFileChunksDim(
  db: AgentBridgeDb,
  targetDim: number,
): Promise<DimSyncResult> {
  return withDimLock(db, async (client) => {
    // Re-read inside the lock — a sibling caller may have just
    // altered the column to our target dim, in which case this is a
    // no-op and we return without firing redundant DDL.
    const snap = await readFileChunksDimViaClient(client)
    if (snap.columnDim === targetDim) {
      return {
        changed: false,
        previousDim: snap.columnDim,
        currentDim: targetDim,
      }
    }
    if (snap.chunkCount > 0) {
      throw new FileChunksDimMismatch(
        snap.columnDim,
        targetDim,
        snap.chunkCount,
      )
    }
    await alterEmbeddingTypeAndRebuildIndexViaClient(client, targetDim)
    return {
      changed: true,
      previousDim: snap.columnDim,
      currentDim: targetDim,
    }
  })
}

/**
 * Destructive rebuild. TRUNCATEs `file_chunks`, drops the HNSW index,
 * ALTERs the column to `vector(targetDim)`, recreates the index. Use
 * when the operator has confirmed a wipe (embedding-model change in
 * the provider PATCH, or the explicit Library rebuild action).
 *
 * Caller is responsible for queueing reingest of every `files` row
 * afterwards — this helper deals strictly with the schema-shape side.
 */
export async function rebuildFileChunksAtDim(
  db: AgentBridgeDb,
  targetDim: number,
): Promise<DimSyncResult> {
  return withDimLock(db, async (client) => {
    const snap = await readFileChunksDimViaClient(client)
    // Always TRUNCATE so the rebuild is unconditional — even when the
    // dim already matches we want every row gone (a "rebuild" implies
    // the operator wants a clean slate). Cheap on an empty table.
    await client.query(`TRUNCATE TABLE file_chunks`)
    if (snap.columnDim !== targetDim) {
      await alterEmbeddingTypeAndRebuildIndexViaClient(client, targetDim)
    }
    return {
      changed: snap.columnDim !== targetDim,
      previousDim: snap.columnDim,
      currentDim: targetDim,
    }
  })
}

async function alterEmbeddingTypeAndRebuildIndexViaClient(
  client: PoolClient,
  targetDim: number,
): Promise<void> {
  // Index has to go before the column type changes — HNSW is bound to
  // the column's vector(N) and can't survive a TYPE swap.
  await client.query(`DROP INDEX IF EXISTS ${HNSW_INDEX}`)
  // `USING NULL` is a no-op on an empty table but keeps the statement
  // legal if a future caller skips the TRUNCATE step.
  await client.query(
    `ALTER TABLE file_chunks
       ALTER COLUMN embedding TYPE vector(${targetDim}) USING NULL`,
  )
  await client.query(
    `CREATE INDEX ${HNSW_INDEX}
       ON file_chunks USING hnsw (embedding vector_cosine_ops)`,
  )
}

export class FileChunksDimMismatch extends Error {
  readonly previousDim: number | null
  readonly targetDim: number
  readonly chunkCount: number
  constructor(
    previousDim: number | null,
    targetDim: number,
    chunkCount: number,
  ) {
    super(
      `file_chunks.embedding is vector(${previousDim ?? '?'}) with ` +
        `${chunkCount} existing chunks, but the active embedding provider ` +
        `reports dim=${targetDim}. Run "Rebuild knowledge index" to ` +
        `wipe and re-ingest at the new dim.`,
    )
    this.name = 'FileChunksDimMismatch'
    this.previousDim = previousDim
    this.targetDim = targetDim
    this.chunkCount = chunkCount
  }
}
