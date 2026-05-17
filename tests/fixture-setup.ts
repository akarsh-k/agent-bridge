/**
 * Fixture harness — phase 1 of 2: build a known-good indexed workspace.
 *
 * What this does (idempotent — re-running wipes and rebuilds):
 *   1. Pre-flight: required env vars + `git` on PATH.
 *   2. Override `DATABASE_URL` + `AGENT_BRIDGE_DATA_DIR` so we touch
 *      ONLY the test DB + a sibling data root — the dev app's state
 *      stays untouched.
 *   3. Connect to the postgres-system DB; CREATE DATABASE if missing.
 *   4. Run `drizzle-kit migrate` against the test DB (subprocess).
 *   5. Wipe + recreate `.agent-bridge-data-test/`.
 *   6. Seed: chat provider, embedding provider, agent.
 *   7. For each fixture repo: insert `repos` row, copy fixture files
 *      into `<source>/`, `git init` + commit, flip status to
 *      `'indexing'`, call the worker's `handleIndexRepoJob` directly
 *      (no BullMQ).
 *   8. Insert `agent_repos` and `repo_relationships`.
 *   9. Print a compact status line per step.
 *
 * Required env (configure in the repo-root `.env`; see `.env.example`):
 *   SMOKE_EMBEDDING_URL    e.g. http://127.0.0.1:8081/v1
 *   SMOKE_EMBEDDING_MODEL  e.g. <model-id>
 * Optional:
 *   SMOKE_EMBEDDING_API_KEY  bearer token if the endpoint requires auth
 *
 * Embedding dimensions are auto-probed from the endpoint at preflight.
 *
 * Run from repo root:
 *   pnpm test:fixture:setup
 */

/* eslint-disable no-console */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { Client } from 'pg'

import { ASK_AGENT_DEFAULTS } from '@agent-bridge/shared'
import { loadRootDotenv } from '@agent-bridge/shared/env'

// Load the repo-root .env so SMOKE_* vars resolve in preflight. tsx
// doesn't auto-load it from the tests workspace cwd.
loadRootDotenv(import.meta.url, { depth: 1 })

import {
  FIXTURE_AGENT,
  FIXTURE_BLANK_AGENT,
  FIXTURE_BLANK_SKILL,
  FIXTURE_CHAT_PROVIDER,
  FIXTURE_RELATIONSHIPS,
  FIXTURE_EMBEDDING_PROVIDER,
  FIXTURE_REPOS,
  FIXTURE_REPOS_DIR,
  REPO_ROOT,
  TEST_DATA_DIR,
  TEST_DB_NAME,
  type FixtureRepo,
} from './fixture-config.js'
import { probeEmbeddingDims } from './probe-embedding-dims.js'

// ─── Pre-flight (BEFORE any DB / worker import) ─────────────────────────────

interface SmokeConfig {
  readonly embeddingUrl: string
  readonly embeddingModel: string
  readonly embeddingDims: number
  /** Optional: only required if you intend to run smoke-blank-agent-skill,
   *  which actually invokes the chat LLM. The wrapper smoke + bridge-
   *  registry smoke don't make any chat call so they don't need it. */
  readonly chatUrl: string | null
  readonly chatModel: string | null
}

async function preflight(): Promise<SmokeConfig> {
  const embeddingUrl = process.env['SMOKE_EMBEDDING_URL']
  const embeddingModel = process.env['SMOKE_EMBEDDING_MODEL']
  const missing: string[] = []
  if (!embeddingUrl) missing.push('SMOKE_EMBEDDING_URL')
  if (!embeddingModel) missing.push('SMOKE_EMBEDDING_MODEL')
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `These point the fixture's embedding provider at your local embedder.`,
    )
  }
  // Probe the endpoint to discover output dimensionality. The probe is the
  // single source of truth — overriding it risks silent vector-size mismatch
  // between what we tell the schema and what the embedder actually returns.
  const embeddingDims = await probeEmbeddingDims({
    url: embeddingUrl!,
    model: embeddingModel!,
    apiKey: process.env['SMOKE_EMBEDDING_API_KEY'] ?? null,
  })
  const gitCheck = spawnSync('git', ['--version'], { stdio: 'ignore' })
  if (gitCheck.status !== 0) {
    throw new Error('git not found on PATH')
  }
  // Chat is optional at setup time — only the skill-smoke makes a real
  // chat call. When set, we plumb the URL + model into the seeded chat
  // provider so the agent can actually answer.
  const chatUrl = process.env['SMOKE_CHAT_URL']?.trim() || null
  const chatModel = process.env['SMOKE_CHAT_MODEL']?.trim() || null

  return {
    embeddingUrl: embeddingUrl!,
    embeddingModel: embeddingModel!,
    embeddingDims,
    chatUrl,
    chatModel,
  }
}

const config = await preflight()

// ─── Env override (BEFORE any worker module import) ─────────────────────────
//
// `dotenv` does not override existing process.env values, so anything we
// set here wins over `.env`. Worker modules read these on first import.

const baseDbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
const testDbUrl = swapDatabaseName(baseDbUrl, TEST_DB_NAME)
process.env['DATABASE_URL'] = testDbUrl
process.env['AGENT_BRIDGE_DATA_DIR'] = TEST_DATA_DIR
process.env['GITNEXUS_EMBEDDING_URL'] = config.embeddingUrl
process.env['GITNEXUS_EMBEDDING_MODEL'] = config.embeddingModel
process.env['GITNEXUS_EMBEDDING_DIMS'] = String(config.embeddingDims)

function swapDatabaseName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

// ─── Static imports of side-effect-free modules ────────────────────────────

const { createDb } = await import('@agent-bridge/db')
const schema = await import('@agent-bridge/db/schema')
const pathsModule = await import('@agent-bridge/shared/paths')

// Worker modules — these load `apps/worker/src/env.ts` which calls
// `loadRootDotenv()`. Our overrides above stay because dotenv is non-
// overriding by default.
const indexJobModule = await import('../apps/worker/src/jobs/index-repo.js')
const workerEventBusModule = await import('../apps/worker/src/event-bus.js')

type AgentBridgeDb = ReturnType<typeof createDb>

// ─── Steps ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('═'.repeat(60))
  log(' Fixture setup')
  log('═'.repeat(60))
  log(`test DB:    ${maskPassword(testDbUrl)}`)
  log(`data root:  ${TEST_DATA_DIR}`)
  log(`embedder:   ${config.embeddingUrl} (${config.embeddingModel}, ${config.embeddingDims}d)`)
  log('')

  await ensureTestDatabaseExists()
  await applyMigrations()
  await wipeAndRecreateDataRoot()

  const db = createDb({ connectionString: testDbUrl })

  try {
    await wipeFixtureRows(db)
    const { chatProviderId, embeddingProviderId } = await seedProviders(db)
    void embeddingProviderId
    const agentId = await seedAgent(db, chatProviderId)
    const repoIds = await seedAndIndexRepos(db)
    await seedAgentRepos(db, agentId, repoIds)
    await seedRepoRelationships(db, agentId, repoIds)
    // Blank-agent fixture for the bridge-registry smoke. No repos
    // attached, inspector_enabled=false. Verifies the bridge exposes
    // only `<slug>__ask_agent` for these.
    await seedBlankAgent(db, chatProviderId)

    log('')
    log('═'.repeat(60))
    log(' Done. Ready for `pnpm test:fixture` (smoke runner).')
    log('═'.repeat(60))
  } finally {
    await db.close()
    await workerEventBusModule.closeEventBus().catch(() => undefined)
  }
}

async function ensureTestDatabaseExists(): Promise<void> {
  log('▸ ensuring test database exists…')
  const adminUrl = swapDatabaseName(baseDbUrl, 'postgres')
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      TEST_DB_NAME,
    ])
    if (exists.rowCount === 0) {
      // CREATE DATABASE doesn't accept a parameter binding.
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`)
      log(`  created database ${TEST_DB_NAME}`)
    } else {
      log(`  database ${TEST_DB_NAME} already exists`)
    }
  } finally {
    await admin.end()
  }
}

async function applyMigrations(): Promise<void> {
  log('▸ applying drizzle migrations to test DB…')
  const result = spawnSync(
    'pnpm',
    ['--filter', '@agent-bridge/db', 'run', 'db:migrate'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'inherit',
    },
  )
  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate failed (exit ${result.status})`)
  }
}

async function wipeAndRecreateDataRoot(): Promise<void> {
  log('▸ wiping test data root…')
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
  pathsModule.ensureDataDirs()
}

async function wipeFixtureRows(db: AgentBridgeDb): Promise<void> {
  log('▸ clearing prior fixture rows…')
  // Order matters: child rows before parents.
  await db.pool.query(`DELETE FROM repo_relationships`)
  await db.pool.query(`DELETE FROM agent_repos`)
  await db.pool.query(`DELETE FROM run_events`)
  await db.pool.query(`DELETE FROM runs`)
  await db.pool.query(`DELETE FROM worker_events`)
  await db.pool.query(`DELETE FROM worker_jobs`)
  await db.pool.query(`DELETE FROM repos`)
  await db.pool.query(`DELETE FROM agent_config_events`)
  await db.pool.query(`DELETE FROM bridge_tools`)
  await db.pool.query(`DELETE FROM agent_mcp_tools`)
  await db.pool.query(`DELETE FROM tools`)
  await db.pool.query(`DELETE FROM skills`)
  await db.pool.query(`DELETE FROM agents`)
  await db.pool.query(`DELETE FROM mcp_oauth_state`)
  await db.pool.query(`DELETE FROM mcp_connections`)
  await db.pool.query(`DELETE FROM llm_providers`)
}

async function seedProviders(db: AgentBridgeDb): Promise<{
  chatProviderId: string
  embeddingProviderId: string
}> {
  log('▸ seeding LLM providers (chat + embedding)…')
  // Use SMOKE_CHAT_URL/MODEL when set so the agent can actually answer
  // (required for the skill smoke). Falls back to a placeholder pointing
  // at the embedding URL so wrapper + bridge-registry smokes (which
  // never invoke the chat LLM) still build a valid agent row.
  const chatBaseUrl = config.chatUrl ?? config.embeddingUrl
  const chatModel = config.chatModel ?? 'placeholder-chat-model'
  const [chat] = await db.db
    .insert(schema.llmProviders)
    .values({
      kind: FIXTURE_CHAT_PROVIDER.kind,
      role: 'chat',
      label: FIXTURE_CHAT_PROVIDER.label,
      baseUrl: chatBaseUrl,
      defaultModel: chatModel,
      apiKeyEnvelope: null,
    })
    .returning({ id: schema.llmProviders.id })
  const [embedding] = await db.db
    .insert(schema.llmProviders)
    .values({
      kind: FIXTURE_EMBEDDING_PROVIDER.kind,
      role: 'embedding',
      label: FIXTURE_EMBEDDING_PROVIDER.label,
      baseUrl: config.embeddingUrl,
      defaultModel: config.embeddingModel,
      apiKeyEnvelope: null,
      embeddingDims: config.embeddingDims,
    })
    .returning({ id: schema.llmProviders.id })
  if (!chat || !embedding) throw new Error('provider insert returned no rows')
  return { chatProviderId: chat.id, embeddingProviderId: embedding.id }
}

async function seedAgent(db: AgentBridgeDb, chatProviderId: string): Promise<string> {
  log(`▸ seeding agent ${FIXTURE_AGENT.slug}…`)
  const [row] = await db.db
    .insert(schema.agents)
    .values({
      slug: FIXTURE_AGENT.slug,
      name: FIXTURE_AGENT.name,
      description: FIXTURE_AGENT.description,
      systemPrompt: 'You are the ecommerce-fixture inspector test agent.',
      llmProviderId: chatProviderId,
      memoryEnabled: false,
      // Default; spelled out for the contrast with seedBlankAgent.
      inspectorEnabled: true,
    })
    .returning({ id: schema.agents.id })
  if (!row) throw new Error('agent insert returned no row')
  return row.id
}

async function seedBlankAgent(
  db: AgentBridgeDb,
  chatProviderId: string,
): Promise<string> {
  log(`▸ seeding blank agent ${FIXTURE_BLANK_AGENT.slug}…`)
  const [row] = await db.db
    .insert(schema.agents)
    .values({
      slug: FIXTURE_BLANK_AGENT.slug,
      name: FIXTURE_BLANK_AGENT.name,
      description: FIXTURE_BLANK_AGENT.description,
      systemPrompt: 'You are a blank-fixture agent. Reply briefly to anything you receive.',
      llmProviderId: chatProviderId,
      memoryEnabled: false,
      inspectorEnabled: false,
    })
    .returning({ id: schema.agents.id })
  if (!row) throw new Error('blank agent insert returned no row')

  // Mirror the backend's auto-create-on-blank behavior so the
  // bridge-registry smoke sees the same row an operator-created agent
  // would have. Slug is alphanumeric+dashes — replace dashes with
  // underscores to satisfy bridge_tools.name CHECK regex.
  const safeSlug = FIXTURE_BLANK_AGENT.slug.replace(/-/g, '_')
  const toolName = `${safeSlug}__${ASK_AGENT_DEFAULTS.nameSuffix}`
  await db.db.insert(schema.bridgeTools).values({
    agentId: row.id,
    name: toolName,
    description: ASK_AGENT_DEFAULTS.description,
    inputSchema: ASK_AGENT_DEFAULTS.inputSchema,
    promptTemplate: ASK_AGENT_DEFAULTS.promptTemplate,
    enabled: true,
  })

  // Seed the directive skill so smoke-blank-agent-skill can verify
  // skills actually reach the LLM via composeInstructions. The skill
  // body tells the model to emit FIXTURE_BLANK_SKILL_TOKEN verbatim.
  await db.db.insert(schema.skills).values({
    agentId: row.id,
    name: FIXTURE_BLANK_SKILL.name,
    markdownBody: FIXTURE_BLANK_SKILL.body,
    position: 0,
  })

  return row.id
}

async function seedAndIndexRepos(db: AgentBridgeDb): Promise<Map<string, string>> {
  log('▸ seeding + indexing fixture repos…')
  const ids = new Map<string, string>()
  for (const fixture of FIXTURE_REPOS) {
    const id = await seedAndIndexOneRepo(db, fixture)
    ids.set(fixture.slug, id)
  }
  return ids
}

async function seedAndIndexOneRepo(db: AgentBridgeDb, fixture: FixtureRepo): Promise<string> {
  // 1. Insert the repo row first — we need the id to compute the source dir.
  const [row] = await db.db
    .insert(schema.repos)
    .values({
      remoteUrl: fixture.remoteUrl,
      branch: 'main',
      status: 'pending',
      wikiStatus: 'none',
    })
    .returning({ id: schema.repos.id })
  if (!row) throw new Error(`repo insert returned no row for ${fixture.slug}`)
  const repoId = row.id

  // 2. Compute the canonical paths the worker will look in.
  const descriptor = { id: repoId, remoteUrl: fixture.remoteUrl, branch: 'main' }
  const sourceDir = pathsModule.repoSourceDir(descriptor)

  // 3. Copy the fixture tree into <source>/.
  const srcFixture = path.join(FIXTURE_REPOS_DIR, fixture.slug)
  if (!existsSync(srcFixture)) throw new Error(`missing fixture tree at ${srcFixture}`)
  await fs.mkdir(path.dirname(sourceDir), { recursive: true })
  await fs.cp(srcFixture, sourceDir, { recursive: true })

  // 4. `git init` + initial commit so gitnexus has a commit graph to walk.
  initGitRepo(sourceDir)

  // 5. Flip the row to 'indexing' + record `localPath` so the index worker is happy.
  await db.db
    .update(schema.repos)
    .set({ status: 'indexing', localPath: sourceDir })
    .where(eq(schema.repos.id, repoId))

  // 6. Run the index handler synchronously (no BullMQ).
  log(`  indexing ${fixture.slug} (${sourceDir})…`)
  const fakeJob = makeFakeJob({ repoId, mode: 'initial', force: true })
  await indexJobModule.handleIndexRepoJob(fakeJob)
  log(`  ✓ ${fixture.slug} indexed`)
  return repoId
}

function initGitRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@local',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@local',
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
  execFileSync('git', ['add', '-A'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'fixture init'], { cwd: dir, env })
}

async function seedAgentRepos(
  db: AgentBridgeDb,
  agentId: string,
  repoIds: Map<string, string>,
): Promise<void> {
  log('▸ attaching repos to agent…')
  for (const [i, fixture] of FIXTURE_REPOS.entries()) {
    const repoId = repoIds.get(fixture.slug)
    if (!repoId) throw new Error(`missing repoId for ${fixture.slug}`)
    await db.db.insert(schema.agentRepos).values({
      agentId,
      repoId,
      role: fixture.role,
      description: fixture.description,
      aliases: [fixture.label],
      positionX: i * 320,
      positionY: 0,
    })
  }
}

async function seedRepoRelationships(
  db: AgentBridgeDb,
  agentId: string,
  repoIds: Map<string, string>,
): Promise<void> {
  log('▸ writing repo_relationships…')
  for (const edge of FIXTURE_RELATIONSHIPS) {
    const fromId = repoIds.get(edge.fromSlug)
    const toId = repoIds.get(edge.toSlug)
    if (!fromId || !toId) throw new Error(`relationship ${edge.fromSlug}→${edge.toSlug} missing repo id`)
    await db.db.insert(schema.repoRelationships).values({
      agentId,
      fromRepoId: fromId,
      toRepoId: toId,
      connector: edge.connector,
      description: edge.description,
    })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeJob(data: {
  repoId: string
  mode: 'initial' | 'reindex'
  force: boolean
}): never {
  // The handler only reads `.data`; everything else is unused. Casting to
  // `never` lets the BullMQ Job parameter resolve without us having to
  // pull in BullMQ types here.
  return { data, id: `fixture-${data.repoId}` } as never
}

function maskPassword(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}

function log(line: string): void {
  console.log(line)
}

main().catch((err) => {
  console.error('[fixture-setup] fatal:', err)
  process.exit(1)
})
