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
export {
  wipeSemanticVectorsForAgents,
  wipeAllSemanticVectors,
} from './semantic-wipe.js'
export type { WipeSemanticVectorsResult } from './semantic-wipe.js'
export { estimateAgentTokens } from './token-estimate.js'
export type {
  TokenEstimate,
  TokenEstimateGitnexusLibrarySkills,
  TokenEstimateSkill,
  TokenEstimateSystemSkill,
  TokenEstimateTool,
} from './token-estimate.js'
export {
  loadGitnexusLibrarySkills,
} from './coding-agent/gitnexus-library-skills.js'
export type {
  GitnexusLibrarySkill,
  GitnexusLibrarySkillsLoaded,
} from './coding-agent/gitnexus-library-skills.js'
export { getCurrentWorkingMemory } from './working-memory.js'
export type { CurrentWorkingMemory } from './working-memory.js'
export { loadAttachedRepos } from './coding-agent/repo-loader.js'
export type { LoadAttachedReposInput } from './coding-agent/repo-loader.js'
export {
  resolveRepoHint,
  resolveRelatedRepos,
  repoResolverErrorToEnvelope,
  isResolvedSingle,
  isResolvedAll,
  isClarification,
  isResolverError,
} from './coding-agent/repo-resolver.js'
export type { ResolveRepoHintInput } from './coding-agent/repo-resolver.js'
export {
  normalizeRemoteUrl,
  urlTail,
} from './coding-agent/url-normalize.js'
export {
  CODING_AGENT_SYSTEM_SKILL_HEADING,
  CODING_AGENT_SYSTEM_SKILL_VERSION,
  loadCodingAgentSystemSkill,
} from './coding-agent/system-skill.js'
export {
  CODING_AGENT_VIRTUAL_BRIDGE_TOOLS,
} from './coding-agent/bridge-tool-defs.js'
export type { VirtualBridgeToolDefinition } from './coding-agent/bridge-tool-defs.js'
export {
  emptyWikiMountMeta,
  mountWikiTools,
} from './coding-agent/wiki-tool.js'
export type {
  MountedWikiTools,
  MountWikiToolsInput,
  WikiMountMeta,
  WikiRepoLabel,
} from './coding-agent/wiki-tool.js'
