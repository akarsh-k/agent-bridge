/**
 * Public surface of `@agent-bridge/agents`.
 *
 * Keep this lean: apps should only ever need `buildAgent(...)` and the
 * handful of types it returns/accepts. Internal Mastra types must not
 * leak outside this package — the root ESLint guard rail enforces that
 * `@mastra/*` imports are allowed in this directory only.
 */

export {
  buildAgent,
  composeInstructions,
  resolveBaseUrl,
  splitSkills,
} from './build-agent.js'
export type {
  BuildAgentInput,
  BuiltAgent,
  BuiltAgentMeta,
  MemoryMountMeta,
} from './build-agent.js'
// Exported for smoke tests (`tests/smoke-skill-lazy-loading.ts`) that
// drive the lazy-skill catalog + `read_skill` tool through pure-function
// inputs without spinning up a real Mastra Agent. Production callers
// reach this code via `buildAgent` only.
export { buildReadSkillTool } from './skills-tool.js'
// Knowledge files pipeline + retrieval. Backend's POST /api/files
// fires `ingestKnowledgeFile` background; `buildAgent` mounts the
// search tool when an agent has files attached.
export { ingestKnowledgeFile } from './knowledge-ingest.js'
export type { IngestKnowledgeFileInput } from './knowledge-ingest.js'
export {
  ensureFileChunksDim,
  FileChunksDimMismatch,
  readFileChunksDim,
  rebuildFileChunksAtDim,
} from './knowledge-dim.js'
export type {
  DimSyncResult,
  FileChunksDimSnapshot,
} from './knowledge-dim.js'
// Hybrid-retrieval pure-function helpers exposed for smoke tests
// (`tests/smoke-knowledge-tool.ts`). Production callers should reach
// the retrieval path through `buildSearchKnowledgeTool` only.
export {
  buildSearchKnowledgeTool,
  eagerPrefetchKnowledge,
  parseRerankResponse,
  rrfFuse,
} from './knowledge-tool.js'
export type {
  AttachedKnowledgeFile,
  BuildSearchKnowledgeToolInput,
  ChunkHit,
  FusedChunk,
} from './knowledge-tool.js'
// Per-run async-context primitive — exported for smoke tests that
// need to drive the search tool with thread-scoped or reference-
// scoped state. Production callers reach this via `dispatchRun`.
export { withRunContext, getRunContext } from './run-context.js'
export type { RunContextStore } from './run-context.js'
export {
  emptyInspectorMountMeta,
  mountInspectorTools,
} from './inspector/index.js'
export type {
  InspectorMountMeta,
  MountedInspector,
  MountInspectorToolsInput,
} from './inspector/index.js'
export type { CodebaseInspectionReport, CodebaseInspectionReportFile, CodebaseInspectionReportChunk, CodebaseInspectionReportGraphEdge, CodebaseInspectionReportGraphNode, CodebaseInspectionReportCrossRepoRelationship, InspectorIntent } from './inspector/types.js'
export { CODEBASE_INSPECTION_REPORT_TOKEN_CAP } from './inspector/types.js'
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
// Exported for test harnesses (tests/smoke-dispatcher-mapper.ts). The
// mapper is a pure function over Mastra-style chunk inputs; exposing
// it lets us drive synthetic streams through the same logic the
// production dispatcher uses, without spinning up Mastra.
export {
  mapChunk,
  mapChunkToModelEvent,
  makeInitialMapChunkState,
} from './run-dispatcher.js'
export type { MapChunkState } from './run-dispatcher.js'
// Exported for test harnesses (tests/smoke-gitnexus-callers.ts). Each
// caller is the thin wrapper around one `gitnexus_*` MCP tool; exposing
// them lets the smoke drive synthetic gitnexus payloads through the
// real unwrap + parse pipeline without spinning up the gitnexus
// subprocess.
export {
  callGitnexusApiImpact,
  callGitnexusCypher,
  callGitnexusImpact,
  callGitnexusQuery,
  callGitnexusRouteMap,
} from './inspector/gitnexus-callers.js'
export type {
  GitnexusApiImpactConsumer,
  GitnexusApiImpactResult,
  GitnexusApiImpactRoute,
  GitnexusCypherResult,
  GitnexusCypherRow,
  GitnexusImpactResult,
  GitnexusImpactRow,
  GitnexusQueryHit,
  GitnexusQueryResponse,
  GitnexusRoute,
  GitnexusRouteConsumer,
} from './inspector/gitnexus-callers.js'
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
