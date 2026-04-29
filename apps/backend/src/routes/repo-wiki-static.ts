/**
 * Read-only static-serve for `<source>/.gitnexus/wiki/` artefacts.
 *
 * Routes:
 *   GET /api/repos/:id/wiki         → serves the bundled `index.html`.
 *   GET /api/repos/:id/wiki/*       → serves any file under the wiki dir
 *                                     (sub-pages, JSON, CSS, etc.).
 *
 * Why a separate router from `repo-jobs.ts`:
 *   - `POST /:id/wiki` already lives there and the static-serve path
 *     overlaps; keeping them in different files makes each handler's
 *     intent obvious and the wildcard route declaration tidy.
 *   - This handler does NOT touch the queues, DB, or SSE bus — it's
 *     pure filesystem read.
 *
 * Path-traversal guard: the wildcard segment is decoded, joined to the
 * absolute wiki dir, then resolved. We reject anything that escapes the
 * dir (e.g. `..` segments that survive normalization). Any read failure
 * surfaces as 404 — we don't reveal whether a missing file vs an
 * out-of-bounds path triggered the rejection.
 *
 * Content types: a tiny extension → MIME map covers what gitnexus emits
 * (`index.html`, `module_tree.json`). Anything unrecognised gets
 * `application/octet-stream` so browsers download it instead of trying
 * to render an unknown blob.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { repoIdParamSchema } from '@agent-bridge/shared'
import { repoWikiDir } from '@agent-bridge/shared/gitnexus'
import { repoSourceDir } from '@agent-bridge/shared/paths'
import { reposRepo } from '@agent-bridge/db'

import { getDb } from '../db.js'
import { httpError, httpValidationError } from '../lib/errors.js'

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

async function loadWikiFile(
  repoId: string,
  relativePath: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; reason: string }> {
  const handle = getDb()
  const row = await reposRepo.getForWorker(handle, repoId)
  if (!row) return { ok: false, reason: 'repo-not-found' }
  if (!row.localPath) return { ok: false, reason: 'no-source' }

  const wikiRoot = repoWikiDir(
    repoSourceDir({
      id: row.id,
      remoteUrl: row.remoteUrl,
      branch: row.branch,
    }),
  )
  // Normalise + resolve. `path.resolve` collapses `..` segments; the
  // `startsWith` check makes sure the resolved file lives under the
  // wiki dir even if a clever input slipped through the wildcard
  // (Hono URL-decodes `:wildcard` automatically, so a `%2e%2e` would
  // arrive as `..`).
  const requested = path.resolve(wikiRoot, relativePath)
  const wikiRootWithSep = wikiRoot.endsWith(path.sep)
    ? wikiRoot
    : wikiRoot + path.sep
  if (
    requested !== wikiRoot &&
    !requested.startsWith(wikiRootWithSep)
  ) {
    return { ok: false, reason: 'out-of-bounds' }
  }

  try {
    const stat = await fs.stat(requested)
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  } catch {
    return { ok: false, reason: 'enoent' }
  }

  return { ok: true, absolutePath: requested }
}

export const repoWikiStaticRouter = new Hono()
  // Bare wiki path → serve index.html. Useful so the UI can link to
  // `/api/repos/:id/wiki` directly without manufacturing the filename.
  .get(
    '/:id/wiki',
    zValidator('param', repoIdParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const result = await loadWikiFile(id, 'index.html')
      if (!result.ok) {
        return httpError(c, {
          code: 'not_found',
          message: `wiki not generated yet for repo ${id}`,
        })
      }
      const buffer = await fs.readFile(result.absolutePath)
      const body = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      )
      return c.body(body, 200, { 'content-type': contentTypeFor('index.html') })
    },
  )
  .get('/:id/wiki/*', async (c) => {
    const id = c.req.param('id')
    if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) {
      return httpError(c, {
        code: 'validation_failed',
        message: 'invalid repo id',
      })
    }

    // Hono returns the wildcard match via `c.req.path` minus the prefix;
    // simplest approach is to lift the suffix off the URL ourselves.
    // The route prefix is `/repos/:id/wiki/` — strip it.
    const fullPath = c.req.path
    const marker = `/wiki/`
    const idx = fullPath.indexOf(marker)
    if (idx < 0) {
      return httpError(c, {
        code: 'not_found',
        message: 'wiki path not parseable',
      })
    }
    const relative = fullPath.slice(idx + marker.length)
    if (relative.length === 0) {
      // Degenerate `/:id/wiki/` → fall back to index.html.
      const result = await loadWikiFile(id, 'index.html')
      if (!result.ok) {
        return httpError(c, {
          code: 'not_found',
          message: `wiki not generated yet for repo ${id}`,
        })
      }
      const buffer = await fs.readFile(result.absolutePath)
      const body = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      )
      return c.body(body, 200, {
        'content-type': contentTypeFor('index.html'),
      })
    }

    const result = await loadWikiFile(id, relative)
    if (!result.ok) {
      return httpError(c, {
        code: 'not_found',
        message: `wiki file not found: ${relative}`,
      })
    }
    const buffer = await fs.readFile(result.absolutePath)
    const body = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    )
    return c.body(body, 200, { 'content-type': contentTypeFor(relative) })
  })

export type RepoWikiStaticRouter = typeof repoWikiStaticRouter
