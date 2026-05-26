/**
 * Per-kind label + summary derivation for run / worker timeline events.
 *
 * Today the event timeline shows only the raw `kind` string ("run.tool.called")
 * and a chevron — operators have to expand each row to find which tool fired,
 * what arguments it used, or how long it took. `summarizeEvent` pulls the
 * useful fields out of `payload` (typed in `@agent-bridge/shared/events`)
 * and returns a row-ready descriptor: short title, optional summary line,
 * pill tone, and a coarse group used by the in-timeline filter chips
 * (All / Tool / Model / Errors).
 *
 * Defensive: payloads pass through `RunRedactor` and historical rows can
 * pre-date a payload-shape change, so every accessor handles `unknown`
 * without throwing. When a field is missing or the wrong type, that line
 * is just omitted from the summary — never a crash, never a "[object Object]".
 *
 * Added but not yet consumed. A follow-up wires this into
 * `EventTimeline` in `run-detail-sheet.tsx`.
 */

import type { PillKind } from '../../ui/pill'

/** Coarse buckets used by the timeline filter chips. */
export type EventGroup =
  | 'lifecycle' // run.started / run.finished / run.error
  | 'model' // run.step.started / run.step.finished
  | 'token' // run.token / run.token.batch
  | 'tool' // run.tool.called / run.tool.result
  | 'mcp' // run.mcp.log
  | 'inspector' // inspector.* wrapper telemetry
  | 'knowledge' // knowledge.search.* / .prefetch.* / .ingest.*
  | 'worker' // repo.clone / index / embed / wiki / worker.*
  | 'config' // agent.config.changed
  | 'other'

export interface EventSummary {
  /** Row title — short, human-readable. Replaces the bare `kind` string. */
  readonly title: string
  /** Optional second line — args preview, duration, error message etc. */
  readonly summary: string | null
  /** Pill colour for the kind chip. */
  readonly tone: PillKind
  /** Filter-chip bucket. */
  readonly group: EventGroup
  /** True when the event represents a failure — used by the Errors filter. */
  readonly isError: boolean
}

/**
 * Map a `(kind, payload)` pair to a row-ready descriptor. Always returns
 * something — unknown kinds get a sensible fallback so the timeline keeps
 * rendering even when a new event ships before the labels table is updated.
 */
export function summarizeEvent(
  kind: string,
  payload: unknown,
): EventSummary {
  const p = isObject(payload) ? payload : {}

  switch (kind) {
    // ─── run.* lifecycle ────────────────────────────────────────────
    case 'run.started': {
      const agentName = str(p['agentName'])
      const modelId = str(p['modelId'])
      const toolCount = num(p['toolCount'])
      const parts: string[] = []
      if (agentName) parts.push(agentName)
      if (modelId) parts.push(modelId)
      if (toolCount !== null)
        parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`)
      return {
        title: 'Run started',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'lifecycle',
        isError: false,
      }
    }
    case 'run.finished': {
      const reason = str(p['finishReason'])
      const stepCount = num(p['stepCount'])
      const durationMs = num(p['durationMs'])
      const totalTokens = num(deepGet(p, ['usage', 'totalTokens']))
      const parts: string[] = []
      if (reason) parts.push(reason)
      if (stepCount !== null)
        parts.push(`${stepCount} step${stepCount === 1 ? '' : 's'}`)
      if (durationMs !== null) parts.push(formatDurationMs(durationMs))
      if (totalTokens !== null) parts.push(`${totalTokens.toLocaleString()} tok`)
      return {
        title: 'Run finished',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'success',
        group: 'lifecycle',
        isError: false,
      }
    }
    case 'run.error': {
      const kindTag = str(p['kind'])
      const message = str(p['message'])
      return {
        title: kindTag ? `Run error (${kindTag})` : 'Run error',
        summary: message ? truncate(message, 140) : null,
        tone: 'danger',
        group: 'lifecycle',
        isError: true,
      }
    }

    // ─── run.* steps + tokens ───────────────────────────────────────
    case 'run.step.started': {
      const idx = num(p['stepIndex'])
      return {
        title: idx !== null ? `Step ${idx + 1} started` : 'Step started',
        summary: null,
        tone: 'neutral',
        group: 'model',
        isError: false,
      }
    }
    case 'run.step.finished': {
      const idx = num(p['stepIndex'])
      const reason = str(p['finishReason'])
      const totalTokens = num(deepGet(p, ['usage', 'totalTokens']))
      const parts: string[] = []
      if (reason) parts.push(reason)
      if (totalTokens !== null) parts.push(`${totalTokens.toLocaleString()} tok`)
      return {
        title: idx !== null ? `Step ${idx + 1} finished` : 'Step finished',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'model',
        isError: false,
      }
    }
    case 'run.token': {
      const idx = num(p['index'])
      const text = str(p['text'])
      return {
        title: 'Token',
        summary:
          text !== null
            ? `${idx !== null ? `[${idx}] ` : ''}${truncate(text, 60)}`
            : null,
        tone: 'neutral',
        group: 'token',
        isError: false,
      }
    }
    case 'run.token.batch': {
      const start = num(p['startIndex'])
      const end = num(p['endIndex'])
      const dur = num(p['durationMs'])
      const count =
        start !== null && end !== null ? end - start + 1 : null
      const parts: string[] = []
      if (count !== null)
        parts.push(`${count.toLocaleString()} token${count === 1 ? '' : 's'}`)
      if (dur !== null) parts.push(formatDurationMs(dur))
      return {
        title: 'Token batch',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'token',
        isError: false,
      }
    }

    // ─── run.model.* (per-step LLM call telemetry) ─────────────────
    case 'run.model.called': {
      const model = str(p['model']) ?? 'model'
      const stepIdx = num(p['stepIndex'])
      const request = p['request']
      const messages = isObject(request)
        ? deepGet(request, ['body', 'messages'])
        : null
      const tools = isObject(request)
        ? deepGet(request, ['body', 'tools'])
        : null
      const parts: string[] = []
      if (Array.isArray(messages))
        parts.push(`${messages.length} message${messages.length === 1 ? '' : 's'}`)
      if (Array.isArray(tools))
        parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`)
      const warnings = p['warnings']
      if (Array.isArray(warnings) && warnings.length > 0)
        parts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)
      return {
        title:
          stepIdx !== null
            ? `Model: ${model} · step ${stepIdx + 1}`
            : `Model: ${model}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'accent',
        group: 'model',
        isError: false,
      }
    }
    case 'run.model.result': {
      const model = str(p['model']) ?? 'model'
      const dur = num(p['durationMs'])
      const reason = str(p['finishReason'])
      const totalTokens = num(deepGet(p, ['usage', 'totalTokens']))
      const text = str(p['text'])
      const toolCalls = p['toolCalls']
      const parts: string[] = []
      if (reason) parts.push(reason)
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (totalTokens !== null) parts.push(`${totalTokens.toLocaleString()} tok`)
      if (Array.isArray(toolCalls) && toolCalls.length > 0)
        parts.push(`${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}`)
      else if (text) parts.push(`${text.length.toLocaleString()} chars`)
      const isErr = reason === 'error' || reason === 'content-filter'
      return {
        title: `Model: ${model} → ${reason ?? 'done'}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: isErr ? 'danger' : 'success',
        group: 'model',
        isError: isErr,
      }
    }

    // ─── run.tool.* (Mastra tool calls) ─────────────────────────────
    case 'run.tool.called': {
      const toolName = str(p['toolName']) ?? 'tool'
      const input = p['input']
      return {
        title: `Tool: ${toolName}`,
        summary: previewArgs(input),
        tone: 'accent',
        group: 'tool',
        isError: false,
      }
    }
    case 'run.tool.result': {
      const toolName = str(p['toolName']) ?? 'tool'
      const error = str(p['error'])
      if (error) {
        return {
          title: `Tool: ${toolName} → error`,
          summary: truncate(error, 140),
          tone: 'danger',
          group: 'tool',
          isError: true,
        }
      }
      const size = approximateBytes(p['output'])
      return {
        title: `Tool: ${toolName} → ok`,
        summary: size !== null ? `${formatBytes(size)} returned` : null,
        tone: 'success',
        group: 'tool',
        isError: false,
      }
    }

    // ─── run.mcp.log ────────────────────────────────────────────────
    case 'run.mcp.log': {
      const conn = str(p['connectionName']) ?? 'mcp'
      const level = str(p['level']) ?? 'info'
      const line = str(p['line'])
      return {
        title: `MCP: ${conn}`,
        summary: line ? `[${level}] ${truncate(line, 120)}` : `[${level}]`,
        tone: level === 'error' ? 'danger' : level === 'warn' ? 'warn' : 'neutral',
        group: 'mcp',
        isError: level === 'error',
      }
    }

    // ─── inspector.* (wrapper telemetry) ────────────────────────────
    case 'inspector.tool.called': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const args = str(p['argsPreview'])
      return {
        title: `Wrapper: ${w}`,
        summary: args ? truncate(args, 120) : null,
        tone: 'accent',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.tool.result': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const status = str(p['status']) ?? 'ok'
      const dur = num(p['durationMs'])
      const message = str(p['message'])
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (message) parts.push(truncate(message, 100))
      return {
        title: `Wrapper: ${w} → ${status}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: status === 'error' ? 'danger' : status === 'fallback' ? 'warn' : 'success',
        group: 'inspector',
        isError: status === 'error',
      }
    }
    case 'inspector.llm.called': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const purpose = str(p['purpose']) ?? 'call'
      const model = str(p['model'])
      const prompt = str(p['promptPreview'])
      const parts: string[] = []
      if (model) parts.push(model)
      if (prompt) parts.push(truncate(prompt, 100))
      return {
        title: `LLM (${purpose}): ${w}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.llm.result': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const dur = num(p['durationMs'])
      const inTok = num(deepGet(p, ['tokens', 'input']))
      const outTok = num(deepGet(p, ['tokens', 'output']))
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (inTok !== null && outTok !== null)
        parts.push(`${inTok}+${outTok} tok`)
      return {
        title: `LLM result: ${w}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.gitnexus.called': {
      const tool = str(p['tool']) ?? 'gitnexus'
      const args = str(p['argsPreview'])
      return {
        title: `Gitnexus: ${tool}`,
        summary: args ? truncate(args, 120) : null,
        tone: 'accent',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.gitnexus.result': {
      const tool = str(p['tool']) ?? 'gitnexus'
      const ok = bool(p['ok']) ?? true
      const dur = num(p['durationMs'])
      const preview = str(p['resultPreview'])
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (preview) parts.push(truncate(preview, 100))
      return {
        title: `Gitnexus: ${tool} → ${ok ? 'ok' : 'fail'}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: ok ? 'success' : 'danger',
        group: 'inspector',
        isError: !ok,
      }
    }
    case 'inspector.keyword.called': {
      const repo = str(p['repoLabel']) ?? 'repo'
      const queries = str(p['queriesPreview'])
      return {
        title: `Keyword search: ${repo}`,
        summary: queries ? truncate(queries, 120) : null,
        tone: 'neutral',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.keyword.result': {
      const repo = str(p['repoLabel']) ?? 'repo'
      const ok = bool(p['ok']) ?? true
      const hits = num(p['hitCount'])
      const dur = num(p['durationMs'])
      const message = str(p['message'])
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (hits !== null) parts.push(`${hits} hit${hits === 1 ? '' : 's'}`)
      if (!ok && message) parts.push(truncate(message, 80))
      return {
        title: `Keyword: ${repo} → ${ok ? 'ok' : 'fail'}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: ok ? 'neutral' : 'danger',
        group: 'inspector',
        isError: !ok,
      }
    }
    case 'inspector.report.built': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const files = num(p['fileCount'])
      const chunks = num(p['chunkCount'])
      const used = num(p['tokensUsed'])
      const cap = num(p['tokensCap'])
      const truncated = bool(p['truncated']) ?? false
      const warnings = strArr(p['warnings'])
      const parts: string[] = []
      if (files !== null) parts.push(`${files} file${files === 1 ? '' : 's'}`)
      if (chunks !== null)
        parts.push(`${chunks} chunk${chunks === 1 ? '' : 's'}`)
      if (used !== null && cap !== null) parts.push(`${used}/${cap} tok`)
      if (truncated) {
        // Surface what was actually dropped so operators can judge
        // whether to raise the cap. Older events that pre-date the
        // `warnings` field fall back to the bare `truncated` marker.
        parts.push(warnings ? warnings.join('; ') : 'truncated')
      }
      return {
        title: `Inspection report built: ${w}`,
        summary: parts.length > 0 ? truncate(parts.join(' · '), 220) : null,
        tone: truncated ? 'warn' : 'neutral',
        group: 'inspector',
        isError: false,
      }
    }
    case 'inspector.fallback': {
      const w = str(p['wrapperName']) ?? 'wrapper'
      const reason = str(p['reason'])
      return {
        title: `Wrapper fallback: ${w}`,
        summary: reason ? truncate(reason, 140) : null,
        tone: 'warn',
        group: 'inspector',
        isError: false,
      }
    }

    // ─── knowledge.* (search + prefetch + ingest) ───────────────────
    case 'knowledge.search.called': {
      const query = str(p['query'])
      const scope = num(p['scopeFileCount'])
      const topK = num(p['topK'])
      const parts: string[] = []
      if (query) parts.push(`"${truncate(query, 80)}"`)
      if (scope !== null)
        parts.push(`${scope} file${scope === 1 ? '' : 's'}`)
      if (topK !== null) parts.push(`top ${topK}`)
      return {
        title: 'Search knowledge',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.search.result': {
      const dur = num(p['durationMs'])
      const chunks = num(p['chunkCount'])
      const files = num(p['fileCount'])
      const capped = p['capped'] === true
      const rerank = p['rerankUsed'] === true
      const hint = str(p['hint'])
      const parts: string[] = []
      if (chunks !== null)
        parts.push(`${chunks} chunk${chunks === 1 ? '' : 's'}`)
      if (files !== null && files > 0)
        parts.push(`across ${files} file${files === 1 ? '' : 's'}`)
      if (rerank) parts.push('reranked')
      if (capped) parts.push('cap hit')
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (hint && (chunks === 0 || capped)) parts.push(truncate(hint, 80))
      return {
        title: 'Search knowledge',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: capped ? 'warn' : chunks === 0 ? 'warn' : 'success',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.prefetch.called': {
      const query = str(p['query'])
      const topK = num(p['topK'])
      const parts: string[] = []
      if (query) parts.push(`"${truncate(query, 80)}"`)
      if (topK !== null) parts.push(`top ${topK}`)
      return {
        title: 'Pre-fetch knowledge',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.prefetch.result': {
      const dur = num(p['durationMs'])
      const chunks = num(p['chunkCount'])
      const parts: string[] = []
      if (chunks !== null)
        parts.push(`${chunks} chunk${chunks === 1 ? '' : 's'}`)
      if (dur !== null) parts.push(formatDurationMs(dur))
      return {
        title: 'Pre-fetch knowledge',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'success',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.ingest.started': {
      const name = str(p['fileName']) ?? str(p['fileId']) ?? 'file'
      const kindStr = str(p['kind'])
      const bytes = num(p['bytes'])
      const parts: string[] = []
      if (kindStr) parts.push(kindStr.toUpperCase())
      if (bytes !== null) parts.push(`${(bytes / 1024).toFixed(1)} KB`)
      return {
        title: `Ingest: ${truncate(name, 60)}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.ingest.progress': {
      const step = str(p['step']) ?? 'progress'
      const done = num(p['chunksDone'])
      const total = num(p['chunksTotal'])
      const summary =
        done !== null && total !== null ? `${done} / ${total} chunks` : null
      return {
        title: `Ingest: ${step}`,
        summary,
        tone: 'neutral',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.ingest.ok': {
      const dur = num(p['durationMs'])
      const chunks = num(p['chunkCount'])
      const pages = num(p['pageCount'])
      const parts: string[] = []
      if (chunks !== null)
        parts.push(`${chunks} chunk${chunks === 1 ? '' : 's'}`)
      if (pages !== null) parts.push(`${pages} page${pages === 1 ? '' : 's'}`)
      if (dur !== null) parts.push(formatDurationMs(dur))
      return {
        title: 'Ingest done',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'success',
        group: 'knowledge',
        isError: false,
      }
    }
    case 'knowledge.ingest.fail': {
      const msg = str(p['message'])
      const dur = num(p['durationMs'])
      const parts: string[] = []
      if (msg) parts.push(truncate(msg, 140))
      if (dur !== null) parts.push(formatDurationMs(dur))
      return {
        title: 'Ingest failed',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'danger',
        group: 'knowledge',
        isError: true,
      }
    }

    // ─── repo.* worker pipelines ────────────────────────────────────
    case 'repo.clone.started':
      return workerStarted('Cloning', str(p['remoteUrl']) ?? str(p['branch']))
    case 'repo.clone.progress':
      return workerProgress('Clone progress', str(p['line']))
    case 'repo.clone.ok':
      return workerOk('Clone done', num(p['durationMs']))
    case 'repo.clone.fail':
      return workerFail('Clone failed', str(p['message']))

    case 'repo.pull.started':
      return workerStarted('Pulling', str(p['remoteUrl']) ?? str(p['branch']))
    case 'repo.pull.progress':
      return workerProgress('Pull progress', str(p['line']))
    case 'repo.pull.ok':
      return workerOk('Pull done', num(p['durationMs']))
    case 'repo.pull.fail':
      return workerFail('Pull failed', str(p['message']))

    case 'repo.index.started':
      return workerStarted('Indexing', str(p['mode']))
    case 'repo.index.progress':
      return workerProgress('Index progress', str(p['line']))
    case 'repo.index.ok':
      return workerOk('Index done', num(p['durationMs']))
    case 'repo.index.fail':
      return workerFail('Index failed', str(p['message']))

    case 'repo.embed.started':
      return workerStarted(
        'Embedding',
        joinNonEmpty([str(p['providerKind']), str(p['model'])]),
      )
    case 'repo.embed.ok': {
      const dur = num(p['durationMs'])
      const files = num(p['files'])
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (files !== null) parts.push(`${files} file${files === 1 ? '' : 's'}`)
      return {
        title: 'Embedding done',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'success',
        group: 'worker',
        isError: false,
      }
    }
    case 'repo.embed.fail':
      return workerFail('Embedding failed', str(p['message']))

    case 'repo.wiki.started':
      return workerStarted(
        'Wiki generating',
        joinNonEmpty([str(p['mode']), str(p['providerKind'])]),
      )
    case 'repo.wiki.progress':
      return workerProgress('Wiki progress', str(p['line']))
    case 'repo.wiki.ok': {
      const dur = num(p['durationMs'])
      const pages = num(p['pages'])
      const mode = str(p['resultMode'])
      const parts: string[] = []
      if (dur !== null) parts.push(formatDurationMs(dur))
      if (pages !== null) parts.push(`${pages} page${pages === 1 ? '' : 's'}`)
      if (mode) parts.push(mode)
      return {
        title: 'Wiki done',
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'success',
        group: 'worker',
        isError: false,
      }
    }
    case 'repo.wiki.fail':
      return workerFail('Wiki failed', str(p['message']))

    // ─── worker.* generic (rarely used; kept for forward-compat) ────
    case 'worker.progress':
      return {
        title: 'Worker progress',
        summary: str(p['line']) ? truncate(str(p['line'])!, 140) : null,
        tone: 'neutral',
        group: 'worker',
        isError: false,
      }
    case 'worker.log':
      return {
        title: 'Worker log',
        summary: str(p['line']) ? truncate(str(p['line'])!, 140) : null,
        tone: 'neutral',
        group: 'worker',
        isError: false,
      }
    case 'worker.finished':
      return {
        title: 'Worker finished',
        summary: null,
        tone: 'success',
        group: 'worker',
        isError: false,
      }
    case 'worker.error':
      return {
        title: 'Worker error',
        summary: str(p['message']) ? truncate(str(p['message'])!, 140) : null,
        tone: 'danger',
        group: 'worker',
        isError: true,
      }

    // ─── agent.config.changed ───────────────────────────────────────
    case 'agent.config.changed': {
      const action = str(p['action']) ?? 'changed'
      const resource = str(p['resource']) ?? 'config'
      const label = str(p['label'])
      const detail = str(p['detail'])
      const parts: string[] = []
      if (label) parts.push(label)
      if (detail) parts.push(truncate(detail, 100))
      return {
        title: `Config: ${action} ${resource}`,
        summary: parts.length > 0 ? parts.join(' · ') : null,
        tone: 'neutral',
        group: 'config',
        isError: false,
      }
    }

    case 'ping':
      return {
        title: 'Ping',
        summary: null,
        tone: 'neutral',
        group: 'other',
        isError: false,
      }

    default:
      return {
        title: kind,
        summary: null,
        tone: kind.endsWith('.fail') || kind.endsWith('.error')
          ? 'danger'
          : kind.endsWith('.ok') || kind.endsWith('.finished')
            ? 'success'
            : 'neutral',
        group: 'other',
        isError: kind.endsWith('.fail') || kind.endsWith('.error'),
      }
  }
}

// ─── Worker shorthand builders ──────────────────────────────────────────

function workerStarted(title: string, hint: string | null): EventSummary {
  return {
    title,
    summary: hint ? truncate(hint, 140) : null,
    tone: 'neutral',
    group: 'worker',
    isError: false,
  }
}
function workerProgress(title: string, line: string | null): EventSummary {
  return {
    title,
    summary: line ? truncate(line, 140) : null,
    tone: 'neutral',
    group: 'worker',
    isError: false,
  }
}
function workerOk(title: string, durationMs: number | null): EventSummary {
  return {
    title,
    summary: durationMs !== null ? formatDurationMs(durationMs) : null,
    tone: 'success',
    group: 'worker',
    isError: false,
  }
}
function workerFail(title: string, message: string | null): EventSummary {
  return {
    title,
    summary: message ? truncate(message, 140) : null,
    tone: 'danger',
    group: 'worker',
    isError: true,
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  const totalS = Math.round(ms / 1000)
  const m = Math.floor(totalS / 60)
  const s = totalS % 60
  return `${m}m ${s}s`
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n}B`
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(2)}MB`
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(1, max - 1)) + '…'
}

// ─── Defensive accessors (no `any`, no throws) ─────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}
function strArr(v: unknown): readonly string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return out.length > 0 ? out : null
}
function deepGet(obj: Record<string, unknown>, path: ReadonlyArray<string>): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!isObject(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

function joinNonEmpty(parts: ReadonlyArray<string | null>): string | null {
  const out = parts.filter((p): p is string => p !== null && p.length > 0)
  return out.length > 0 ? out.join(' · ') : null
}

/**
 * One-line preview of a tool's `input` argument bag. Strings come through
 * as quoted snippets; everything else gets a tiny inline JSON.
 */
function previewArgs(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input === 'string') return truncate(`"${input}"`, 120)
  if (isObject(input)) {
    const entries = Object.entries(input)
    if (entries.length === 0) return '{}'
    const first = entries.slice(0, 3).map(([k, v]) => `${k}=${shortValue(v)}`)
    const tail = entries.length > 3 ? ` +${entries.length - 3} more` : ''
    return truncate(first.join(' · ') + tail, 140)
  }
  if (Array.isArray(input))
    return truncate(`[${input.map(shortValue).join(', ')}]`, 140)
  return truncate(String(input), 140)
}

function shortValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return `"${truncate(v, 32)}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length}]`
  if (isObject(v)) return `{${Object.keys(v).length}}`
  return '?'
}

/**
 * Approximate byte size of a payload value via JSON.stringify length.
 * Returns null when the value can't be serialised (circular, BigInt, …).
 */
function approximateBytes(v: unknown): number | null {
  if (v === undefined || v === null) return null
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return typeof s === 'string' ? s.length : null
  } catch {
    return null
  }
}
