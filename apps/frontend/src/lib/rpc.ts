import { hc } from 'hono/client'
import type { AppType } from 'backend'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

/** Must be an absolute URL; in production set VITE_API_URL to your HTTPS API origin. */
function resolveBaseUrl(): string {
  const raw = import.meta.env.VITE_API_URL?.trim()
  if (!raw) return DEFAULT_BASE_URL
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${url.protocol}`)
    }
    if (import.meta.env.PROD && url.protocol !== 'https:') {
      console.warn(
        `[rpc] VITE_API_URL is not HTTPS in a production build: ${raw}`,
      )
    }
    return url.origin + (url.pathname === '/' ? '' : url.pathname)
  } catch (err) {
    throw new Error(
      `[rpc] Invalid VITE_API_URL ${JSON.stringify(raw)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    )
  }
}

export const rpc = hc<AppType>(resolveBaseUrl())
