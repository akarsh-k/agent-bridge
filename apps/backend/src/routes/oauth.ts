/**
 * Top-level OAuth callback routes — not under `/api`.
 *
 * Lives outside the `/api` mount because upstream authorization
 * servers (Notion, Atlassian, …) redirect a USER BROWSER here after
 * consent. That redirect URL is baked into the dynamic client
 * registration at first-probe time and must match byte-for-byte on
 * every subsequent round-trip, so it has to be a stable, short path
 * that doesn't carry an `/api` version qualifier.
 *
 * The handler:
 *   1. Pulls the active test session for the `:connectionId` path.
 *   2. Validates the `state` query param matches what the provider
 *      generated (CSRF guard).
 *   3. Hands the `code` to `completeOauthCallback`, which exchanges
 *      it for tokens via Mastra's `auth()` and then lists tools.
 *   4. Returns a minimal self-closing HTML response — the Test
 *      drawer on the frontend is polling `/api/.../test/poll` and
 *      will notice the session state flip on its own.
 */

import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { schema } from '@agent-bridge/db'
import { getDb } from '../db.js'
import { env } from '../env.js'
import { httpError, httpValidationError } from '../lib/errors.js'
import { completeOauthCallback } from '../lib/mcp-connections/discover.js'
import { getTestSessionRegistry } from '../lib/mcp-connections/test-sessions.js'

const callbackParamSchema = z.object({ connectionId: z.uuid() })

/**
 * Upstream may send back either `code` + `state` (success) or
 * `error` (denial / invalid request). We accept both — the error
 * arm surfaces on the polling frontend as a `failed` test session.
 */
const callbackQuerySchema = z
  .object({
    code: z.string().min(1).max(8_192).optional(),
    state: z.string().min(1).max(1_024).optional(),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().min(1).max(1_024).optional(),
  })
  .refine((v) => Boolean(v.code || v.error), {
    message: 'callback requires either `code` or `error`',
  })

export const oauthRouter = new Hono()
  // ─── GET /oauth/mcp/:connectionId/callback ─────────────────────────────
  .get(
    '/mcp/:connectionId/callback',
    zValidator('param', callbackParamSchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    zValidator('query', callbackQuerySchema, (result, c) => {
      if (!result.success) return httpValidationError(c, result.error)
      return
    }),
    async (c) => {
      const { connectionId } = c.req.valid('param')
      const query = c.req.valid('query')
      const registry = getTestSessionRegistry()

      const session = registry.getByConnection(connectionId)
      if (!session) {
        return renderCallbackPage(c, {
          title: 'Authorization expired',
          body:
            'The test session for this connection already ended. ' +
            'Return to Agent Bridge and click Test again to retry.',
          ok: false,
        })
      }

      if (query.error) {
        const message = query.error_description
          ? `${query.error}: ${query.error_description}`
          : query.error
        registry.finalize(session.sessionId, {
          status: 'failed',
          code: 'auth',
          message,
        })
        return renderCallbackPage(c, {
          title: 'Authorization denied',
          body: `The upstream authorization server returned an error: ${message}`,
          ok: false,
        })
      }

      if (!query.state || !registry.matchOauthState(session.sessionId, query.state)) {
        // CSRF guard. A mismatched `state` means the callback does
        // not belong to this session — do NOT exchange the code.
        registry.finalize(session.sessionId, {
          status: 'failed',
          code: 'auth',
          message: 'OAuth state mismatch — callback rejected as likely CSRF',
        })
        return renderCallbackPage(c, {
          title: 'Authorization mismatch',
          body:
            'The callback parameters did not match an active test ' +
            'session. Close this tab and try again from Agent ' +
            'Bridge.',
          ok: false,
        })
      }

      if (!query.code) {
        // `refine` should have caught this, but belt-and-braces.
        return httpError(c, {
          code: 'validation_failed',
          message: 'callback missing authorization code',
        })
      }

      // Load the stored connection. We can't reuse the session's
      // connectionId alone because the stored row has the MCP URL
      // and auth kind we need.
      const { db } = getDb()
      const [row] = await db
        .select()
        .from(schema.mcpConnections)
        .where(eq(schema.mcpConnections.id, connectionId))
        .limit(1)

      if (!row) {
        registry.finalize(session.sessionId, {
          status: 'failed',
          code: 'unknown',
          message: `mcp connection ${connectionId} disappeared mid-flow`,
        })
        return renderCallbackPage(c, {
          title: 'Connection removed',
          body:
            'The MCP connection was deleted while you were approving. ' +
            'You can close this tab.',
          ok: false,
        })
      }

      await completeOauthCallback({
        stored: {
          id: row.id,
          transport: row.transport,
          commandOrUrl: row.commandOrUrl,
          argsJson: row.argsJson,
          envEnvelope: row.envEnvelope,
          headersEnvelope: row.headersEnvelope,
          authKind: row.authKind,
          allowHostHome: row.allowHostHome,
        },
        ctx: {
          db,
          redirectUrl: `http://localhost:${env.PORT}/oauth/mcp/${connectionId}/callback`,
        },
        sessionId: session.sessionId,
        authorizationCode: query.code,
      })

      return renderCallbackPage(c, {
        title: 'Authorization complete',
        body:
          'You can close this tab. Agent Bridge is now fetching the ' +
          'tool list.',
        ok: true,
      })
    },
  )

/**
 * Minimal self-contained HTML response. We deliberately avoid
 * rendering anything that depends on the frontend bundle — this page
 * opens in whatever browser the user approved in, which may be a
 * different origin from the Vite dev server. Keep styling inline and
 * the body terse.
 */
function renderCallbackPage(
  c: Context,
  args: { readonly title: string; readonly body: string; readonly ok: boolean },
): Response {
  const accent = args.ok ? '#0f766e' : '#be123c'
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(args.title)} · Agent Bridge</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI,
          Roboto, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        display: grid;
        place-items: center;
        padding: 2rem;
      }
      .card {
        max-width: 32rem;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 2rem 2.25rem;
        box-shadow: 0 1px 3px rgb(15 23 42 / 0.08);
      }
      .accent {
        display: inline-block;
        width: 0.5rem;
        height: 2rem;
        background: ${accent};
        border-radius: 3px;
        vertical-align: middle;
        margin-right: 0.75rem;
      }
      h1 {
        display: inline-block;
        vertical-align: middle;
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
      }
      p {
        margin: 1rem 0 0;
        line-height: 1.6;
        color: #475569;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="accent" aria-hidden="true"></span>
      <h1>${escapeHtml(args.title)}</h1>
      <p>${escapeHtml(args.body)}</p>
    </div>
  </body>
</html>
`
  return c.html(html)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
