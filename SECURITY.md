# Security policy

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

If you discover a security issue in Agent Bridge, please report it
privately by opening a
[GitHub security advisory](https://github.com/akarsh-k/agent-bridge/security/advisories/new)
on this repository.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected commit SHA or release tag.
- Whether you'd like to be credited in the fix announcement.

You should expect an acknowledgement within **3 business days**. If you
do not receive a response, please follow up by adding a comment to the
advisory.

## Scope

This policy covers Agent Bridge code in this repository — the backend,
frontend, worker, mcp-bridge, shared packages, and the MCP OAuth /
secrets handling paths. Vulnerabilities in third-party dependencies
(e.g. `@mastra/*`, `gitnexus`, the MCP SDK) should be reported to those
projects directly; please open an issue here only if there's an
Agent-Bridge-specific way to mitigate.

## Threat model

Agent Bridge is designed as a **local, single-operator** dev tool:

- The backend process is trusted. If an attacker has code execution on
  the host, they have everything (the master key, every encrypted row,
  every cloned repo, every IDE-bridge subprocess).
- Postgres + Redis bind to loopback by default. The compose file has
  `no-new-privileges:true` and Postgres uses `--data-checksums`.
- Secrets at rest are encrypted with AES-256-GCM. The master key lives
  at `<AGENT_BRIDGE_DATA_DIR>/secret.key` (mode 0600), auto-generated
  on first boot or supplied via `AGENT_BRIDGE_SECRET_KEY`. **Backup
  this file** if you want encrypted rows to survive a data-dir reset.
- The MCP OAuth callback page validates `state` and rejects mismatched
  callbacks as CSRF. OAuth tokens persist encrypted in
  `mcp_oauth_state`; refresh happens transparently on tool-call.

In-scope vulnerability classes:

- Authentication / authorization bypass (OAuth callback, bridge
  endpoints, secrets handlers).
- Crypto / secret-handling flaws (envelope encryption, key derivation,
  token storage).
- Injection / RCE (SQL via Drizzle, command injection in worker
  subprocess spawning, MCP stdio sandbox escapes).
- XSS / template injection in any user-controlled HTML rendering
  (notably the OAuth callback page).
- Significant cleartext leakage of secrets in logs, run events, or HTTP
  responses.

Out-of-scope (please don't report these unless you find a concrete
exploit path):

- DOS / resource exhaustion.
- Theoretical race conditions.
- Best-practice / defense-in-depth gaps without a concrete attack.
- Issues that require host-level code execution to exploit.

## Disclosure

We aim to ship a fix before public disclosure. Once a fix is in a
released commit, we will credit reporters who'd like recognition in
the release notes.
