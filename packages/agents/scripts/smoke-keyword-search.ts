/**
 * Smoke for the local ripgrep-backed keyword search
 * (`docs/ARCHITECTURE.md` §10.12).
 *
 * Runs `keywordSearch` against an indexed repo's source clone so we
 * can see the BM25 stand-in surface real matches when gitnexus_query
 * comes back empty.
 *
 * Configure via env (no defaults — bring your own clone):
 *   SMOKE_REPO_DIR    absolute path to the repo's `<source>` directory
 *   SMOKE_REPO_LABEL  short label to tag hits (defaults to dir basename)
 *   SMOKE_QUERIES     comma-separated list of queries
 *
 * Run: `SMOKE_REPO_DIR=/path/to/clone/source SMOKE_QUERIES='foo,bar' \
 *        pnpm --filter '@agent-bridge/agents' run smoke:keyword-search`
 */

/* eslint-disable no-console */

import { basename } from 'node:path'
import { keywordSearch } from '../src/inspector/keyword-search.js'

const SOURCE_DIR = process.env['SMOKE_REPO_DIR']
if (!SOURCE_DIR) {
  console.error(
    '[smoke] set SMOKE_REPO_DIR to the absolute path of an indexed repo `<source>` directory',
  )
  process.exit(1)
}

const REPO_LABEL = process.env['SMOKE_REPO_LABEL'] ?? basename(SOURCE_DIR)

const QUERIES = (process.env['SMOKE_QUERIES'] ?? 'index,config,handler,client,server')
  .split(',')
  .map((q) => q.trim())
  .filter((q) => q.length > 0)

async function main(): Promise<void> {
  console.log(`[smoke] keywordSearch matrix (repo=${REPO_LABEL}):`)
  for (const q of QUERIES) {
    const start = Date.now()
    try {
      const hits = await keywordSearch({
        sourceDir: SOURCE_DIR!,
        repoLabel: REPO_LABEL,
        queries: [q],
        limit: 5,
      })
      const ms = Date.now() - start
      console.log(`  "${q}" (${ms}ms) → ${hits.length} hits`)
      for (const h of hits.slice(0, 5)) {
        console.log(
          `    - ${h.path}:${h.line ?? '?'} score=${h.score} ${h.reason}`,
        )
      }
    } catch (err) {
      console.log(
        `  "${q}" → ERROR: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  console.log('\n[smoke] multi-query (one spawn, all OR\'d):')
  const start = Date.now()
  const hits = await keywordSearch({
    sourceDir: SOURCE_DIR!,
    repoLabel: REPO_LABEL,
    queries: QUERIES,
    limit: 12,
  })
  console.log(`  ${QUERIES.length} terms (${Date.now() - start}ms) → ${hits.length} hits`)
  for (const h of hits.slice(0, 8)) {
    console.log(`    - ${h.path}:${h.line ?? '?'} score=${h.score} ${h.reason}`)
  }
  console.log('\n[smoke] done')
}

main().catch((err) => {
  console.error('[smoke] fatal:', err)
  process.exit(1)
})
