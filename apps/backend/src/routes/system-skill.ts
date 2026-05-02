/**
 * `GET /api/system/skill/coding-agent`
 *   → return the auto-attached coding-agent system-skill body, version,
 *     and heading marker so the operator can read what gets appended
 *     to every agent's instructions.
 *
 * Read-only. Does not vary by agent. the skill body is a build-time
 * artifact (`packages/agents/src/coding-agent/system-skill.md`) and
 * is identical across every agent in the install. The version string
 * (`CODING_AGENT_SYSTEM_SKILL_VERSION`) drives BuiltAgent cache
 * invalidation; bumping it forces every cached agent to rebuild on
 * next access.
 *
 * On read failure (e.g. dev mode where the .md hasn't been copied
 * into `dist/` yet) the route returns `{ ok: false, message }`
 * instead of throwing. same shape as the gitnexus tools route, so
 * the UI renders a graceful "couldn't load system skill" notice
 * instead of blowing up the resources panel.
 */

import { Hono } from 'hono'
import {
  CODING_AGENT_SYSTEM_SKILL_HEADING,
  CODING_AGENT_SYSTEM_SKILL_VERSION,
  loadCodingAgentSystemSkill,
  loadGitnexusLibrarySkills,
} from '@agent-bridge/agents'

export const systemSkillRouter = new Hono()
  .get('/coding-agent', async (c) => {
    try {
      const body = await loadCodingAgentSystemSkill()
      return c.json({
        ok: true as const,
        version: CODING_AGENT_SYSTEM_SKILL_VERSION,
        heading: CODING_AGENT_SYSTEM_SKILL_HEADING,
        body,
      })
    } catch (err) {
      return c.json({
        ok: false as const,
        message:
          err instanceof Error
            ? err.message
            : 'Failed to load coding-agent system skill',
      })
    }
  })
  .get('/gitnexus-library', async (c) => {
    try {
      const lib = await loadGitnexusLibrarySkills()
      return c.json({
        ok: true as const,
        version: lib.version,
        skills: lib.skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          body: s.body,
          bytes: s.bytes,
        })),
      })
    } catch (err) {
      return c.json({
        ok: false as const,
        message:
          err instanceof Error
            ? err.message
            : 'Failed to load gitnexus library skills',
      })
    }
  })

export type SystemSkillRouter = typeof systemSkillRouter
