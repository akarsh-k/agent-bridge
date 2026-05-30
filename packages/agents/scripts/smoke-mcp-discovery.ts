/* eslint-disable no-console -- smoke script is a CLI; stdout IS the UI */
/**
 * MCP discovery schema-capture smoke. Proves the discovery path persists the
 * RAW JSON Schema (type / properties / required) for each tool — NOT Mastra's
 * empty `~standard` StandardSchema wrapper, which advertises no arguments and
 * makes a model call the tool with `{}`. Regression guard for that silent bug.
 *
 * Uses the fake-echo stdio fixture (tool `echo` requires `text`). No model, no
 * network, no DB — just the real `discoverMcpTools` probe against a real (tiny)
 * MCP subprocess, so it exercises `buildDiscoveredTools` / `fetchRawInputSchemas`
 * end to end.
 *
 * Run: pnpm --filter @agent-bridge/agents smoke:mcp-discovery
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverMcpTools } from '../src/mcp/discover-probe.js'
import {
  buildLazyTool,
  type LazyToolsetSource,
} from '../src/mcp/external-mcps.js'
import { standardSchemaToJSONSchema } from '@mastra/core/schema'

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-mcp-echo.mjs',
)

let passed = 0
let failed = 0
function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function main(): Promise<void> {
  console.log('━'.repeat(60))
  console.log(' MCP discovery schema-capture smoke')
  console.log('━'.repeat(60))

  const res = await discoverMcpTools({
    transport: 'stdio',
    commandOrUrl: process.execPath,
    args: [FAKE],
    env: null,
    headers: null,
    allowHostHome: false,
    timeoutMs: 15_000,
  })

  check('discovery succeeded', res.ok, res.ok ? '' : JSON.stringify(res))
  if (!res.ok) {
    process.exitCode = 1
    return
  }

  const echo = res.tools.find((t) => t.name === 'echo')
  check(
    'echo tool discovered',
    !!echo,
    `tools=[${res.tools.map((t) => t.name).join(', ')}]`,
  )
  const schema: Record<string, unknown> = isRecord(echo?.inputSchema)
    ? echo.inputSchema
    : {}

  check(
    'inputSchema is the RAW JSON schema, not the empty ~standard wrapper',
    !('~standard' in schema) && isRecord(schema['properties']),
    JSON.stringify(schema).slice(0, 160),
  )

  const props = isRecord(schema['properties']) ? schema['properties'] : {}
  check(
    'schema advertises the `text` argument',
    isRecord(props['text']),
    `properties=[${Object.keys(props).join(', ')}]`,
  )

  const required = schema['required']
  check(
    'schema marks `text` as required',
    Array.isArray(required) && required.includes('text'),
    JSON.stringify(required),
  )

  // End to end: the model sees the FULL stored schema. `buildLazyTool` wraps it
  // via `toStandardSchema`, and Mastra serializes it back with
  // `standardSchemaToJSONSchema` for the LLM. Prove the discovered `echo` schema
  // survives that round-trip — storing a `~standard` wrapper or an empty schema
  // would drop the arg and the model would call `echo` with `{}` (the bug).
  const lazyTool = buildLazyTool({
    slug: 'fake',
    connectionId: 'c1',
    connectionName: 'Echo',
    rawName: 'echo',
    stored: {
      name: 'echo',
      description: echo?.description ?? '',
      inputSchema: schema,
    },
    manager: { getToolset: async () => ({}) } as LazyToolsetSource,
  })
  const modelSchema = standardSchemaToJSONSchema(
    (lazyTool as { inputSchema: unknown }).inputSchema as never,
  ) as { properties?: Record<string, { type?: string }>; required?: unknown }
  check(
    'the model-facing schema keeps the `text` argument (not empty {})',
    modelSchema?.properties?.text?.type === 'string' &&
      Array.isArray(modelSchema?.required) &&
      modelSchema.required.includes('text'),
    `model sees properties=[${Object.keys(modelSchema?.properties ?? {}).join(', ')}], required=${JSON.stringify(modelSchema?.required)}`,
  )

  console.log('━'.repeat(60))
  console.log(` Passed: ${passed}/${passed + failed}`)
  if (failed > 0) {
    console.log(' FAILED')
    process.exitCode = 1
  } else {
    console.log(' All checks passed.')
  }
  console.log('━'.repeat(60))
}

main().catch((err) => {
  console.error('[smoke-mcp-discovery] fatal:', err)
  process.exit(1)
})
