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
export {
  emptyInspectorMountMeta,
  mountInspectorTools,
} from './inspector/index.js'
export type {
  InspectorMountMeta,
  MountedInspector,
  MountInspectorToolsInput,
} from './inspector/index.js'
export type { MiniRepo, MiniRepoFile, MiniRepoChunk, MiniRepoGraphEdge, MiniRepoGraphNode, MiniRepoCrossRepoRelationship, InspectorIntent } from './inspector/types.js'
export { MINI_REPO_TOKEN_CAP } from './inspector/types.js'
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
export { getCurrentWorkingMemory } from './working-memory.js'
export type { CurrentWorkingMemory } from './working-memory.js'
export { loadAttachedRepos } from './inspector/repo-loader.js'
export type { LoadAttachedReposInput } from './inspector/repo-loader.js'
export { loadAllRepoRelationships } from './inspector/repo-relationships.js'
export type { LoadAllRepoRelationshipsInput } from './inspector/repo-relationships.js'
export {
  normalizeRemoteUrl,
  urlTail,
} from './inspector/url-normalize.js'
export {
  INSPECTOR_SYSTEM_PROMPT_HEADING,
  INSPECTOR_SYSTEM_PROMPT_VERSION,
  loadInspectorSystemPrompt,
} from './inspector/system-prompt.js'
export { resolveRepoFromHint } from './inspector/repo-resolve.js'
export type {
  MatchedSignal,
  MultiSignalHint,
  RepoResolveResult,
  ScoreEntry,
  SuggestedReply,
} from './inspector/repo-resolve.js'
export type { IdePreResolvedRepo } from './inspector/run-context.js'
