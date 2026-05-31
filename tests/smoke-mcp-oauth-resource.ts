/**
 * MCP OAuth resource-URL resolution smoke. Locks the fix for the MCP SDK's
 * strict RFC 9728 resource validation, which rejects an OAuth server whose
 * protected-resource metadata declares a resource path DEEPER than the URL the
 * client connects to. Notion's SSE endpoint does exactly this: you connect at
 * `https://mcp.notion.com/sse` but it declares the resource as
 * `https://mcp.notion.com/sse/message`, so the SDK's `selectResourceURL` throws
 * "Protected resource ... does not match expected ...".
 *
 * The SDK's `selectResourceURL` delegates to `provider.validateResourceURL`
 * when present. `FixedMCPOAuthClientProvider` supplies it via the pure
 * `resolveMcpOAuthResource` tested here: trust a SAME-origin declared resource
 * (whatever its path), still reject a CROSS-origin one.
 *
 * Run from repo root:
 *   pnpm test:mcp-oauth-resource
 */

/* eslint-disable no-console */

import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import * as oauthFix from '../packages/agents/src/mcp/oauth-provider-fix.js'

// Soft binding so the smoke still RUNS (and reports granular failures) before
// the fix exists, instead of dying at module load on a missing export.
const resolve = (
  oauthFix as {
    resolveMcpOAuthResource?: (
      serverUrl: string | URL,
      resource?: string,
    ) => URL | undefined
  }
).resolveMcpOAuthResource

// ─── harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

function tryResolve(
  serverUrl: string | URL,
  resource?: string,
): { ran: boolean; url?: URL; threw: boolean } {
  if (typeof resolve !== 'function') return { ran: false, threw: false }
  try {
    return { ran: true, url: resolve(serverUrl, resource), threw: false }
  } catch {
    return { ran: true, url: undefined, threw: true }
  }
}

console.log('━'.repeat(60))
console.log(' MCP OAuth resource-URL resolution smoke')
console.log('━'.repeat(60))

const NOTION_URL = 'https://mcp.notion.com/sse'
const NOTION_RESOURCE = 'https://mcp.notion.com/sse/message'

// 0. Document the bug (independent of our fix): the SDK's own rule rejects the
//    Notion shape, which is what makes `selectResourceURL` throw without a hook.
check(
  "SDK checkResourceAllowed rejects Notion's /sse vs /sse/message (the bug we fix)",
  checkResourceAllowed({
    requestedResource: NOTION_URL,
    configuredResource: NOTION_RESOURCE,
  }) === false,
)

// 1. The fix is wired up.
check('resolveMcpOAuthResource is exported', typeof resolve === 'function')

// 2. THE FIX: a same-origin resource DEEPER than the connection URL is accepted
//    (exactly what the SDK rejects, and exactly the Notion case).
{
  const r = tryResolve(NOTION_URL, NOTION_RESOURCE)
  check(
    'same-origin deeper resource (Notion) is accepted',
    r.ran && r.url instanceof URL && r.url.href === NOTION_RESOURCE,
    r.url ? r.url.href : r.threw ? 'threw' : 'missing',
  )
}

// 3. An exact-match resource is accepted.
{
  const r = tryResolve('https://x.example/mcp', 'https://x.example/mcp')
  check(
    'exact-match resource is accepted',
    r.ran && r.url?.href === 'https://x.example/mcp',
    r.url?.href ?? (r.threw ? 'threw' : 'missing'),
  )
}

// 4. A same-origin resource that is a PARENT of the connection path is accepted
//    too (origin is the only thing that gates trust).
{
  const r = tryResolve('https://x.example/a/b', 'https://x.example/a')
  check(
    'same-origin parent-path resource is accepted',
    r.ran && r.url?.href === 'https://x.example/a',
    r.url?.href ?? (r.threw ? 'threw' : 'missing'),
  )
}

// 5. No declared resource → no resource parameter (undefined), same as the SDK.
{
  const r = tryResolve(NOTION_URL, undefined)
  check(
    'undefined resource yields undefined',
    r.ran && r.url === undefined && !r.threw,
  )
}

// 6. A CROSS-origin resource is rejected. The origin check is the security
//    boundary we keep (never mint a token for a different host).
{
  const r = tryResolve(NOTION_URL, 'https://evil.example/sse/message')
  check('cross-origin resource is rejected (throws)', r.threw)
}

// 7. A malformed resource degrades to undefined rather than crashing the run.
{
  const r = tryResolve(NOTION_URL, 'not-a-url')
  check(
    'malformed resource yields undefined',
    r.ran && r.url === undefined && !r.threw,
  )
}

// 8. serverUrl may be a URL object (the SDK passes a URL, not a string).
{
  const r = tryResolve(new URL(NOTION_URL), NOTION_RESOURCE)
  check(
    'serverUrl as a URL object works',
    r.ran && r.url?.href === NOTION_RESOURCE,
    r.url?.href ?? (r.threw ? 'threw' : 'missing'),
  )
}

// ─── summary ──────────────────────────────────────────────────────────────────
console.log('━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`   ✗ ${f}`)
  console.log('━'.repeat(60))
  process.exit(1)
}
console.log(' All checks passed.')
console.log('━'.repeat(60))
process.exit(0)
