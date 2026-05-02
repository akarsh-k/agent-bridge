/**
 * System tool. exposes the gitnexus-generated wiki to the LLM.
 *
 * Two Mastra tools mount alongside the gitnexus MCP tools:
 *
 *   - `gitnexus_wiki_list_pages(repo)`. returns the page tree (slug,
 *     title, kind, parent, children) so the LLM can pick a relevant
 *     page without reading every file. Read from `module_tree.json`
 *     when present, falls back to a directory scan of `*.md`.
 *
 *   - `gitnexus_wiki_get_page(repo, slug)`. returns the markdown
 *     body of a single page. Path-traversal guarded: `slug` is
 *     validated against `^[a-zA-Z0-9._-]+$` and joined to wikiDir;
 *     anything that resolves outside wikiDir is rejected with a
 *     clear error.
 *
 * Why these are NOT in `mcp/`: gitnexus-mcp.ts and external-mcps.ts
 * are real MCP-protocol mounts (subprocess + JSON-RPC). The wiki
 * tool is just a direct filesystem read, so we use Mastra's
 * `createTool` instead of going through `MCPClient`. They live in
 * `coding-agent/` because they're a system tool that benefits the
 * coding-agent toolkit most directly. but they're available to
 * every entry point (in-app Chat, IDE bridge, anything).
 *
 * Repo resolution: the `repo` arg is a friendly label (role, alias,
 * or URL tail). same convention as the gitnexus `repo` argument.
 * Resolution scopes to the agent's attached repos so a typo doesn't
 * accidentally hit a repo from a different agent.
 *
 * Failure modes:
 *   - Repo not attached to this agent     → "no repo matches X"
 *   - Repo's wiki not generated           → "wiki status: <status>"
 *   - Slug not found in wikiDir           → "page X not found; available: …"
 *   - Slug fails path-traversal check     → "invalid slug"
 *   - wikiDir doesn't exist on disk       → "wiki not on disk; regenerate"
 *
 * Each is a soft error returned in the tool result (not an
 * exception) so the LLM can adjust without crashing the run.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createTool, type Tool } from '@mastra/core/tools'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { AgentBridgeDb } from '@agent-bridge/db'
import { schema } from '@agent-bridge/db'
import { repoWikiDir } from '@agent-bridge/shared/gitnexus'
import { repoSourceDir } from '@agent-bridge/shared/paths'

// ─── Public surface ─────────────────────────────────────────────────────

export interface MountWikiToolsInput {
  readonly db: AgentBridgeDb
  readonly agentId: string
  /**
   * When true, short-circuit the mount. same role as `disableGitnexus`
   * on `mountGitnexusMcp`. Lets the smoke script reproduce a
   * "wiki-off" agent without editing rows.
   */
  readonly disabled?: boolean
}

export interface WikiMountMeta {
  /** True iff at least one tool was registered. */
  readonly mounted: boolean
  /** Count of attached repos with `wikiStatus='ready'`. Drives the LLM hint. */
  readonly repoCount: number
  /** Always 2 when mounted; 0 otherwise. Surfaced for the budget card. */
  readonly toolCount: number
  /** Per-repo metadata for hint injection in the system prompt. */
  readonly repoLabels: readonly WikiRepoLabel[]
}

export interface WikiRepoLabel {
  readonly label: string
  readonly remoteUrl: string
  readonly branch: string
  readonly pages: number | null
}

export interface MountedWikiTools {
  readonly tools: Record<string, Tool<any, any, any, any>>
  readonly meta: WikiMountMeta
}

export function emptyWikiMountMeta(): WikiMountMeta {
  return { mounted: false, repoCount: 0, toolCount: 0, repoLabels: [] }
}

// ─── Mount ──────────────────────────────────────────────────────────────

/**
 * Build the two wiki tools, scoped to one agent. Returns `null` when
 * the agent has zero repos with a ready wiki. keeping a no-op tool
 * mounted would just bloat the LLM's tool list with errors. The
 * caller (buildAgent) compensates by skipping the merge.
 */
export async function mountWikiTools(
  input: MountWikiToolsInput,
): Promise<MountedWikiTools | null> {
  const { db, agentId, disabled = false } = input

  if (disabled) return null

  const repos = await loadWikiReadyRepos(db, agentId)
  if (repos.length === 0) return null

  // Closure capture: each tool's `execute` re-resolves the repo arg
  // against the current set every call. We re-fetch the row on
  // demand (rather than caching `repos` in the closure) because
  // wiki status can flip from `ready` → `generating` mid-session
  // when the operator regenerates; the LLM should see fresh state
  // on the next call without a BuiltAgent rebuild.
  const tools: Record<string, Tool<any, any, any, any>> = {
    gitnexus_wiki_list_pages: createListPagesTool({ db, agentId }),
    gitnexus_wiki_get_page: createGetPageTool({ db, agentId }),
  }

  return {
    tools,
    meta: {
      mounted: true,
      repoCount: repos.length,
      toolCount: Object.keys(tools).length,
      repoLabels: repos.map((r) => ({
        label: r.label,
        remoteUrl: r.remoteUrl,
        branch: r.branch,
        pages: r.wikiPages,
      })),
    },
  }
}

// ─── Tool factories ─────────────────────────────────────────────────────

/**
 * Slug shape: must start with an alphanumeric (no leading dot or
 * hyphen) and contain only `[a-zA-Z0-9._-]`. The leading-alphanumeric
 * rule rules out `..` (path-traversal-adjacent), `.git` (dotfile
 * area), and `-flag`-style values that some shells parse as flags
 * if they leak into command-line tooling. Generated wiki pages
 * always satisfy this; rejecting anything else is a safety net for
 * an LLM that hallucinates a slug.
 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

interface ToolCtx {
  readonly db: AgentBridgeDb
  readonly agentId: string
}

function createListPagesTool(ctx: ToolCtx): Tool<any, any, any, any> {
  return createTool({
    id: 'gitnexus_wiki_list_pages',
    description:
      'List the pages in a repo\'s pre-generated wiki. narrative summaries written by `gitnexus wiki`. Cheaper than fanning out 5+ graph queries when you need a high-level "how does X work" overview. Pass the repo\'s friendly label (role / alias / URL tail). Returns an ordered tree: `[{ slug, title, kind, parentSlug?, childrenSlugs? }]`. Use the slug with `gitnexus_wiki_get_page` to read the body.',
    inputSchema: z
      .object({
        repo: z.string().min(1).describe(
          'Friendly label of an attached repo (role, alias, or URL tail).',
        ),
      })
      .strict(),
    outputSchema: z
      .object({
        ok: z.boolean(),
        repo: z.string().nullable(),
        pages: z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            kind: z.string().nullable(),
            parentSlug: z.string().nullable(),
            childrenSlugs: z.array(z.string()),
          }),
        ),
        message: z.string().optional(),
      })
      .strict(),
    execute: async (input) => {
      const repoArg = input.repo
      const repoRow = await resolveAgentRepo(ctx, repoArg)
      if (!repoRow.ok) {
        return { ok: false, repo: null, pages: [], message: repoRow.message }
      }
      if (repoRow.repo.wikiStatus !== 'ready') {
        return {
          ok: false,
          repo: repoRow.repo.label,
          pages: [],
          message: `wiki for "${repoRow.repo.label}" is currently ${repoRow.repo.wikiStatus}; regenerate from the Library tab.`,
        }
      }
      const wikiDir = repoWikiDirFor(repoRow.repo)
      const list = await listWikiPages(wikiDir)
      if (!list.ok) {
        return {
          ok: false,
          repo: repoRow.repo.label,
          pages: [],
          message: list.message,
        }
      }
      return {
        ok: true,
        repo: repoRow.repo.label,
        pages: list.pages.map((p) => ({ ...p })),
      }
    },
  })
}

function createGetPageTool(ctx: ToolCtx): Tool<any, any, any, any> {
  return createTool({
    id: 'gitnexus_wiki_get_page',
    description:
      'Read one page of a repo\'s pre-generated wiki. Use this AFTER `gitnexus_wiki_list_pages` told you which slug to fetch. Returns the markdown body. narrative summary the gitnexus wiki LLM produced from the graph at generation time. The wiki is a snapshot, so verify any concrete file/line claim against `gitnexus_context` before quoting it.',
    inputSchema: z
      .object({
        repo: z.string().min(1).describe(
          'Friendly label of an attached repo (role, alias, or URL tail).',
        ),
        slug: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Page slug from `gitnexus_wiki_list_pages` (e.g. `overview`, `module-cart`).',
          ),
      })
      .strict(),
    outputSchema: z
      .object({
        ok: z.boolean(),
        repo: z.string().nullable(),
        slug: z.string().nullable(),
        title: z.string().nullable(),
        body: z.string().nullable(),
        message: z.string().optional(),
      })
      .strict(),
    execute: async (input) => {
      const repoArg = input.repo
      const slug = input.slug
      if (!SLUG_RE.test(slug)) {
        return {
          ok: false,
          repo: null,
          slug,
          title: null,
          body: null,
          message:
            'invalid slug. only letters, digits, dot, hyphen, and underscore are allowed.',
        }
      }
      const repoRow = await resolveAgentRepo(ctx, repoArg)
      if (!repoRow.ok) {
        return {
          ok: false,
          repo: null,
          slug,
          title: null,
          body: null,
          message: repoRow.message,
        }
      }
      if (repoRow.repo.wikiStatus !== 'ready') {
        return {
          ok: false,
          repo: repoRow.repo.label,
          slug,
          title: null,
          body: null,
          message: `wiki for "${repoRow.repo.label}" is currently ${repoRow.repo.wikiStatus}; regenerate from the Library tab.`,
        }
      }
      const page = await readWikiPage(repoWikiDirFor(repoRow.repo), slug)
      if (!page.ok) {
        return {
          ok: false,
          repo: repoRow.repo.label,
          slug,
          title: null,
          body: null,
          message: page.message,
        }
      }
      return {
        ok: true,
        repo: repoRow.repo.label,
        slug,
        title: page.title,
        body: page.body,
      }
    },
  })
}

// ─── Repo lookup ─────────────────────────────────────────────────────────

interface ResolvedAgentRepo {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
  readonly label: string
  readonly wikiStatus: string
  readonly aliases: readonly string[]
  readonly role: string | null
}

type ResolveResult =
  | { ok: true; repo: ResolvedAgentRepo }
  | { ok: false; message: string }

/**
 * Match a friendly label against the agent's attached repos. We
 * deliberately keep this much simpler than `resolveRepoHint` -
 * gitnexus tools accept `repo` as a single string, no multi-signal
 * object, no fuzzy scoring. Exact match (case-insensitive) on
 * role / alias / URL tail. Ambiguous → list candidates, miss →
 * list everything attached.
 */
async function resolveAgentRepo(
  ctx: ToolCtx,
  arg: string,
): Promise<ResolveResult> {
  const trimmed = arg.trim().toLowerCase()
  if (trimmed.length === 0) {
    return { ok: false, message: 'repo argument is empty' }
  }
  const rows = await ctx.db.db
    .select({
      repoId: schema.repos.id,
      remoteUrl: schema.repos.remoteUrl,
      branch: schema.repos.branch,
      role: schema.agentRepos.role,
      aliases: schema.agentRepos.aliases,
      wikiStatus: schema.repos.wikiStatus,
    })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(eq(schema.agentRepos.agentId, ctx.agentId))

  if (rows.length === 0) {
    return {
      ok: false,
      message: 'this agent has no attached repos',
    }
  }

  const candidates = rows.map((r) => ({
    repoId: r.repoId,
    remoteUrl: r.remoteUrl,
    branch: r.branch,
    role: r.role,
    aliases: (r.aliases ?? []) as readonly string[],
    wikiStatus: r.wikiStatus,
    label: r.role?.trim() || urlTail(r.remoteUrl),
  }))

  const hits = candidates.filter((c) => {
    const role = c.role?.trim().toLowerCase() ?? ''
    if (role && role === trimmed) return true
    if (c.aliases.some((a) => a.toLowerCase() === trimmed)) return true
    if (urlTail(c.remoteUrl).toLowerCase() === trimmed) return true
    return false
  })

  if (hits.length === 1) {
    return { ok: true, repo: hits[0]! }
  }
  if (hits.length > 1) {
    const labels = hits.map((h) => h.label).join(', ')
    return {
      ok: false,
      message: `repo "${arg}" is ambiguous. matches ${hits.length} attached repos (${labels}). Pass the operator's role label to disambiguate.`,
    }
  }
  const labels = candidates.map((c) => c.label).join(', ')
  return {
    ok: false,
    message: `no attached repo matches "${arg}". Available: ${labels}.`,
  }
}

/**
 * Last path segment of a remote URL. Mirrors `guessLabelFromUrl` in
 * `mcp/gitnexus-mcp.ts`. kept inline to avoid pulling that whole
 * module into this file just for a 3-line helper.
 */
function urlTail(remoteUrl: string): string {
  const clean = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const segs = clean.split(/[/:]/).filter((s) => s.length > 0)
  return segs[segs.length - 1] ?? 'repo'
}

function repoWikiDirFor(repo: ResolvedAgentRepo): string {
  return repoWikiDir(
    repoSourceDir({
      id: repo.repoId,
      remoteUrl: repo.remoteUrl,
      branch: repo.branch,
    }),
  )
}

// ─── Wiki dir reads ─────────────────────────────────────────────────────

interface ListPagesOk {
  readonly ok: true
  readonly pages: ReadonlyArray<{
    slug: string
    title: string
    kind: string | null
    parentSlug: string | null
    childrenSlugs: string[]
  }>
}
interface ListPagesErr {
  readonly ok: false
  readonly message: string
}
type ListPagesResult = ListPagesOk | ListPagesErr

/**
 * Walk the wiki dir. Prefers `module_tree.json` because it carries
 * structural info (kind, parent, children) the LLM uses to pick
 * the right page. Falls back to a directory scan when the JSON is
 * missing or malformed. gitnexus is the source of truth, but a
 * partial read is better than no read.
 */
async function listWikiPages(wikiDir: string): Promise<ListPagesResult> {
  const treePath = path.join(wikiDir, 'module_tree.json')
  let tree: unknown = null
  try {
    const raw = await fs.readFile(treePath, 'utf8')
    tree = JSON.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Could be missing tree but markdown files present. fall through.
    } else {
      // Unreadable / malformed. log nothing (we're in a tool execute,
      // not a service boot), surface the directory-scan path instead.
    }
  }

  if (tree && typeof tree === 'object') {
    const nodes = parseModuleTreeNodes(tree)
    if (nodes !== null && nodes.length > 0) {
      return { ok: true, pages: nodes }
    }
  }

  // Fallback: directory scan. Gives slug + best-effort title.
  let entries: string[]
  try {
    entries = await fs.readdir(wikiDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        message: `wiki directory not found on disk. regenerate via the Library tab. Expected at ${wikiDir}`,
      }
    }
    return {
      ok: false,
      message: `unable to read wiki directory: ${(err as Error).message}`,
    }
  }
  const mdFiles = entries.filter((e) => e.endsWith('.md'))
  if (mdFiles.length === 0) {
    return {
      ok: false,
      message: 'wiki directory has no markdown pages. regenerate via the Library tab.',
    }
  }
  const out: Array<{
    slug: string
    title: string
    kind: string | null
    parentSlug: string | null
    childrenSlugs: string[]
  }> = []
  for (const f of mdFiles.sort()) {
    const slug = f.slice(0, -3)
    if (!SLUG_RE.test(slug)) continue
    const title = await peekTitle(path.join(wikiDir, f), slug)
    out.push({
      slug,
      title,
      kind: slug === 'overview' ? 'overview' : null,
      parentSlug: null,
      childrenSlugs: [],
    })
  }
  return { ok: true, pages: out }
}

interface ParsedTreeNode {
  slug: string
  title: string
  kind: string | null
  parentSlug: string | null
  childrenSlugs: string[]
}

/**
 * Best-effort parser for `module_tree.json`. Gitnexus's exact shape
 * isn't pinned by a published schema, so we tolerate variation:
 * accept either `{ nodes: [...] }`, an array of nodes, or a single
 * root node with nested `children`. Extracts only the fields we
 * need; everything else is ignored.
 */
function parseModuleTreeNodes(tree: unknown): ParsedTreeNode[] | null {
  const out: ParsedTreeNode[] = []
  const visit = (
    node: unknown,
    parentSlug: string | null,
  ): string | null => {
    if (!node || typeof node !== 'object') return null
    const n = node as Record<string, unknown>
    const slug = typeof n['slug'] === 'string' ? n['slug'] : null
    if (!slug || !SLUG_RE.test(slug)) return null
    const title =
      typeof n['title'] === 'string' && n['title'].length > 0
        ? n['title']
        : slug
    const kind = typeof n['kind'] === 'string' ? n['kind'] : null
    const childrenRaw = Array.isArray(n['children']) ? n['children'] : []
    const childrenSlugs: string[] = []
    for (const c of childrenRaw) {
      const childSlug = visit(c, slug)
      if (childSlug) childrenSlugs.push(childSlug)
    }
    out.push({ slug, title, kind, parentSlug, childrenSlugs })
    return slug
  }

  if (Array.isArray(tree)) {
    for (const n of tree) visit(n, null)
  } else if (typeof tree === 'object' && tree !== null) {
    const root = tree as Record<string, unknown>
    if (Array.isArray(root['nodes'])) {
      for (const n of root['nodes']) visit(n, null)
    } else if (typeof root['slug'] === 'string') {
      visit(root, null)
    } else {
      return null
    }
  } else {
    return null
  }
  return out.length > 0 ? out : null
}

interface ReadPageOk {
  readonly ok: true
  readonly title: string
  readonly body: string
}
interface ReadPageErr {
  readonly ok: false
  readonly message: string
}

async function readWikiPage(
  wikiDir: string,
  slug: string,
): Promise<ReadPageOk | ReadPageErr> {
  // Path-traversal guard. SLUG_RE already enforces this at the
  // input boundary, but we re-check the resolved path against
  // wikiDir as belt-and-braces in case the regex is ever loosened.
  const filePath = path.join(wikiDir, `${slug}.md`)
  const resolved = path.resolve(filePath)
  const wikiResolved = path.resolve(wikiDir)
  if (!resolved.startsWith(`${wikiResolved}${path.sep}`)) {
    return { ok: false, message: 'invalid slug (path traversal rejected)' }
  }
  let body: string
  try {
    body = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Surface the available pages so the LLM can pick a real one.
      const list = await listWikiPages(wikiDir)
      const available = list.ok
        ? list.pages.map((p) => p.slug).join(', ')
        : '(none)'
      return {
        ok: false,
        message: `page "${slug}" not found. Available: ${available}.`,
      }
    }
    return {
      ok: false,
      message: `unable to read page: ${(err as Error).message}`,
    }
  }
  const title = extractTitle(body) ?? slug
  return { ok: true, title, body }
}

/**
 * Pull the first markdown heading from a page so list_pages can
 * show "Cart Module" instead of `module-cart`. Cheap. we read
 * up to 256 bytes and look for `^# ` on the first non-empty line.
 */
async function peekTitle(filePath: string, fallback: string): Promise<string> {
  try {
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(256)
      const { bytesRead } = await fd.read(buf, 0, 256, 0)
      const head = buf.subarray(0, bytesRead).toString('utf8')
      const t = extractTitle(head)
      return t ?? fallback
    } finally {
      await fd.close()
    }
  } catch {
    return fallback
  }
}

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^[ \t]*#\s+(.+?)\s*$/m)
  return match ? (match[1] ?? null) : null
}

// ─── Initial repo load ──────────────────────────────────────────────────

interface WikiReadyRepo {
  readonly repoId: string
  readonly remoteUrl: string
  readonly branch: string
  readonly label: string
  readonly wikiPages: number | null
}

async function loadWikiReadyRepos(
  db: AgentBridgeDb,
  agentId: string,
): Promise<WikiReadyRepo[]> {
  const rows = await db.db
    .select({
      repoId: schema.repos.id,
      remoteUrl: schema.repos.remoteUrl,
      branch: schema.repos.branch,
      role: schema.agentRepos.role,
      wikiPages: schema.repos.wikiPages,
    })
    .from(schema.agentRepos)
    .innerJoin(schema.repos, eq(schema.agentRepos.repoId, schema.repos.id))
    .where(
      and(
        eq(schema.agentRepos.agentId, agentId),
        eq(schema.repos.wikiStatus, 'ready'),
      ),
    )
  return rows.map((r) => ({
    repoId: r.repoId,
    remoteUrl: r.remoteUrl,
    branch: r.branch,
    label: r.role?.trim() || urlTail(r.remoteUrl),
    wikiPages: r.wikiPages,
  }))
}
