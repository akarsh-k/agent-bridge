/**
 * On-disk source slicer for inspector wrappers.
 *
 * `gitnexus_context` returns symbol METADATA (uid, name, kind, filePath,
 * startLine, endLine) plus its incoming/outgoing edges — never file
 * content. So when a wrapper wants to put the actual code in front of
 * the LLM, it has to slice from disk. We have the source on disk
 * already (clone-repo + index-repo land it under `repos.local_path` /
 * `repoSourceDir(descriptor)`), so this helper does the read.
 *
 * Bounded by `MAX_BYTES_PER_READ` so a wrapper can't accidentally pull
 * a 10 MB minified bundle into the codebase inspection report.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AttachedRepo } from '@agent-bridge/shared'
import { repoSourceDir } from '@agent-bridge/shared/paths'

/**
 * Hard cap per read. Larger files are truncated to this many bytes
 * starting from the requested startLine; the caller's chunk-builder
 * still respects the codebase inspection report's overall token budget downstream.
 */
export const MAX_BYTES_PER_READ = 32 * 1024

export interface ReadFileChunkInput {
  readonly repo: Pick<AttachedRepo, 'repo_id' | 'remote_url' | 'branch'>
  /** Path relative to the repo's source root, e.g. `app/routes/products.py`. */
  readonly filePath: string
  /** 1-based inclusive. When omitted, reads from the start of the file. */
  readonly startLine?: number | null
  /** 1-based inclusive. When omitted, reads to the end of the file (subject to the byte cap). */
  readonly endLine?: number | null
  /**
   * When true, expand the slice with `padLines` of context above and
   * below the requested span. Useful for snippets so the LLM has
   * surrounding context, not just the matched line.
   */
  readonly padLines?: number
}

export interface ReadFileChunkResult {
  readonly content: string
  /** 1-based, inclusive. Reflects the slice actually returned (after padding + truncation). */
  readonly startLine: number
  readonly endLine: number
  readonly language: string
  /** True if the slice was truncated to fit `MAX_BYTES_PER_READ`. */
  readonly truncated: boolean
}

export async function readFileChunkFromDisk(
  input: ReadFileChunkInput,
): Promise<ReadFileChunkResult | null> {
  const { repo, filePath, startLine, endLine, padLines = 0 } = input

  const sourceDir = repoSourceDir({
    id: repo.repo_id,
    remoteUrl: repo.remote_url,
    branch: repo.branch,
  })
  const absolute = path.resolve(sourceDir, filePath)
  // Path traversal guard: refuse anything that escapes the repo root.
  if (!absolute.startsWith(sourceDir + path.sep) && absolute !== sourceDir) {
    return null
  }

  let raw: string
  try {
    raw = await fs.readFile(absolute, 'utf8')
  } catch {
    return null
  }

  const lines = raw.split('\n')
  const totalLines = lines.length

  const requestedStart = clampLine(startLine ?? 1, 1, totalLines)
  const requestedEnd = clampLine(endLine ?? totalLines, requestedStart, totalLines)

  const paddedStart = clampLine(requestedStart - padLines, 1, totalLines)
  const paddedEnd = clampLine(requestedEnd + padLines, paddedStart, totalLines)

  const slice = lines.slice(paddedStart - 1, paddedEnd).join('\n')
  const truncated = slice.length > MAX_BYTES_PER_READ
  const bounded = truncated ? slice.slice(0, MAX_BYTES_PER_READ) : slice

  return {
    content: bounded,
    startLine: paddedStart,
    endLine: paddedEnd,
    language: inferLanguage(filePath),
    truncated,
  }
}

function clampLine(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return Math.floor(value)
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.py':
      return 'python'
    case '.rs':
      return 'rust'
    case '.go':
      return 'go'
    case '.java':
      return 'java'
    case '.rb':
      return 'ruby'
    case '.md':
      return 'markdown'
    case '.json':
      return 'json'
    case '.yml':
    case '.yaml':
      return 'yaml'
    case '.toml':
      return 'toml'
    case '.sh':
    case '.bash':
      return 'shell'
    default:
      return 'unknown'
  }
}
