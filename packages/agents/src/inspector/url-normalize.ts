/**
 * Normalise a git remote URL into a canonical form so the resolver can
 * compare two URLs by string equality without falling for trivial
 * differences (`https` vs `git@`, trailing `/`, `.git` suffix,
 * uppercase host, …).
 *
 * Examples that all collapse to `github.com/owner/repo`:
 *
 *   https://github.com/owner/repo.git
 *   https://GitHub.com/owner/repo/
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo
 *
 * Anything we can't parse is returned as the trimmed lowercase input. The
 * resolver still falls through to fuzzy matching, so a weird URL never
 * blows up the call. We deliberately do NOT call `new URL(...)`
 * unconditionally because it rejects the SSH `git@host:owner/repo`
 * form.
 *
 * Pure function. No I/O. Lives in its own file so the resolver can
 * import it without dragging in the rest of the resolver's surface,
 * and so a future smoke script can target URL normalisation without
 * having to set up a candidate fixture.
 */

const TRAILING_SLASHES = /\/+$/
const TRAILING_DOT_GIT = /\.git$/i
const SSH_SHORT = /^([a-z0-9._-]+)@([a-z0-9.-]+):(.+)$/i

/**
 * Public entry point. Returns a string that is safe for `===` against
 * any other normalised URL pointing at the same upstream repo.
 */
export function normalizeRemoteUrl(input: string): string {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  if (trimmed.length === 0) return ''

  // SSH short form: `git@github.com:owner/repo(.git)?`. The colon makes
  // it not a valid URL per WHATWG, so handle this BEFORE any `new URL`
  // attempt. We drop the user (`git@` is the convention; we don't need
  // it for identity matching since the same repo could be cloned with
  // a different user).
  const sshMatch = SSH_SHORT.exec(trimmed)
  if (sshMatch) {
    const host = sshMatch[2] ?? ''
    const path = sshMatch[3] ?? ''
    return canonical(host, path)
  }

  // Anything with `://` we hand to the URL parser.
  if (trimmed.includes('://')) {
    try {
      const u = new URL(trimmed)
      return canonical(u.hostname, u.pathname)
    } catch {
      // fall through to the bare-string path below
    }
  }

  // Bare `github.com/owner/repo` form (no scheme, no SSH user). Treat
  // first path segment as host, rest as path. Useful when the IDE
  // coding agent passes `repo_hint: 'github.com/company/traveller-web'`
  // verbatim from a copy-paste.
  if (trimmed.includes('/')) {
    const slash = trimmed.indexOf('/')
    const host = trimmed.slice(0, slash)
    const path = trimmed.slice(slash + 1)
    return canonical(host, path)
  }

  return trimmed.toLowerCase()
}

/**
 * Pull the last segment of the URL path. typically `repo` from
 * `github.com/owner/repo`. Used as the gitnexus-label fallback (mirrors
 * `guessLabelFromUrl` in `mcp/gitnexus-mcp.ts:281`) and as one of the
 * fuzzy-match anchors in the resolver.
 */
export function urlTail(input: string): string {
  const norm = normalizeRemoteUrl(input)
  if (norm.length === 0) return ''
  const segments = norm.split('/').filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? ''
}

function canonical(host: string, path: string): string {
  const cleanHost = host.toLowerCase().replace(TRAILING_SLASHES, '')
  const cleanPath = path
    .replace(/^\/+/, '')
    .replace(TRAILING_SLASHES, '')
    .replace(TRAILING_DOT_GIT, '')
    .toLowerCase()
  if (cleanHost.length === 0) return cleanPath
  if (cleanPath.length === 0) return cleanHost
  return `${cleanHost}/${cleanPath}`
}
