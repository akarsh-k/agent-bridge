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
// Chunker internals exposed for the pure-function smoke
// (`tests/smoke-knowledge-tool.ts`) — page-aware PDF chunking. Production
// callers reach these through `ingestKnowledgeFile`.
export { chunkDocument, stripPdfChrome } from './knowledge-ingest.js'
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
// Hybrid-retrieval internals exposed for the knowledge smokes
// (`tests/smoke-knowledge-tool.ts`, `tests/smoke-knowledge-e2e.ts`);
// some touch the DB (`runBm25Search`) or an LLM (`rerankWithLlm`).
// Production callers reach retrieval through `buildSearchKnowledgeTool`
// / `eagerPrefetchKnowledge` only.
export {
  buildRerankPool,
  buildSearchKnowledgeTool,
  eagerPrefetchKnowledge,
  parseRerankResponse,
  PER_FILE_DIVERSITY_CAP,
  RERANK_BM25_RESCUE_SLOTS,
  RERANK_CANDIDATE_CAP,
  rerankWithLlm,
  rrfFuse,
  RRF_BM25_WEIGHT,
  runBm25Search,
} from './knowledge-tool.js'
export type {
  AttachedKnowledgeFile,
  BuildSearchKnowledgeToolInput,
  ChunkHit,
  FusedChunk,
} from './knowledge-tool.js'
// Retrieval Scorecard engine: scores the hybrid-retrieval pipeline against
// an operator-authored golden set. Consumed by the scorecard route + tab.
export { runScorecard, ScorecardError } from './knowledge-eval.js'
export type { RunScorecardInput } from './knowledge-eval.js'
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
export {
  CODEBASE_INSPECTION_REPORT_TOKEN_CAP,
  CODEBASE_INSPECTION_REPORT_BUNDLE_CAP_MULTIPLIER,
} from './inspector/types.js'
export {
  packReportBundle,
  BUNDLE_STUB_WARNING,
  type PackedBundle,
} from './inspector/codebase-inspection-report.js'
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
