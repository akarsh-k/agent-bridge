/**
 * Standalone smoke for `gitnexus_query` against an indexed repo.
 *
 * Bypasses our entire agent + wrapper stack to isolate where a
 * "0 hits" symptom comes from. Uses the same MCP client + sandboxed
 * spawn the production path uses (`mountGitnexusMcp`), then runs
 * `gitnexus_query` with TWO `repo` arg variants:
 *
 *   1. Friendly label  (the URL-tail form the LLM tends to emit)
 *   2. Canonical name  (the `--name` we passed to `gitnexus analyze`)
 *
 * If only #2 returns hits, the wrapper's `wrapToolsWithRepoArgRewriter`
 * isn't firing on this code path. If neither returns hits, gitnexus's
 * hybrid retrieval needs a different query shape OR the index needs a
 * forced rebuild.
 *
 * Configure via env (no defaults — point at a repo you've indexed):
 *   SMOKE_REPO_FRIENDLY    e.g. URL-tail form
 *   SMOKE_REPO_CANONICAL   e.g. `<owner>__<name>__<branch>__<shortId>`
 *   SMOKE_QUERIES          comma-separated queries
 *   GITNEXUS_EMBEDDING_*   forwarded into the subprocess (see mountGitnexusMcp)
 *
 * Run: `SMOKE_REPO_FRIENDLY=… SMOKE_REPO_CANONICAL=… SMOKE_QUERIES=foo,bar \
 *        pnpm --filter '@agent-bridge/agents' run smoke:gitnexus-query`
 */

/* eslint-disable no-console */

import {
  assertExpectedGitnexusVersion,
} from '@agent-bridge/shared/gitnexus'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import { ensureDataDirs } from '@agent-bridge/shared/paths'
import { MCPClient } from '@mastra/mcp'

const FRIENDLY = process.env['SMOKE_REPO_FRIENDLY']
const CANONICAL = process.env['SMOKE_REPO_CANONICAL']
if (!FRIENDLY || !CANONICAL) {
  console.error(
    '[smoke] set SMOKE_REPO_FRIENDLY and SMOKE_REPO_CANONICAL to the friendly + canonical names of an indexed repo',
  )
  process.exit(1)
}

const REPO_VARIANTS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'friendly URL-tail', value: FRIENDLY },
  { label: 'canonical registry name', value: CANONICAL },
]

const QUERIES = (process.env['SMOKE_QUERIES'] ?? 'index,config,handler,client,server')
  .split(',')
  .map((q) => q.trim())
  .filter((q) => q.length > 0)

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

async function main(): Promise<void> {
  console.log('[smoke] booting…')
  ensureDataDirs()
  const resolved = assertExpectedGitnexusVersion(import.meta.url)
  console.log(`[smoke] gitnexus ${resolved.packageVersion} from ${resolved.cliEntry}`)

  const env = compactEnv(
    buildSandboxedEnv({ sandbox: 'default', allowHostHome: false }),
  )
  // Forward the workspace embedding provider's env vars so query-time
  // semantic search uses the same embedder + dims as index-time. The
  // operator sets these in their shell before running the smoke; we
  // do not hard-code them here.
  for (const k of [
    'GITNEXUS_EMBEDDING_URL',
    'GITNEXUS_EMBEDDING_MODEL',
    'GITNEXUS_EMBEDDING_DIMS',
    'GITNEXUS_EMBEDDING_API_KEY',
  ]) {
    const v = process.env[k]
    if (typeof v === 'string' && v.length > 0) env[k] = v
  }

  const client = new MCPClient({
    id: 'smoke-gitnexus-query',
    servers: {
      gitnexus: {
        command: resolved.nodeBin,
        args: [resolved.cliEntry, 'mcp'],
        env,
        stderr: 'inherit',
      },
    },
    timeout: 90_000,
  })

  let tools: Awaited<ReturnType<typeof client.listTools>>
  try {
    tools = await client.listTools()
  } catch (err) {
    console.error('[smoke] listTools failed:', err)
    await client.disconnect()
    process.exit(1)
  }

  // Tools are namespaced under the server alias. log so we know what
  // gitnexus actually exposes today.
  const toolNames = Object.keys(tools).sort()
  console.log(`[smoke] gitnexus tool dict (${toolNames.length}):`)
  for (const n of toolNames) console.log(`  - ${n}`)

  // First: gitnexus_list_repos so we can see what registry NAMES
  // gitnexus is actually serving.
  const listTool = tools['gitnexus_list_repos']
  if (listTool?.execute) {
    console.log('\n[smoke] gitnexus_list_repos:')
    try {
      const raw = await listTool.execute({} as never, {} as never)
      console.log(JSON.stringify(raw, null, 2).slice(0, 2200))
    } catch (err) {
      console.error('[smoke] list_repos failed:', err)
    }
  } else {
    console.warn('[smoke] gitnexus_list_repos not in tool dict')
  }

  const queryTool = tools['gitnexus_query']
  if (!queryTool?.execute) {
    console.error('[smoke] gitnexus_query not in tool dict — aborting')
    await client.disconnect()
    process.exit(1)
  }

  // Cartesian (repo-variant × query) — we WANT to see at least one
  // non-empty result row from at least one variant. Each cell is
  // labeled so the operator can spot the pattern.
  console.log('\n[smoke] gitnexus_query matrix:')
  for (const variant of REPO_VARIANTS) {
    for (const query of QUERIES) {
      try {
        const raw = await queryTool.execute(
          { query, repo: variant.value, limit: 5 } as never,
          {} as never,
        )
        const summary = summariseQueryResult(raw)
        console.log(
          `  [${variant.label} | "${query}"] → ${summary}`,
        )
        // Dump ONE full payload so the parser can be checked against
        // gitnexus's actual current shape.
        if (variant === REPO_VARIANTS[1] && query === QUERIES[0]) {
          console.log(`  ── FULL PAYLOAD (canonical | "${query}") ──`)
          const unwrapped = unwrap(raw)
          console.log(JSON.stringify(unwrapped, null, 2).slice(0, 4000))
          console.log('  ── END FULL PAYLOAD ──')
        }
      } catch (err) {
        console.log(
          `  [${variant.label} | "${query}"] → ERROR: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  await client.disconnect()
  console.log('\n[smoke] done')
}

/**
 * Pull a one-line summary out of whatever shape gitnexus returned.
 * Handles the canonical `{content: [{type: 'text', text: '<json>'}]}`
 * envelope (which carries gitnexus's optional next-step divider) plus
 * structuredContent passthrough and bare arrays.
 */
function summariseQueryResult(raw: unknown): string {
  const unwrapped = unwrap(raw)
  if (unwrapped === null || unwrapped === undefined) return 'null/empty'
  if (Array.isArray(unwrapped)) {
    if (unwrapped.length === 0) return '[] empty'
    const first = unwrapped[0]
    return `${unwrapped.length} hits; first=${describeHit(first)}`
  }
  if (typeof unwrapped === 'object') {
    const obj = unwrapped as Record<string, unknown>
    for (const k of ['results', 'items', 'hits', 'data']) {
      const v = obj[k]
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: [] empty`
        return `${k}: ${v.length} hits; first=${describeHit(v[0])}`
      }
    }
    if (Array.isArray(obj['groups'])) {
      const g = obj['groups'] as unknown[]
      const total = g
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .reduce(
          (acc, gg) =>
            acc + (Array.isArray(gg['items']) ? (gg['items'] as unknown[]).length : 0),
          0,
        )
      return `groups: ${g.length}; itemsTotal: ${total}`
    }
    return `obj keys: ${Object.keys(obj).slice(0, 6).join(', ')}`
  }
  return `non-object: ${typeof unwrapped}`
}

function describeHit(hit: unknown): string {
  if (!hit || typeof hit !== 'object') return String(hit)
  const o = hit as Record<string, unknown>
  const path = o['path'] ?? o['filePath'] ?? o['file'] ?? '?'
  const sym = o['symbol'] ?? o['name'] ?? ''
  const score = o['score'] ?? o['rrf'] ?? o['rank']
  return `path=${path}${sym ? ` sym=${sym}` : ''}${score != null ? ` score=${score}` : ''}`
}

function unwrap(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return tryJson(raw)
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj['structuredContent'] !== undefined) {
    const sc = obj['structuredContent']
    return typeof sc === 'string' ? tryJson(sc) : sc
  }
  if (Array.isArray(obj['content'])) {
    for (const part of obj['content'] as unknown[]) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p['type'] === 'text' && typeof p['text'] === 'string') {
          const parsed = tryJson(p['text'] as string)
          if (parsed !== null) return parsed
        }
      }
    }
  }
  return obj
}

function tryJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const dividerIdx = trimmed.indexOf('\n\n---\n')
  const candidates = [
    dividerIdx >= 0 ? trimmed.slice(0, dividerIdx).trim() : '',
    trimmed,
  ].filter((s) => s.length > 0)
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown
    } catch {
      /* try next */
    }
  }
  return null
}

main().catch((err) => {
  console.error('[smoke] fatal:', err)
  process.exit(1)
})
