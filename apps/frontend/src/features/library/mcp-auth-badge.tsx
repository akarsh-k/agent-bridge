/**
 * Visible auth-state pill for an MCP connection. Surfaces the gap that
 * was costing operators silent failures: an HTTP/SSE MCP server with
 * no OAuth tokens looks identical in the connection list to one that's
 * fully authorized — until an agent run hits it and the model spins on
 * a buried `Invalid Data Source URL`-style error envelope. This badge
 * makes the state legible at a glance.
 *
 * Three rendered states:
 *   - `oauth` + `hasTokens: true`  → green "Authorized"
 *   - `oauth` + `hasTokens: false` → amber "Needs authorization" (the
 *     hint to click Test on the detail page and complete the OAuth
 *     popup flow before any agent uses the connection)
 *   - any other auth kind          → renders nothing (stdio, header,
 *     env-var auth all sit outside the OAuth state machine)
 */

import type { McpAuthResponse } from '@agent-bridge/shared'
import { Pill } from '../../ui/pill'

export function McpAuthBadge({ auth }: { auth: McpAuthResponse }) {
  if (auth.kind !== 'oauth') return null
  if (auth.hasTokens) {
    return (
      <Pill kind="success" dot>
        Authorized
      </Pill>
    )
  }
  return (
    <Pill kind="warn" dot>
      Needs authorization
    </Pill>
  )
}
