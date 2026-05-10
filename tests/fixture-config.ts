/**
 * Shared constants for the fixture harness.
 *
 * Both the setup script and the smoke runner read from here so the
 * agent slug, repo labels, and edge config stay in lockstep.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Repo root (one level above `tests/`). */
export const REPO_ROOT = path.resolve(HERE, '..')

/** Where the harness puts the indexed workspace. Distinct from
 *  `.agent-bridge-data/` so the dev app's state stays untouched. */
export const TEST_DATA_DIR = path.join(REPO_ROOT, '.agent-bridge-data-test')

/** Test DB name — separate from the dev DB by convention. */
export const TEST_DB_NAME = 'agentbridge_test'

/** Where the source-of-truth fixture trees live. The setup script
 *  copies from these into the test data root before running git+index. */
export const FIXTURE_REPOS_DIR = path.join(HERE, 'fixtures', 'repos')

export interface FixtureRepo {
  /** Folder name under `fixtures/repos/` AND the URL-tail name gitnexus stores. */
  readonly slug: string
  /** Pretty label shown in logs. */
  readonly label: string
  /** Synthetic remote URL — the setup script does NOT git-clone, but the
   *  `repos` row schema requires `remote_url + branch` and the dedup
   *  uniqueness key is built from them. `fixture://` makes intent obvious. */
  readonly remoteUrl: string
  /** What the agent's `agent_repos.role` reads — short label. */
  readonly role: string
  /** Operator-facing description on the attachment row. */
  readonly description: string
}

export const FIXTURE_REPOS: readonly FixtureRepo[] = [
  {
    slug: 'ecommerce-shared',
    label: 'shared',
    remoteUrl: 'fixture://ecommerce-shared',
    role: 'shared-types',
    description: 'TypeScript types + utilities consumed by the frontend.',
  },
  {
    slug: 'ecommerce-frontend',
    label: 'frontend',
    remoteUrl: 'fixture://ecommerce-frontend',
    role: 'frontend',
    description: 'React + Vite storefront. Calls GET /products on the backend.',
  },
  {
    slug: 'ecommerce-backend',
    label: 'backend',
    remoteUrl: 'fixture://ecommerce-backend',
    role: 'backend',
    description: 'FastAPI service. Parallel Pydantic Product mirrors the TS interface.',
  },
] as const

export interface FixtureEdge {
  readonly fromSlug: string
  readonly toSlug: string
  readonly connector: string
  readonly description: string
}

export const FIXTURE_EDGES: readonly FixtureEdge[] = [
  {
    fromSlug: 'ecommerce-frontend',
    toSlug: 'ecommerce-backend',
    connector: 'calls',
    description: 'Frontend hits GET /products on the backend.',
  },
  {
    fromSlug: 'ecommerce-shared',
    toSlug: 'ecommerce-backend',
    connector: 'type-mirror',
    description:
      'shared.Product (TS) ↔ app.models.product.Product (Pydantic). Update both together.',
  },
] as const

/** Coding-helper agent fixture identity. Has all three repos attached
 *  and inspector_enabled=true. */
export const FIXTURE_AGENT = {
  slug: 'fixture-ecommerce',
  name: 'Ecommerce demo agent',
  description: 'Three-repo ecommerce fixture used for the inspector smoke.',
} as const

/** Build-your-own (blank) agent fixture identity. No repos attached,
 *  inspector_enabled=false. Used by the bridge smoke to verify
 *  ask_agent-only registration on Inspector-disabled agents. */
export const FIXTURE_BLANK_AGENT = {
  slug: 'fixture-blank',
  name: 'Blank fixture agent',
  description:
    'Build-your-own fixture agent with the Inspector toolkit disabled.',
} as const

/** LLM provider fixture identity. Two rows: one chat, one embedding. */
export const FIXTURE_CHAT_PROVIDER = {
  label: 'fixture-chat',
  kind: 'openai_compatible',
} as const

export const FIXTURE_EMBEDDING_PROVIDER = {
  label: 'fixture-embedding',
  kind: 'openai_compatible',
} as const
