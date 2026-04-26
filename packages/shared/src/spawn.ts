import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ensureDataDirs } from './paths.js'

/**
 * Sandboxed child-process spawn. Every `gitnexus` / `git` / user-supplied MCP
 * stdio command in the app goes through this so the child can't write to the
 * user's real `~/.gitnexus/`, `~/.gitconfig`, `~/.notion/` etc.
 *
 * What we clamp:
 * - `HOME` / `USERPROFILE` → the isolated `gitnexus-home` dir under our data root.
 *   This redirects where apps write their per-user config/registry/cache.
 * - For `{ sandbox: 'git' }`: also set `GIT_CONFIG_GLOBAL=/dev/null`,
 *   `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
 *   `GIT_ASKPASS=/bin/echo` so we don't inherit global git hooks/aliases and
 *   can't hang on an interactive password prompt.
 * - Strip inherited credential leaks: `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`.
 *
 * What we deliberately DO NOT strip:
 * - `PATH` — most MCPs legitimately need to find system binaries.
 * - The rest of the parent env — a blanket strip would break `LANG`, `TZ`,
 *   proxy settings, fastembed model cache envs, etc.
 *
 * This module is Node-only.
 */

export type SandboxMode = 'default' | 'git' | 'mcp-stdio'

export interface SpawnSandboxedOptions extends Omit<SpawnOptions, 'env'> {
  /** Extra env vars to set on top of the sandbox baseline. */
  env?: NodeJS.ProcessEnv
  /**
   * - `default`     — HOME clamp, credential leaks stripped.
   * - `git`         — `default` + git isolation flags.
   * - `mcp-stdio`   — `default`, meant for user-configured inbound MCPs. Has an
   *                   escape hatch via `allowHostHome`.
   */
  sandbox?: SandboxMode
  /**
   * Opt-out of the HOME clamp for MCPs that legitimately need the user's CLI
   * auth state (e.g. `gh` tokens, `aws sso`). Off by default — the user must
   * explicitly enable it per-connection in the UI.
   */
  allowHostHome?: boolean
}

/** Spawn a child process with the sandbox envelope applied. */
export function spawnSandboxed(
  command: string,
  args: readonly string[] = [],
  options: SpawnSandboxedOptions = {},
): ChildProcess {
  const { env, sandbox = 'default', allowHostHome = false, ...rest } = options
  const sandboxEnv = buildSandboxedEnv({ sandbox, allowHostHome, extra: env })
  return spawn(command, [...args], { ...rest, env: sandboxEnv, shell: false })
}

/** Build the env dict the child will see. Exported for tests. */
export function buildSandboxedEnv(opts: {
  sandbox: SandboxMode
  allowHostHome: boolean
  extra?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const { gitnexusHomeDir } = ensureDataDirs()

  const base: NodeJS.ProcessEnv = { ...process.env }

  delete base['SSH_AUTH_SOCK']
  delete base['GPG_AGENT_INFO']

  if (!opts.allowHostHome) {
    base['HOME'] = gitnexusHomeDir
    base['USERPROFILE'] = gitnexusHomeDir
    base['XDG_CONFIG_HOME'] = gitnexusHomeDir
    base['XDG_DATA_HOME'] = gitnexusHomeDir
    base['XDG_CACHE_HOME'] = gitnexusHomeDir
    base['XDG_STATE_HOME'] = gitnexusHomeDir
  }

  if (opts.sandbox === 'git') {
    base['GIT_CONFIG_GLOBAL'] = devNull()
    base['GIT_CONFIG_SYSTEM'] = devNull()
    base['GIT_TERMINAL_PROMPT'] = '0'
    // Default askpass: a no-op that returns an empty password, so a misconfigured
    // clone fails fast rather than hanging on a TTY prompt. Callers that need to
    // authenticate (e.g. the clone-repo worker job) override this via `env`
    // below — that override is intentional, not an escape hatch to widen.
    base['GIT_ASKPASS'] = process.platform === 'win32' ? 'rem' : '/bin/echo'
  }

  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (v === undefined) {
        delete base[k]
      } else {
        base[k] = v
      }
    }
  }

  return base
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}
