/**
 * Inspect WHY two specific scorecard queries miss. For each, find the gold
 * chunk's rank in the vector + BM25 arms, show the gold chunk, and show the
 * chunks that outrank it — to see what the retrieval preferred instead.
 * Read-only, no rerank, no full scorecard.
 *
 *   pnpm --filter @agent-bridge/tests exec tsx diag-misses.ts
 */

/* eslint-disable no-console */

import { createDb, schema } from '@agent-bridge/db'
import {
  buildEmbedder,
  embeddingFingerprint,
  runVectorSearch,
  runBm25Search,
} from '@agent-bridge/agents'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import { eq } from 'drizzle-orm'

loadRootDotenv(import.meta.url, { depth: 1 })

const AGENT_ID = '16138636-8ff7-4525-8be3-b131f3cba3f4'
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'

// The two residual misses (substring match against the saved query text).
const TARGETS = [
  'independent public authority',
  'sent to countries outside the EU',
]

const db = createDb({ connectionString: DB_URL, maxConnections: 6 })
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const goldRank = (hits: { text: string }[], gold: string[]): number => {
  const g = gold.map(norm)
  for (let i = 0; i < hits.length; i++) {
    if (g.some((s) => norm(hits[i]!.text).includes(s))) return i + 1
  }
  return 0
}
const clip = (s: string, n = 240) =>
  (s.length <= n ? s : s.slice(0, n) + '…').replace(/\s+/g, ' ')

try {
  const [embedProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'embedding'))
    .limit(1)
  if (!embedProvider) throw new Error('no embedding provider')
  const embedder = buildEmbedder(embedProvider)
  const fingerprint = embeddingFingerprint(embedProvider)
  const scopeRows = await db.db
    .select({ id: schema.agentFiles.fileId })
    .from(schema.agentFiles)
    .where(eq(schema.agentFiles.agentId, AGENT_ID))
  const scope = scopeRows.map((r) => r.id)

  const qrows = await db.pool.query<{
    query: string
    expected_snippets: string[] | null
  }>(
    `SELECT query, expected_snippets FROM scorecard_queries WHERE agent_id = $1`,
    [AGENT_ID],
  )

  for (const needle of TARGETS) {
    const row = qrows.rows.find((r) =>
      r.query.toLowerCase().includes(needle.toLowerCase()),
    )
    if (!row) {
      console.log(`\n!! no query matching "${needle}"`)
      continue
    }
    const gold = row.expected_snippets ?? []
    const embed = await embedder.doEmbed({ values: [row.query] })
    const qv = embed.embeddings[0]!
    const [vec, bm] = await Promise.all([
      runVectorSearch({ db, scope, fingerprint, queryVector: qv, limit: 100 }),
      runBm25Search({ db, scope, fingerprint, query: row.query, limit: 100 }),
    ])
    const vr = goldRank(vec, gold)
    const br = goldRank(bm, gold)

    console.log('\n' + '═'.repeat(78))
    console.log(`QUERY: ${row.query}`)
    console.log(`GOLD snippet(s): ${gold.map((g) => `"${clip(g, 120)}"`).join(' | ')}`)
    console.log(`gold rank — vector: ${vr || 'NOT in top 100'}   bm25: ${br || 'NOT in top 100'}`)

    const goldHit = vec.find((c) => goldRank([c], gold) === 1)
    if (goldHit) {
      console.log(`\nGOLD chunk  [section: ${goldHit.sectionPath ?? '-'} | page ${goldHit.page ?? '-'}]`)
      console.log(`  ${clip(goldHit.text, 300)}`)
    }

    console.log(`\nWhat the VECTOR arm ranked ABOVE the gold (top 5):`)
    const above = vr > 0 ? vec.slice(0, Math.min(vr - 1, 5)) : vec.slice(0, 5)
    above.forEach((c, i) => {
      console.log(`  #${i + 1} [section: ${c.sectionPath ?? '-'}] ${clip(c.text, 180)}`)
    })
    if (vr === 0) console.log('  (gold absent from vector top-100 entirely)')
  }
} finally {
  await db.close()
}
