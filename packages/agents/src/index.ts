/**
 * Public surface of `@agent-bridge/agents`.
 *
 * Keep this lean: apps should only ever need `buildAgent(...)` and the
 * handful of types it returns/accepts. Internal Mastra types must not
 * leak outside this package — the root ESLint guard rail enforces that
 * `@mastra/*` imports are allowed in this directory only.
 */

export { buildAgent } from './build-agent.js'
export type {
  BuildAgentInput,
  BuiltAgent,
  BuiltAgentMeta,
} from './build-agent.js'
export type { GitnexusMountMeta } from './mcp/gitnexus-mcp.js'
export type {
  ExternalMcpsMountMeta,
  McpLogHandler,
  McpLogLine,
  MountedConnectionMeta,
} from './mcp/external-mcps.js'
export {
  discoverMcpTools,
  discoverMcpToolsOAuth,
} from './mcp/discover-probe.js'
export type {
  DiscoverErrorCode,
  DiscoverProbeInput,
  DiscoverProbeResult,
  DiscoveredProbeTool,
  DiscoverOAuthProbeInput,
  DiscoverOAuthProbeResult,
} from './mcp/discover-probe.js'
export { DrizzleOAuthStorage } from './mcp/oauth-storage.js'
