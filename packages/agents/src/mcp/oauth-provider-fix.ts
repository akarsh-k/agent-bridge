/**
 * Wrapper that fixes Mastra's `MCPOAuthClientProvider` not sending the
 * `client_id` parameter on token-endpoint requests.
 *
 * The bug:
 *   - Mastra's `MCPOAuthClientProvider.addClientAuthentication` is an
 *     empty method (`async addClientAuthentication() {}`).
 *   - The MCP SDK's `executeTokenRequest` does:
 *
 *         if (addClientAuthentication) {
 *           await addClientAuthentication(headers, params, ...)
 *         } else if (clientInformation) {
 *           applyClientAuthentication(...)   // sets client_id
 *         }
 *
 *     Mastra's empty method is truthy, so the SDK takes the FIRST
 *     branch and never reaches its built-in `applyClientAuthentication`
 *     (which would send `client_id` for public clients via
 *     `applyPublicAuth`).
 *   - Result: token POST to providers like Notion arrives without
 *     `client_id` → 401 `invalid_client: "Client ID is required"` →
 *     SDK retries → wipes credentials → user sees infinite-loop
 *     re-authorize behavior.
 *
 * The fix:
 *   - Subclass `MCPOAuthClientProvider` and re-implement
 *     `addClientAuthentication` to do the same thing the SDK's
 *     built-in `applyClientAuthentication` would have done. We can't
 *     just set the method to `undefined` because Mastra's class
 *     declares it as a real method on the prototype that the SDK
 *     would still see.
 *
 * Reference:
 *   - https://github.com/modelcontextprotocol/typescript-sdk SDK auth.js,
 *     `applyClientAuthentication` / `applyPublicAuth` / `applyPostAuth`
 *     / `applyBasicAuth`. We mirror that behavior here.
 */

import { MCPOAuthClientProvider } from '@mastra/mcp'

/**
 * Drop-in replacement for `MCPOAuthClientProvider`. Overrides
 * `addClientAuthentication` so the token endpoint actually receives
 * the `client_id` (and, for confidential clients, the `client_secret`).
 *
 * Selection logic mirrors the SDK's `selectClientAuthMethod`:
 *   - server-declared `token_endpoint_auth_method` on the registered
 *     client wins (RFC 7591)
 *   - else if a `client_secret` exists, default to `client_secret_post`
 *   - else default to `none` (public client)
 *
 * Because this is called per-request inside the SDK's
 * `executeTokenRequest`, it has no async side effects beyond the
 * `clientInformation()` lookup it inherits from the base class.
 */
export class FixedMCPOAuthClientProvider extends MCPOAuthClientProvider {
  constructor(options: ConstructorParameters<typeof MCPOAuthClientProvider>[0]) {
    super(options)
    // CRITICAL: the MCP SDK destructures `provider.addClientAuthentication`
    // and calls it as a bare function (`addClientAuthentication(...)`),
    // not as a method (`provider.addClientAuthentication(...)`). Without
    // this binding `this` is undefined inside the override and any
    // call to `this.clientInformation()` throws
    // "Cannot read properties of undefined (reading 'clientInformation')".
    // See SDK auth.js → executeTokenRequest where the option is
    // destructured from the call site without binding.
    this.addClientAuthentication = this.addClientAuthentication.bind(this)
  }

  override async addClientAuthentication(
    headers: Headers,
    params: URLSearchParams,
    _url: string | URL,
    metadata?: { token_endpoint_auth_methods_supported?: string[] },
  ): Promise<void> {
    const clientInfo = await this.clientInformation()
    if (!clientInfo) return
    const clientId = (clientInfo as { client_id?: string }).client_id
    const clientSecret = (clientInfo as { client_secret?: string }).client_secret
    if (!clientId) return

    const declared = (
      clientInfo as { token_endpoint_auth_method?: string }
    ).token_endpoint_auth_method
    const supported = metadata?.token_endpoint_auth_methods_supported ?? []
    const method = pickMethod(declared, supported, Boolean(clientSecret))

    switch (method) {
      case 'client_secret_basic': {
        if (!clientSecret) return
        const credentials =
          typeof btoa === 'function'
            ? btoa(`${clientId}:${clientSecret}`)
            : Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')
        headers.set('Authorization', `Basic ${credentials}`)
        return
      }
      case 'client_secret_post': {
        params.set('client_id', clientId)
        if (clientSecret) params.set('client_secret', clientSecret)
        return
      }
      case 'none':
      default: {
        // Public client (RFC 6749 §2.1) — `client_id` is REQUIRED in
        // the token request even though there's no secret. Notion,
        // Atlassian, and most modern OAuth providers enforce this.
        params.set('client_id', clientId)
        return
      }
    }
  }

  /**
   * The MCP SDK's `selectResourceURL` calls this (when present) instead of its
   * built-in RFC 9728 resource check, letting same-origin servers like Notion's
   * SSE endpoint work despite a declared resource path the default check
   * rejects. Delegates to {@link resolveMcpOAuthResource}; uses no `this`, so
   * the SDK's plain `provider.validateResourceURL(...)` call needs no binding.
   */
  async validateResourceURL(
    serverUrl: string | URL,
    resource?: string,
  ): Promise<URL | undefined> {
    return resolveMcpOAuthResource(serverUrl, resource)
  }
}

/**
 * Resolve the OAuth `resource` parameter for an MCP connection, relaxing the
 * MCP SDK's strict RFC 9728 path check while keeping its security boundary.
 *
 * The SDK's `selectResourceURL` (via `checkResourceAllowed`) only accepts a
 * declared protected-resource whose path the connection URL sits AT or BELOW.
 * Some OAuth MCP servers invert that: Notion's SSE endpoint connects at
 * `https://mcp.notion.com/sse` but advertises its resource as
 * `https://mcp.notion.com/sse/message` (a deeper path), so the default check
 * throws "Protected resource ... does not match expected ...". We trust a
 * declared resource as long as it is SAME-origin as the connection (the origin
 * is what protects the token from being minted for a different host); a
 * cross-origin resource is still rejected.
 *
 * @returns the resource URL to request a token for, or `undefined` when there
 *   is no usable declared resource (so the SDK omits the `resource` param).
 * @throws when the declared resource is on a different origin than the server.
 */
export function resolveMcpOAuthResource(
  serverUrl: string | URL,
  resource?: string,
): URL | undefined {
  if (!resource) return undefined
  let resourceUrl: URL
  let serverOrigin: string
  try {
    resourceUrl = new URL(resource)
    serverOrigin = new URL(serverUrl).origin
  } catch {
    // Malformed input: omit the `resource` param rather than crash the run.
    return undefined
  }
  if (resourceUrl.origin !== serverOrigin) {
    throw new Error(
      `[external-mcps] MCP server declared an OAuth resource on a different ` +
        `origin (${resourceUrl.origin}) than the connection (${serverOrigin}); ` +
        `refusing to request a token for it.`,
    )
  }
  return resourceUrl
}

/**
 * Pick the right token-endpoint auth method given DCR-declared
 * preference + server-supported list. Mirrors the SDK's
 * `selectClientAuthMethod` so a public client never accidentally
 * sends a `client_secret_basic` header (and vice versa).
 */
function pickMethod(
  declared: string | undefined,
  supported: ReadonlyArray<string>,
  hasSecret: boolean,
): 'client_secret_basic' | 'client_secret_post' | 'none' {
  if (
    declared === 'client_secret_basic' ||
    declared === 'client_secret_post' ||
    declared === 'none'
  ) {
    if (supported.length === 0 || supported.includes(declared)) return declared
  }
  if (supported.length === 0) {
    return hasSecret ? 'client_secret_basic' : 'none'
  }
  if (hasSecret && supported.includes('client_secret_basic'))
    return 'client_secret_basic'
  if (hasSecret && supported.includes('client_secret_post'))
    return 'client_secret_post'
  if (supported.includes('none')) return 'none'
  return hasSecret ? 'client_secret_post' : 'none'
}
