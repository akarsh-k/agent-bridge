/**
 * OAuth callback landing page. Loaded inside the popup the user
 * approved on the upstream service. We post a `mcp-oauth-complete`
 * message to the opener (the agent-builder Attach MCP sheet) and
 * close ourselves. If the opener is gone (user closed it manually)
 * we render a "you can close this window" stub.
 */

import { useEffect, useState } from 'react'

export function OAuthCallbackPage() {
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    try {
      window.opener?.postMessage(
        {
          type: 'mcp-oauth-complete',
          search: window.location.search,
          hash: window.location.hash,
        },
        window.location.origin,
      )
    } catch {
      // Cross-origin opener — caller listens on its own origin and
      // ignores our payload, so silent failure is fine.
    }
    // Defer the close so the opener has a tick to receive the
    // message before we dispose ourselves.
    const t = setTimeout(() => {
      try {
        window.close()
        setClosed(true)
      } catch {
        setClosed(true)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className="ab-page"
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        textAlign: 'center',
      }}
    >
      <div
        role="status"
        aria-live="polite"
        className="ab-card ab-card-pad"
        style={{ maxWidth: 440 }}
      >
        <div
          className="ab-section-title"
          style={{
            marginBottom: 'var(--space-1_5)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2_5)',
          }}
        >
          {!closed && <span className="ab-pulse-dot" aria-hidden="true" />}
          {closed ? 'Done' : 'Finalising authorisation…'}
        </div>
        <div className="ab-section-sub">
          {closed
            ? 'You can safely close this window.'
            : 'This window will close itself in a moment.'}
        </div>
      </div>
    </div>
  )
}
