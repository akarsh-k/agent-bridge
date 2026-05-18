#!/usr/bin/env node
/**
 * GIT_ASKPASS helper — writes the PAT to stdout when git prompts for a
 * password, and an empty string otherwise (usernames, ssh key passphrases,
 * etc. — we never supply those here).
 *
 * Security model:
 *   - The PAT itself never touches disk. It's injected into the child's
 *     env via `spawnSandboxed({ env: { AGENT_BRIDGE_GIT_PAT }})`, lives
 *     only as long as the child, and is cleared by node on exit.
 *   - This script is short enough to audit in one sitting; keep it that way.
 *     Anything more complex belongs in TypeScript inside the calling job
 *     handler or HTTP route.
 *   - `.mjs` so we inherit a strict Node ESM parser without needing a
 *     local `package.json` override.
 *   - Co-located in `@agent-bridge/shared/bin` so worker (clone/pull) and
 *     backend (pre-clone ls-remote validation) resolve the same script.
 *
 * Invocation contract (set by git):
 *   argv[2] is the prompt string — e.g. "Password for 'https://user@host': ".
 *   Git accepts whatever single line we write to stdout as the answer and
 *   consumes this process cleanly on exit.
 */

const prompt = String(process.argv[2] ?? '').toLowerCase()

if (prompt.includes('password') || prompt.includes('token')) {
  const pat = process.env.AGENT_BRIDGE_GIT_PAT
  if (typeof pat === 'string' && pat.length > 0) {
    process.stdout.write(pat)
  }
}
