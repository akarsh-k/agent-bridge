import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnSandboxed } from './spawn.js'

/**
 * Cheap remote inspection. `git ls-remote --symref --heads <url>` lists
 * every remote branch and the HEAD symref without downloading any objects
 * — the right tool for "does this branch exist?" before we commit to a
 * full `git clone`.
 *
 * The same PAT envelope the clone path uses works here verbatim:
 * `GIT_ASKPASS` points at our shared helper (`bin/git-askpass.mjs`), and
 * the plaintext PAT lives only in the child process's env. No secrets on
 * disk, no terminal prompt — the sandboxed git inherits `GIT_TERMINAL_PROMPT=0`.
 *
 * Module is Node-only; routed through `@agent-bridge/shared/git-remote`.
 */

export interface LsRemoteResult {
  /** Branch names (no `refs/heads/` prefix). Sorted by `git ls-remote`'s
   *  default — by SHA — which is not user-friendly; sort downstream. */
  readonly branches: readonly string[]
  /** Default branch advertised by the remote (the `HEAD` symref target),
   *  or `null` when ls-remote returned without a symref line. */
  readonly headBranch: string | null
}

export type GitRemoteErrorKind =
  | 'auth'
  | 'not_found'
  | 'network'
  | 'timeout'
  | 'unknown'

export class GitRemoteError extends Error {
  constructor(
    message: string,
    readonly kind: GitRemoteErrorKind,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitRemoteError'
  }
}

export interface LsRemoteBranchesArgs {
  readonly remoteUrl: string
  /**
   * Plaintext PAT for private repos. Pass `null` when no PAT is
   * configured — public repos and SSH URLs ignore the env var.
   */
  readonly patPlaintext: string | null
  /**
   * Bound on the child process lifetime. Defaults to 15s — `ls-remote`
   * is small + remote-bound, so anything past that is almost certainly
   * a hung connection rather than a slow listing.
   */
  readonly timeoutMs?: number
}

/**
 * Run `git ls-remote --symref --heads <remoteUrl>` and parse the result.
 *
 * Returns `{ branches, headBranch }` on success. Throws `GitRemoteError`
 * with a discriminated `kind` so the caller can render an appropriate
 * message:
 *   - `auth`      — authentication failed (PAT wrong / missing / expired)
 *   - `not_found` — remote doesn't exist / is private without auth
 *   - `network`   — DNS / TCP / TLS failure
 *   - `timeout`   — exceeded `timeoutMs`
 *   - `unknown`   — anything else (raw stderr is preserved on the error)
 */
export async function lsRemoteBranches(
  args: LsRemoteBranchesArgs,
): Promise<LsRemoteResult> {
  const { remoteUrl, patPlaintext, timeoutMs = 15_000 } = args
  const askpass = getGitAskpassPath()

  const child = spawnSandboxed(
    'git',
    ['ls-remote', '--symref', '--heads', remoteUrl],
    {
      sandbox: 'git',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        GIT_ASKPASS: askpass,
        SSH_ASKPASS: askpass,
        AGENT_BRIDGE_GIT_PAT: patPlaintext ?? '',
      },
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // SIGTERM first; the sandbox's `GIT_TERMINAL_PROMPT=0` means git
    // can't be hung on a TTY, so the only stalls are network-bound
    // and respond to a polite signal.
    child.kill('SIGTERM')
  }, timeoutMs)

  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
  })
  clearTimeout(timer)

  if (timedOut) {
    throw new GitRemoteError(
      `git ls-remote ${remoteUrl} timed out after ${timeoutMs}ms`,
      'timeout',
      code,
      stderr,
    )
  }

  if (code !== 0) {
    throw new GitRemoteError(
      `git ls-remote exited with code ${code}`,
      classifyStderr(stderr),
      code,
      stderr,
    )
  }

  return parseLsRemoteOutput(stdout)
}

/**
 * `git ls-remote --symref --heads <url>` output looks like:
 *
 *   ref: refs/heads/master  HEAD
 *   abc123…  refs/heads/master
 *   def456…  refs/heads/dev
 *
 * The leading `ref: …` line is the HEAD symref (only present with
 * `--symref`). Subsequent rows are `<sha>\t<ref>`. We strip the
 * `refs/heads/` prefix from each.
 */
export function parseLsRemoteOutput(stdout: string): LsRemoteResult {
  const branches: string[] = []
  let headBranch: string | null = null

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    if (line.startsWith('ref:')) {
      // Format: `ref: refs/heads/<branch>  HEAD`
      const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line)
      if (match) headBranch = match[1] ?? null
      continue
    }

    // Format: `<sha>\trefs/heads/<branch>`
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const ref = line.slice(tabIdx + 1).trim()
    const HEADS_PREFIX = 'refs/heads/'
    if (!ref.startsWith(HEADS_PREFIX)) continue
    branches.push(ref.slice(HEADS_PREFIX.length))
  }

  return { branches, headBranch }
}

/**
 * Bucket git's stderr into one of our discriminated kinds. The patterns
 * are conservative — anything we can't recognise falls through to
 * `unknown`, where the raw `stderr` is still preserved on the thrown
 * error for the caller to surface.
 */
function classifyStderr(stderr: string): GitRemoteErrorKind {
  const s = stderr.toLowerCase()
  if (
    s.includes('authentication failed') ||
    s.includes('invalid username or password') ||
    s.includes('terminal prompts disabled') ||
    s.includes('could not read username') ||
    s.includes('could not read password')
  ) {
    return 'auth'
  }
  if (
    s.includes('repository not found') ||
    s.includes("doesn't exist") ||
    s.includes('not found')
  ) {
    return 'not_found'
  }
  if (
    s.includes('could not resolve host') ||
    s.includes('failed to connect') ||
    s.includes('connection refused') ||
    s.includes('connection reset') ||
    s.includes('network is unreachable') ||
    s.includes('ssl') ||
    s.includes('tls')
  ) {
    return 'network'
  }
  return 'unknown'
}

/**
 * Absolute path to the shared `GIT_ASKPASS` helper script. Both the
 * worker (clone / pull jobs) and the backend (this module's
 * `lsRemoteBranches`) resolve through here, so the helper script has
 * one source of truth at `packages/shared/bin/git-askpass.mjs`.
 *
 * Path math: `dist/git-remote.js` and `src/git-remote.ts` both sit one
 * level under the package root, so `../bin/git-askpass.mjs` lands on
 * the same file in dev and prod builds.
 */
export function getGitAskpassPath(): string {
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..', 'bin', 'git-askpass.mjs')
}
