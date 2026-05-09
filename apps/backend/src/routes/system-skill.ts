/**
 * `GET /api/system/skill/coding-agent`
 *   → return the auto-attached inspector toolkit prompt body, version,
 *     and heading marker so the operator can read what gets appended
 *     to every agent's instructions.
 *
 * Read-only. Does not vary by agent. the body is a build-time
 * artifact (`packages/agents/src/inspector/system-prompt.md`) and
 * is identical across every agent in the install. The version string
 * (`INSPECTOR_SYSTEM_PROMPT_VERSION`) drives BuiltAgent cache
 * invalidation; bumping it forces every cached agent to rebuild on
 * next access.
 *
 * URL kept as `/coding-agent` for frontend backwards compatibility —
 * the v1 coding-agent toolkit was replaced by the wrapper-tool
 * architecture (`docs/ARCHITECTURE.md §10` Phase B6/F1) but the route name
 * still describes what the panel shows: "the auto-attached chunk".
 *
 * On read failure (e.g. dev mode where the .md hasn't been copied
 * into `dist/` yet) the route returns `{ ok: false, message }`
 * instead of throwing. UI renders a graceful "couldn't load"
 * notice.
 *
 * `GET /api/system/skill/gitnexus-library` → returns an empty list.
 *   The wrapper-tool architecture no longer auto-attaches the
 *   gitnexus library skills (the LLM doesn't see `gitnexus_*` tools
 *   directly anymore — wrappers wrap them). Endpoint kept so the
 *   frontend's library-skills card renders as "no skills attached"
 *   instead of erroring. Phase H+1 can drop the endpoint and the
 *   card together.
 */

import { Hono } from 'hono'
import {
  INSPECTOR_SYSTEM_PROMPT_HEADING,
  INSPECTOR_SYSTEM_PROMPT_VERSION,
  loadInspectorSystemPrompt,
} from '@agent-bridge/agents'

export const systemSkillRouter = new Hono()
  .get('/coding-agent', async (c) => {
    try {
      const body = await loadInspectorSystemPrompt()
      return c.json({
        ok: true as const,
        version: INSPECTOR_SYSTEM_PROMPT_VERSION,
        heading: INSPECTOR_SYSTEM_PROMPT_HEADING,
        body,
      })
    } catch (err) {
      return c.json({
        ok: false as const,
        message:
          err instanceof Error
            ? err.message
            : 'Failed to load inspector system prompt',
      })
    }
  })
  .get('/gitnexus-library', (c) => {
    // Wrapper-tool architecture removed the auto-attached library skills.
    // Empty list keeps the existing frontend card from breaking.
    return c.json({
      ok: true as const,
      version: 'n/a',
      skills: [] as Array<{
        slug: string
        name: string
        description: string
        body: string
        bytes: number
      }>,
    })
  })

export type SystemSkillRouter = typeof systemSkillRouter
