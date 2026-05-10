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
