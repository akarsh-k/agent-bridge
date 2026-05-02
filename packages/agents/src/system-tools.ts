/**
 * Read-only enumeration of the system-mounted MCP tools — currently
 * just the gitnexus tool catalog. Surfaces names + descriptions to
 * the frontend so users can see what their agent automatically has
 * access to (without spelunking through `mcp/gitnexus-mcp.ts`).
 *
 * One subprocess is spawned the FIRST time `loadGitnexusToolDefinitions`
 * is called; the result is cached for the lifetime of the process.
 * `gitnexus mcp` doesn't hot-reload its tool list, so the cache is
 * effectively permanent. Callers that need fresh data after a CLI
 * upgrade should restart the backend.
 *
 * Failure mode: if gitnexus isn't installed / the version pin fails /
 * the subprocess can't start, the function returns `{ ok: false,
 * message }` instead of throwing — the UI shows a graceful "couldn't
 * load system tools" notice rather than blowing up the page.
 */

import {
  assertExpectedGitnexusVersion,
  EXPECTED_GITNEXUS_VERSION,
} from '@agent-bridge/shared/gitnexus'
import { buildSandboxedEnv } from '@agent-bridge/shared/spawn'
import { MCPClient } from '@mastra/mcp'

export interface SystemToolDefinition {
  readonly name: string
  readonly description: string
}

export interface GitnexusSystemToolsOk {
  readonly ok: true
  readonly cliVersion: string
  readonly tools: readonly SystemToolDefinition[]
}
export interface GitnexusSystemToolsErr {
  readonly ok: false
  readonly message: string
}
export type GitnexusSystemToolsResult =
  | GitnexusSystemToolsOk
  | GitnexusSystemToolsErr

let cachedPromise: Promise<GitnexusSystemToolsResult> | null = null

export function loadGitnexusToolDefinitions(): Promise<GitnexusSystemToolsResult> {
  if (cachedPromise) return cachedPromise
  cachedPromise = (async (): Promise<GitnexusSystemToolsResult> => {
    let resolved: ReturnType<typeof assertExpectedGitnexusVersion>
    try {
      resolved = assertExpectedGitnexusVersion(import.meta.url)
    } catch (err) {
      // Version drift / not installed — surface the message, don't
      // crash the route. Cache the failure so we don't retry on
      // every poll; restarting the backend re-checks.
      return {
        ok: false,
        message: errMsg(err),
      }
    }

    const env = compactEnv(
      buildSandboxedEnv({
        sandbox: 'default',
        allowHostHome: false,
      }),
    )

    // Use a fixed id (no per-agent suffix) — there's only ever one
    // enumeration subprocess and we tear it down right after listing.
    const client = new MCPClient({
      id: 'gitnexus-system-tools-enumeration',
      servers: {
        gitnexus: {
          command: resolved.nodeBin,
          args: [resolved.cliEntry, 'mcp'],
          env,
          stderr: 'ignore',
        },
      },
      timeout: 30_000,
    })

    try {
      const tools = await client.listTools()
      const fromGitnexus: SystemToolDefinition[] = Object.entries(tools).map(
        ([name, t]) => ({
          name,
          description:
            (t as { description?: unknown }).description &&
            typeof (t as { description?: unknown }).description === 'string'
              ? ((t as { description: string }).description.trim() ||
                'No description provided.')
              : 'No description provided.',
        }),
      )
      // Wiki tools sit alongside the gitnexus subprocess tools in
      // the System defaults catalog. They're code-defined here in
      // `@agent-bridge/agents`; the descriptions match what the
      // LLM sees at mount time. Operators viewing the catalog see
      // the full system surface in one card.
      const fromWiki: SystemToolDefinition[] = WIKI_TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
      }))
      const defs: SystemToolDefinition[] = [...fromGitnexus, ...fromWiki].sort(
        // Stable ordering — name-sorted so the UI doesn't reshuffle
        // between restarts.
        (a, b) => a.name.localeCompare(b.name),
      )
      return {
        ok: true,
        cliVersion: resolved.packageVersion,
        tools: defs,
      }
    } catch (err) {
      // Cache the error too — listTools failed, no point retrying
      // until the backend restarts.
      return {
        ok: false,
        message: `Failed to load gitnexus tools: ${errMsg(err)}`,
      }
    } finally {
      // Always tear down the subprocess — we only needed it to
      // enumerate. Per-agent runs spawn their own.
      try {
        await client.disconnect()
      } catch {
        /* swallow — listTools failure is the more interesting one */
      }
    }
  })()
  return cachedPromise
}

/**
 * Wiki tool descriptions used by the System defaults UI catalog.
 * Mirror the descriptions in `coding-agent/wiki-tool.ts` exactly -
 * this list is operator-facing reference, the runtime tool defs are
 * the source of truth. Drift here is a doc bug, not a runtime bug.
 */
const WIKI_TOOL_DEFS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: 'gitnexus_wiki_list_pages',
    description:
      'List the pages in a repo\'s pre-generated wiki. narrative summaries written by `gitnexus wiki`. Cheaper than fanning out 5+ graph queries when you need a high-level "how does X work" overview. Pass the repo\'s friendly label (role / alias / URL tail). Returns an ordered tree.',
  },
  {
    name: 'gitnexus_wiki_get_page',
    description:
      'Read one page of a repo\'s pre-generated wiki. Use AFTER `gitnexus_wiki_list_pages` told you which slug to fetch. Returns the markdown body. The wiki is a snapshot. verify any concrete file/line claim against `gitnexus_context` before quoting it.',
  },
]

// ─── Local helpers ───────────────────────────────────────────────────────

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

// Re-export for the public surface — saves the index.ts a separate
// type re-export.
export { EXPECTED_GITNEXUS_VERSION }
