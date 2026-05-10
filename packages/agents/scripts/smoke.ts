/**
 * Smoke test. Intentionally dev-only — this does NOT get
 * exported from the package and the HTTP layer never imports it.
 *
 * What it does:
 *   1. Loads the repo-root `.env` (same loader every other service uses).
 *   2. Opens the shared Postgres pool.
 *   3. Looks up an agent by slug OR uuid (slug is friendlier for CLI use).
 *   4. Runs `buildAgent(...)` to produce a real Mastra Agent, which
 *      also spawns `gitnexus mcp` if the agent has indexed
 *      repos attached. Prints the merged tool list so you can confirm.
 *   5. Streams a minimal prompt through `agent.stream(...)`, piping the
 *      text stream straight to stdout.
 *   6. Always tears the mounted MCP subprocess + DB pool down in
 *      `finally` so the process terminates cleanly instead of dangling
 *      on an idle child or Postgres connection.
 *
 * Why this lives as a standalone script instead of a jest/vitest file:
 *   - It talks to a real LLM over the wire AND a real
 *     `gitnexus mcp` child process over stdio. That's integration, not
 *     unit; mocking the Mastra or gitnexus surface defeats the point.
 *   - We want a single clear command a contributor can run to verify
 *     the full stack — db → factory → gitnexus subprocess → MCP tools
 *     → model → tokens on stdout — is wired correctly locally.
 *
 * Run:
 *   # From repo root — pnpm 10 auto-forwards unknown flags to the script:
 *   pnpm --filter @agent-bridge/agents smoke --agent <slug-or-uuid>
 *
 *   # Optional flags:
 *   #   --prompt "…"   override the default "say hi" prompt
 *   #   --no-stream    call .generate() instead of .stream() for a single
 *   #                  non-streaming round-trip (handy when a provider
 *   #                  has a buggy SSE path but regular POST works).
 *   #   --no-gitnexus  skip spawning `gitnexus mcp` even if the agent has
 *   #                  indexed repos. Useful when the local gitnexus
 *   #                  install is broken and you want to isolate whether
 *   #                  the LLM half of the factory is working.
 *   #   --no-external-mcps
 *   #                  skip mounting any allowlisted external MCP
 *   #                  connections. Same intent as --no-gitnexus but
 *   #                  for the external MCP mount path.
 *   #   --trace-mcp-logs
 *   #                  subscribe to stdio MCP stderr and echo every
 *   #                  scrubbed line to the smoke script's stdout as
 *   #                  it arrives. Interleaves with streamed LLM
 *   #                  tokens — only useful when diagnosing MCP
 *   #                  startup / auth issues.
 *
 * NOTE: Do NOT prefix the args with `--` (`pnpm … smoke -- --agent x`).
 *   pnpm forwards `--` into argv verbatim, which flips Node's `parseArgs`
 *   into "everything after this is positional" mode and swallows your
 *   flags silently.
 *
 * Env requirements:
 *   - AGENT_BRIDGE_DATA_DIR and AGENT_BRIDGE_SECRET_KEY (or auto-generated
 *     key file) so secrets can be decrypted. `AGENT_BRIDGE_DATA_DIR` is
 *     also where the gitnexus subprocess sees its clamped `$HOME`, so it
 *     must be the same dir the worker cloned + indexed into.
 *   - DATABASE_URL pointing at the dev Postgres.
 *   - An `agents` row with an attached `llm_providers` row whose endpoint
 *     is actually reachable from wherever you run this.
 *
 * Exit codes:
 *   0   prompt completed (streaming or non-streaming).
 *   1   any failure — the full error is printed to stderr.
 *
 * Safety notes:
 *   - Decrypted API keys never touch stdout/stderr. We log the provider
 *     kind/label/model, not the key.
 *   - The script does NOT create DB rows. It only reads. Failing halfway
 *     through is always safe to retry.
 *   - The gitnexus subprocess inherits the same sandboxed env baseline as
 *     the worker — no host `~/.gitnexus/` writes, no SSH agent socket.
 */

/* eslint-disable no-console -- smoke script is a CLI; stdout/stderr ARE the UI */

import { parseArgs } from 'node:util'
import { createDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import { eq } from 'drizzle-orm'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import { buildAgent, type BuiltAgentMeta } from '../src/build-agent.js'

loadRootDotenv(import.meta.url)

/**
 * We deliberately do NOT use `baseEnvSchema.extend(...)` here: that would
 * pull `zod` into this package's dependency closure just for the smoke
 * script. Inline-validate the one env var we actually need.
 */
const DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'

if (!/^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
  console.error(
    `[smoke] DATABASE_URL must be a postgres URL; got ${JSON.stringify(DATABASE_URL)}`,
  )
  process.exit(1)
}

// ─── CLI parsing ─────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    agent: { type: 'string', short: 'a' },
    prompt: { type: 'string', short: 'p' },
    'no-stream': { type: 'boolean' },
    'no-gitnexus': { type: 'boolean' },
    'no-external-mcps': { type: 'boolean' },
    'trace-mcp-logs': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  // `pnpm run foo -- --flag` forwards `--` into argv. We don't use
  // positionals ourselves, so accept them silently instead of crashing
  // on the caller's separator.
  allowPositionals: true,
})

if (values.help) {
  console.info(
    [
      'Usage: pnpm --filter @agent-bridge/agents smoke --agent <slug-or-uuid>',
      '         [--prompt "…"] [--no-stream] [--no-gitnexus] [--no-external-mcps]',
      '         [--trace-mcp-logs]',
      '',
      'Reads an agent row from Postgres, builds a Mastra Agent via',
      'buildAgent(...), and runs a single prompt through the LLM. When',
      'the agent has status=ready repos attached, a sandboxed',
      '`gitnexus mcp` subprocess is also spawned and its tools become',
      'available to the LLM. When the agent has allowlisted MCP tools,',
      'the relevant MCP connections are spawned too. Pass',
      '--no-gitnexus or --no-external-mcps to skip the respective mount.',
    ].join('\n'),
  )
  process.exit(0)
}

const agentRef = values.agent?.trim()
if (!agentRef) {
  console.error(
    '[smoke] --agent is required (pass a slug or UUID). Try --help.',
  )
  process.exit(1)
}

const prompt =
  values.prompt?.trim() ||
  'Say hi in one sentence, then stop. Do not use tools.'

const stream = values['no-stream'] !== true
const disableGitnexus = values['no-gitnexus'] === true
const disableExternalMcps = values['no-external-mcps'] === true
const traceMcpLogs = values['trace-mcp-logs'] === true

// ─── Main ────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main(): Promise<void> {
  const db = createDb({
    connectionString: DATABASE_URL,
    maxConnections: 5,
  })

  let built: Awaited<ReturnType<typeof buildAgent>> | null = null
  try {
    const agentId = await resolveAgentId(db, agentRef!)
    console.info(`[smoke] resolved agent ref "${agentRef}" → ${agentId}`)

    // `disableGitnexus` / `disableExternalMcps` are threaded through so
    // the matching flags reproduce a no-tools (or gitnexus-only) run
    // against the exact same DB row.
    built = await buildAgent({
      db,
      agentId,
      disableGitnexus,
      disableExternalMcps,
    })
    logMeta(built.meta)

    // Route MCP stderr lines to the console while the smoke run is
    // live, but ONLY when the operator explicitly opted in. Default-off
    // keeps the stream response clean; default-on would clobber the
    // streamed LLM tokens below with interleaved banners.
    if (traceMcpLogs) {
      built.subscribeMcpLogs((log) => {
        console.info(
          `[smoke] [mcp ${log.connectionName}] [${log.level}] ${log.line}`,
        )
      })
    }

    // Dump the merged tools dict so the operator can confirm
    // the `gitnexus_*` tools surfaced. `agent.getTools?.()` is preferred
    // when available; fall back to a sentinel when not, so the script
    // keeps working across Mastra minor versions.
    await logMountedTools(built)

    console.info(`[smoke] prompt: ${JSON.stringify(prompt)}`)
    console.info(`[smoke] ──────── response ${'─'.repeat(50)}`)

    const started = Date.now()
    if (stream) {
      const output = await built.agent.stream(prompt)
      for await (const chunk of output.textStream) {
        process.stdout.write(chunk)
      }
      process.stdout.write('\n')
    } else {
      const result = await built.agent.generate(prompt)
      // FullOutput shapes vary across Mastra minor versions; guard
      // against both `.text` (current) and `.response.content` fallbacks.
      const text = extractFullOutputText(result)
      process.stdout.write(`${text}\n`)
    }
    const elapsed = Date.now() - started
    console.info(
      `[smoke] ────────${'─'.repeat(50)} done in ${elapsed}ms (${stream ? 'stream' : 'generate'})`,
    )
  } finally {
    // Tear the MCP subprocess down BEFORE closing the pool so any
    // disconnect-time DB work (none today, but future-proof) has a live
    // connection. `disconnect` is idempotent either way.
    if (built) {
      try {
        await built.disconnect()
      } catch (err) {
        console.warn(
          `[smoke] disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await db.close()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveAgentId(
  db: ReturnType<typeof createDb>,
  ref: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref

  const [row] = await db.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.slug, ref))
    .limit(1)

  if (!row) {
    throw new Error(
      `[smoke] No agent found for slug "${ref}". Pass a UUID directly, or create the agent first.`,
    )
  }
  return row.id
}

function logMeta(meta: BuiltAgentMeta): void {
  console.info(`[smoke] agent: ${meta.agentName} (${meta.slug})`)
  console.info(
    `[smoke] provider: ${meta.provider.label} [${meta.provider.kind}] → ${meta.provider.modelId}`,
  )
  console.info(
    `[smoke] skills: ${meta.skillCount}  memory: ${meta.memoryEnabled ? 'on' : 'off'}`,
  )

  const { gitnexus } = meta
  if (gitnexus.mounted) {
    const repos = gitnexus.repoLabels.map((r) => r.label).join(', ')
    console.info(
      `[smoke] gitnexus: mounted (cli ${gitnexus.cliVersion}) · ` +
        `${gitnexus.repoCount} repo(s) [${repos}] · ${gitnexus.toolCount} tool(s)`,
    )
  } else if (gitnexus.repoCount === 0) {
    console.info('[smoke] gitnexus: skipped (agent has no ready repos)')
  } else {
    console.info(
      `[smoke] gitnexus: skipped via --no-gitnexus (${gitnexus.repoCount} repo(s) available)`,
    )
  }

  const { externalMcps } = meta
  if (externalMcps.mounted) {
    const summary = externalMcps.perConnection
      .map(
        (c) =>
          `${c.name} [${c.transport}] → ${c.mountedToolCount}/${c.selectedTools.length}` +
          (c.missingTools.length > 0
            ? ` (missing: ${c.missingTools.join(', ')})`
            : ''),
      )
      .join(' · ')
    console.info(
      `[smoke] external-mcps: mounted · ${externalMcps.connectionCount} connection(s) · ` +
        `${externalMcps.toolCount} tool(s) · ${summary}`,
    )
  } else if (externalMcps.connectionCount === 0) {
    console.info('[smoke] external-mcps: skipped (no allowlisted tools)')
  } else {
    console.info('[smoke] external-mcps: skipped via --no-external-mcps')
  }
}

/**
 * Best-effort dump of the tools actually attached to the Agent. Mastra's
 * Agent surface has varied between `getTools()` (older) and
 * `listTools()` (newer) — both are optional on the type, so we probe
 * defensively and fall back to "see above" if neither exists. Tool
 * schemas are not printed (they can be huge); names + descriptions are
 * enough to sanity-check the mount.
 */
async function logMountedTools(
  built: Awaited<ReturnType<typeof buildAgent>>,
): Promise<void> {
  if (!built.meta.gitnexus.mounted && !built.meta.externalMcps.mounted) return

  const agent = built.agent as unknown as {
    getTools?: () => unknown
    listTools?: () => Promise<unknown>
    tools?: unknown
  }

  let toolsRecord: Record<string, unknown> | null = null
  try {
    if (typeof agent.listTools === 'function') {
      const maybeTools = await agent.listTools()
      toolsRecord = isRecord(maybeTools) ? maybeTools : null
    } else if (typeof agent.getTools === 'function') {
      const maybeTools = agent.getTools()
      toolsRecord = isRecord(maybeTools) ? maybeTools : null
    } else if (isRecord(agent.tools)) {
      toolsRecord = agent.tools
    }
  } catch (err) {
    console.warn(
      `[smoke] could not enumerate tools: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }

  if (!toolsRecord) {
    console.info('[smoke] tools: (list unavailable; check Mastra version)')
    return
  }

  const names = Object.keys(toolsRecord).sort()
  console.info(`[smoke] tools (${names.length}):`)
  for (const name of names) {
    const desc = pickDescription(toolsRecord[name])
    console.info(desc ? `[smoke]   • ${name} — ${desc}` : `[smoke]   • ${name}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickDescription(tool: unknown): string | null {
  if (!isRecord(tool)) return null
  const desc = tool['description']
  if (typeof desc !== 'string' || desc.length === 0) return null
  // Long gitnexus descriptions wrap awkwardly; trim to one line.
  return desc.split('\n')[0]?.slice(0, 140) ?? null
}

function extractFullOutputText(result: unknown): string {
  if (result && typeof result === 'object' && 'text' in result) {
    const text = (result as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  // Fallback — stringify whatever we got so the operator can still see it.
  return JSON.stringify(result, null, 2)
}

main().catch((err) => {
  console.error('[smoke] failed:')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
})
