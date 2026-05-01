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
  MemoryMountMeta,
} from './build-agent.js'
export { builtAgentCache } from './built-agent-cache.js'
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
export { dispatchRun } from './run-dispatcher.js'
export type { DispatchRunInput } from './run-dispatcher.js'
export { createRunRedactor } from './run-redactor.js'
export type { RunRedactor } from './run-redactor.js'
export {
  listAgentThreads,
  getAgentThreadMessages,
  deleteAgentThread,
} from './threads.js'
export type {
  AgentThreadSummary,
  AgentThreadMessage,
  AgentThreadMessageRole,
} from './threads.js'
export { loadGitnexusToolDefinitions } from './system-tools.js'
export type {
  SystemToolDefinition,
  GitnexusSystemToolsResult,
  GitnexusSystemToolsOk,
  GitnexusSystemToolsErr,
} from './system-tools.js'
export { wipeSemanticVectorsForAgents } from './semantic-wipe.js'
export type { WipeSemanticVectorsResult } from './semantic-wipe.js'
