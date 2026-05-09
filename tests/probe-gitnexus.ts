/**
 * One-shot probe of gitnexus_query / context / impact directly against
 * the indexed fixture. Bypasses our wrappers entirely so we can see
 * what gitnexus *itself* returns for each call shape and isolate which
 * of our wrappers' assumptions are wrong.
 *
 * Run after `pnpm test:fixture:setup` succeeds. Same env as the smoke.
 */

/* eslint-disable no-console */

import { eq } from 'drizzle-orm'

import { TEST_DATA_DIR, TEST_DB_NAME, FIXTURE_AGENT } from './fixture-config.js'

function swapDatabaseName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

const baseDbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = swapDatabaseName(baseDbUrl, TEST_DB_NAME)
process.env['DATABASE_URL'] = testDbUrl
process.env['AGENT_BRIDGE_DATA_DIR'] = TEST_DATA_DIR

const url = process.env['SMOKE_EMBEDDING_URL']
const model = process.env['SMOKE_EMBEDDING_MODEL']
const dims = process.env['SMOKE_EMBEDDING_DIMS']
if (url) process.env['GITNEXUS_EMBEDDING_URL'] = url
if (model) process.env['GITNEXUS_EMBEDDING_MODEL'] = model
if (dims) process.env['GITNEXUS_EMBEDDING_DIMS'] = dims

const { createDb } = await import('@agent-bridge/db')
const schema = await import('@agent-bridge/db/schema')
const { mountGitnexusMcp } = await import('../packages/agents/src/mcp/gitnexus-mcp.js')

async function main(): Promise<void> {
  const db = createDb({ connectionString: testDbUrl })
  try {
    const agentRow = await db.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.slug, FIXTURE_AGENT.slug))
      .limit(1)
    const agent = agentRow[0]
    if (!agent) throw new Error('fixture agent not found — run setup first')

    const mounted = await mountGitnexusMcp({ db, agentId: agent.id })
    if (!mounted) throw new Error('mount returned null')

    try {
      const tools = mounted.tools
      console.log('▸ tools mounted:', Object.keys(tools).sort().join(', '))

      // ─── 1. gitnexus_list_repos: see what gitnexus has indexed ───────
      console.log('\n▸ gitnexus_list_repos')
      const listOut = await invoke(tools, 'gitnexus_list_repos', {})
      console.log(snippet(listOut, 1200))

      // ─── 2. gitnexus_query for a known symbol — see the path shape ───
      console.log('\n▸ gitnexus_query("Product", limit=4)')
      const qOut = await invoke(tools, 'gitnexus_query', {
        query: 'Product',
        limit: 4,
      })
      console.log(snippet(qOut, 1500))

      // ─── 3. gitnexus_context with the path the query returned ───────
      // Pull a sample path from the previous output to use for the next probes.
      const samplePath = pickFirstPath(qOut)
      console.log(`\n▸ gitnexus_context with path=${samplePath ?? '(none)'}, repo=backend`)
      if (samplePath) {
        try {
          const cOut = await invoke(tools, 'gitnexus_context', {
            repo: 'backend',
            path: samplePath,
          })
          console.log(snippet(cOut, 1200))
        } catch (e) {
          console.log('  ERROR:', errMsg(e))
        }
      }

      // ─── 4. gitnexus_context with relative path (no leading 'backend/') ───
      console.log('\n▸ gitnexus_context path=app/routes/products.py, repo=backend')
      try {
        const cOut2 = await invoke(tools, 'gitnexus_context', {
          repo: 'backend',
          path: 'app/routes/products.py',
        })
        console.log(snippet(cOut2, 1200))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }

      // ─── 5. gitnexus_context with symbol-only argument ─────────────
      console.log('\n▸ gitnexus_context symbol=list_products, repo=backend (no path)')
      try {
        const cOut3 = await invoke(tools, 'gitnexus_context', {
          repo: 'backend',
          symbol: 'list_products',
        })
        console.log(snippet(cOut3, 1200))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }

      // ─── 5b. gitnexus_context with the documented {name} arg ──────
      console.log('\n▸ gitnexus_context name=list_products, repo=backend')
      try {
        const cOut4 = await invoke(tools, 'gitnexus_context', {
          repo: 'backend',
          name: 'list_products',
        })
        console.log(snippet(cOut4, 1500))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }

      // ─── 5c. gitnexus_context with name=Product in backend ────────
      console.log('\n▸ gitnexus_context name=Product, repo=backend')
      try {
        const cOut5 = await invoke(tools, 'gitnexus_context', {
          repo: 'backend',
          name: 'Product',
        })
        console.log(snippet(cOut5, 1500))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }

      // ─── 6. gitnexus_impact target=symbol ──────────────────────────
      console.log('\n▸ gitnexus_impact target=Product, repo=shared-types, dir=downstream')
      try {
        const iOut = await invoke(tools, 'gitnexus_impact', {
          repo: 'shared-types',
          target: 'Product',
          direction: 'downstream',
          depth: 3,
        })
        console.log(snippet(iOut, 1500))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }

      // ─── 7. gitnexus_impact target=path ───────────────────────────
      console.log('\n▸ gitnexus_impact target=src/product.ts, repo=shared-types, dir=downstream')
      try {
        const iOut2 = await invoke(tools, 'gitnexus_impact', {
          repo: 'shared-types',
          target: 'src/product.ts',
          direction: 'downstream',
          depth: 3,
        })
        console.log(snippet(iOut2, 1500))
      } catch (e) {
        console.log('  ERROR:', errMsg(e))
      }
    } finally {
      await mounted.client.disconnect().catch(() => undefined)
    }
  } finally {
    await db.close()
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

async function invoke(
  tools: Record<string, { execute?: (a: never, b: never) => unknown }>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools[name]
  if (!tool?.execute) throw new Error(`tool ${name} not mounted`)
  return await tool.execute(args as never, {} as never)
}

function pickFirstPath(raw: unknown): string | null {
  const text = JSON.stringify(raw)
  const m = text.match(/"path":\s*"([^"]+)"/)
  return m && m[1] ? m[1] : null
}

function snippet(raw: unknown, max: number): string {
  const text = JSON.stringify(raw, null, 2)
  return text.length > max ? text.slice(0, max) + '…' : text
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

main().catch((err) => {
  console.error('[probe] fatal:', err)
  process.exit(1)
})
