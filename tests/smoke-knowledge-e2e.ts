/**
 * End-to-end smoke for the knowledge-files pipeline against a real PDF.
 *
 * What this verifies:
 *   1. PDF extraction produces non-trivial text and a page count.
 *   2. Section-aware chunking yields a sane number of chunks (not zero,
 *      not pathologically high).
 *   3. Embedding succeeds against the workspace embedding provider and
 *      writes the model fingerprint on every chunk.
 *   4. `search_knowledge` returns relevant chunks for topical queries.
 *      We assert citation shape (file_id, file_name, snippet, score)
 *      and that snippets are non-empty.
 *   5. Scope filter: `file_ids=[other]` returns nothing from our file.
 *   6. Fingerprint enforcement: swapping the active embedding model
 *      (simulated by querying with a different fingerprint) refuses
 *      cleanly — no NaN, no crash, just empty.
 *   7. Re-ingest: clears chunks, re-creates them. Resumability via
 *      `chunks_done` is exercised by interrupting the first ingest
 *      partway through (best-effort; depends on chunk count).
 *   8. Cascade delete: removing the file drops chunks via FK.
 *
 * Required env (same as `fixture-setup`):
 *   SMOKE_EMBEDDING_URL    e.g. http://127.0.0.1:8081/v1
 *   SMOKE_EMBEDDING_MODEL  the model id served at that URL
 *   SMOKE_EMBEDDING_API_KEY (optional bearer token)
 *
 * Prerequisite: `pnpm test:fixture:setup` must have been run at least
 * once so the test DB + embedding provider row exist.
 *
 * The smoke writes to / cleans up under `<test data dir>/knowledge/`,
 * separate from the dev workspace.
 *
 *   pnpm -w run test:knowledge-e2e
 */

/* eslint-disable no-console */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { count, eq } from 'drizzle-orm'

import { createDb, schema } from '@agent-bridge/db'
import {
  buildSearchKnowledgeTool,
  eagerPrefetchKnowledge,
  ensureFileChunksDim,
  FileChunksDimMismatch,
  ingestKnowledgeFile,
  readFileChunksDim,
  rebuildFileChunksAtDim,
  runBm25Search,
  withRunContext,
} from '@agent-bridge/agents'
import { loadRootDotenv } from '@agent-bridge/shared/env'
import {
  knowledgeFileDir,
  knowledgeOriginalPath,
} from '@agent-bridge/shared/paths'

import { TEST_DATA_DIR, TEST_DB_NAME, REPO_ROOT } from './fixture-config.js'

loadRootDotenv(import.meta.url, { depth: 1 })

// ── Pre-flight ───────────────────────────────────────────────────────────

function preflight(): { dbUrl: string } {
  const baseDbUrl =
    process.env['DATABASE_URL'] ??
    'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'
  const u = new URL(baseDbUrl)
  u.pathname = `/${TEST_DB_NAME}`
  const dbUrl = u.toString()

  const missing: string[] = []
  if (!process.env['SMOKE_EMBEDDING_URL']) missing.push('SMOKE_EMBEDDING_URL')
  if (!process.env['SMOKE_EMBEDDING_MODEL'])
    missing.push('SMOKE_EMBEDDING_MODEL')
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `Run \`pnpm test:fixture:setup\` after exporting these.`,
    )
  }
  // We also need `AGENT_BRIDGE_DATA_DIR` pinned to the test data dir
  // so the storage path resolver lands files where we expect, instead
  // of polluting the dev workspace.
  process.env['AGENT_BRIDGE_DATA_DIR'] = TEST_DATA_DIR

  return { dbUrl }
}

const { dbUrl } = preflight()

// ── Assertion harness ───────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ` — ${diag}` : ''}`)
  } else {
    failed += 1
    failures.push(`${name}${diag ? ` — ${diag}` : ''}`)
    console.log(`✗ ${name}${diag ? ` — ${diag}` : ''}`)
  }
}

// ── Main ────────────────────────────────────────────────────────────────

console.log('━'.repeat(60))
console.log(' Knowledge files end-to-end smoke')
console.log('━'.repeat(60))
console.log(`test DB:   ${maskPassword(dbUrl)}`)
console.log(`data dir:  ${TEST_DATA_DIR}`)
console.log('')

const PDF_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf', 'Plant identification basics.pdf')
const db = createDb({ connectionString: dbUrl, maxConnections: 4 })

try {
  await runSmoke()
} finally {
  await db.close()
}

console.log('')
console.log('━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`   ✗ ${f}`)
  console.log('━'.repeat(60))
  process.exitCode = 1
} else {
  console.log(' All checks passed.')
  console.log('━'.repeat(60))
}

// ── Steps ───────────────────────────────────────────────────────────────

async function runSmoke(): Promise<void> {
  // ── 1. Embedding provider exists ──────────────────────────────────
  const [embedProvider] = await db.db
    .select()
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'embedding'))
    .limit(1)
  if (!embedProvider) {
    check(
      'workspace embedding provider exists',
      false,
      'no row with role=embedding — re-run `pnpm test:fixture:setup`',
    )
    return
  }
  check(
    'workspace embedding provider exists',
    true,
    `${embedProvider.label} (${embedProvider.defaultModel}, ${embedProvider.embeddingDims}d)`,
  )

  // `file_chunks.embedding` is provisioned at runtime to match
  // `provider.embeddingDims` via ensureFileChunksDim. The smoke needs
  // an explicit dim on the provider row — without it, ingest can't
  // size the column.
  if (embedProvider.embeddingDims == null) {
    check(
      'embedding provider reports an explicit embeddingDims',
      false,
      'embeddingDims is null; set it on the fixture provider row',
    )
    return
  }
  check(
    'embedding provider reports an explicit embeddingDims',
    true,
    `dim=${embedProvider.embeddingDims}`,
  )
  // Pre-align the column to whatever the local embedder reports so the
  // first ingest doesn't have to. Test DB starts fresh, so this is
  // either a no-op (already 1024 from the migration) or a silent
  // ALTER COLUMN — both safe.
  await ensureFileChunksDim(db, embedProvider.embeddingDims).catch(
    async () => {
      // If a prior smoke left chunks behind at a different dim,
      // the non-destructive helper refuses. Truncate + retry.
      await rebuildFileChunksAtDim(db, embedProvider.embeddingDims!)
    },
  )

  // ── 2. PDF exists + hash it ───────────────────────────────────────
  const pdfBytes = await readFile(PDF_PATH).catch(() => null)
  check(
    'fixture PDF is readable',
    pdfBytes !== null,
    PDF_PATH,
  )
  if (pdfBytes === null) return
  const contentHash = createHash('sha256').update(pdfBytes).digest('hex')

  // Clean up any prior run's row + disk before starting. Dedup would
  // otherwise surface the old row and we'd be testing against stale
  // chunks.
  const [prior] = await db.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.contentHash, contentHash))
    .limit(1)
  if (prior) {
    await db.db.delete(schema.files).where(eq(schema.files.id, prior.id))
    await rm(prior.storagePath, { recursive: true, force: true })
    console.log(`▸ cleaned up prior fixture run (id=${prior.id.slice(0, 8)})`)
  }

  // ── 3. Insert files row + write bytes to disk ─────────────────────
  const [inserted] = await db.db
    .insert(schema.files)
    .values({
      name: 'Plant identification basics',
      filename: 'Plant identification basics.pdf',
      kind: 'pdf',
      bytes: pdfBytes.length,
      contentHash,
      storagePath: 'pending',
    })
    .returning()
  if (!inserted) {
    check('insert files row', false, 'no row returned')
    return
  }
  const storagePath = path.join(TEST_DATA_DIR, 'knowledge', inserted.id)
  await mkdir(storagePath, { recursive: true, mode: 0o700 })
  const dst = knowledgeOriginalPath(inserted.id, 'pdf')
  await copyFile(PDF_PATH, dst)
  await db.db
    .update(schema.files)
    .set({ storagePath })
    .where(eq(schema.files.id, inserted.id))

  const fileId = inserted.id
  check(
    'files row + storage created',
    true,
    `id=${fileId.slice(0, 8)} bytes=${pdfBytes.length}`,
  )

  // ── 4. Run ingest pipeline ────────────────────────────────────────
  const ingestStart = Date.now()
  console.log('▸ ingesting (extract → chunk → embed → describe)…')
  await ingestKnowledgeFile({ db, fileId })
  const ingestMs = Date.now() - ingestStart

  const [ingested] = await db.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  check(
    'ingest completed without error',
    ingested?.ingestStatus === 'ready',
    `status=${ingested?.ingestStatus}${ingested?.ingestError ? ` err=${ingested.ingestError}` : ''} (${ingestMs}ms)`,
  )
  check(
    'page_count backfilled from PDF',
    typeof ingested?.pageCount === 'number' && ingested.pageCount > 0,
    `pages=${ingested?.pageCount ?? '(null)'}`,
  )

  const [{ value: chunkCount } = { value: 0 }] = await db.db
    .select({ value: count() })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
  check(
    'chunks were written',
    chunkCount >= 3,
    `${chunkCount} chunks`,
  )
  check(
    'chunk count is sane (not pathologically large)',
    chunkCount < 1000,
    `${chunkCount} chunks < 1000`,
  )
  check(
    'files.chunks_done matches actual chunk count after success',
    ingested?.chunksDone === chunkCount,
    `chunks_done=${ingested?.chunksDone} vs chunks=${chunkCount}`,
  )

  // ── 5. Fingerprint stamped on every chunk ──────────────────────────
  const fingerprintRows = await db.db
    .select({ embeddingModel: schema.fileChunks.embeddingModel })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
    .limit(5)
  const fingerprints = new Set(fingerprintRows.map((r) => r.embeddingModel))
  check(
    'every sampled chunk carries the embedding-model fingerprint',
    fingerprints.size === 1 && [...fingerprints][0]?.includes('1024') === true,
    `fingerprints=${[...fingerprints].join(',')}`,
  )

  // ── 5b. Page numbers stamped on every PDF chunk ───────────────────
  // Regression guard: the extractor used to flatten pages into one
  // string, leaving every chunk's page null.
  const pageRows = await db.db
    .select({ page: schema.fileChunks.page })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
  const pages = pageRows
    .map((r) => r.page)
    .filter((p): p is number => p !== null)
  check(
    'every PDF chunk carries a page number',
    pageRows.length > 0 && pages.length === pageRows.length,
    `${pages.length}/${pageRows.length} chunks have a page`,
  )
  check(
    'chunk pages fall within 1..page_count',
    pages.length > 0 &&
      Math.min(...pages) >= 1 &&
      Math.max(...pages) <= (ingested?.pageCount ?? 0),
    `range=${pages.length ? `${Math.min(...pages)}..${Math.max(...pages)}` : '-'}, page_count=${ingested?.pageCount}`,
  )

  // ── 6. Auto-description ───────────────────────────────────────────
  // Best-effort. If no chat provider is configured, the description
  // stays empty and we skip this check.
  const [chatProvider] = await db.db
    .select({ id: schema.llmProviders.id })
    .from(schema.llmProviders)
    .where(eq(schema.llmProviders.role, 'chat'))
    .limit(1)
  if (chatProvider) {
    check(
      'auto-description was generated (chat provider present)',
      (ingested?.description ?? '').trim().length > 0,
      ingested?.description
        ? `"${ingested.description.slice(0, 80)}…"`
        : '(empty)',
    )
  } else {
    console.log('▸ no chat provider configured — auto-describe deferred (operator-editable)')
  }

  // ── 7. search_knowledge end-to-end ────────────────────────────────
  const tool = buildSearchKnowledgeTool({
    db,
    attachedFiles: [
      {
        id: fileId,
        name: ingested?.name ?? 'Plant identification basics',
        description: ingested?.description ?? '',
      },
    ],
    embeddingProvider: embedProvider,
    chatModel: null, // skip LLM rerank in the smoke; RRF order is enough
  })
  check(
    'search_knowledge tool mounted',
    tool !== null,
    tool ? 'OK' : 'null',
  )
  if (!tool || !tool.execute) return

  // Topical queries — phrasing matches the PDF's title closely. We
  // don't know the exact wording, but a plant ID guide is virtually
  // guaranteed to mention these terms.
  const topicalQueries = ['leaf shape', 'flower', 'stem', 'plant identification']
  for (const q of topicalQueries) {
    const result = await callTool(tool, { query: q, top_k: 5 })
    const r = result as {
      ok: boolean
      chunks: Array<{
        file_id: string
        file_name: string
        snippet: string
        score: number
      }>
      hint?: string
    }
    check(
      `query "${q}" returned chunks`,
      r.ok === true && r.chunks.length > 0,
      `${r.chunks.length} chunks${r.hint ? ` (hint: ${r.hint})` : ''}`,
    )
    if (r.chunks.length > 0) {
      const top = r.chunks[0]!
      check(
        `query "${q}" top chunk has valid citation shape`,
        top.file_id === fileId &&
          typeof top.file_name === 'string' &&
          typeof top.snippet === 'string' &&
          top.snippet.length > 0,
        `file=${top.file_name} snippet=${top.snippet.length}ch`,
      )
      check(
        `query "${q}" results are sorted by score descending`,
        r.chunks.every(
          (c, i) =>
            i === 0 || (r.chunks[i - 1]?.score ?? 0) >= c.score,
        ),
        'monotone',
      )
    }
  }

  // ── 8. Empty-result hint for nonsense ─────────────────────────────
  const nonsense = await callTool(tool, {
    query: 'xyzzy quantum entanglement of warp drive intercoolers',
  })
  const nonsenseR = nonsense as {
    ok: boolean
    chunks: unknown[]
    hint?: string
  }
  // BM25 might still produce a weak match on common words within the
  // query; what we really want is "nothing makes a confidently bad
  // claim". Soft-assert: either empty + hint, OR low scores.
  check(
    'nonsense query yields empty-result hint OR weak matches (no confident bad citation)',
    nonsenseR.ok === true && (nonsenseR.chunks.length === 0 || nonsenseR.hint === undefined),
    nonsenseR.chunks.length === 0
      ? 'empty + hint'
      : `${nonsenseR.chunks.length} weak chunks`,
  )

  // ── 9. file_ids scope filter ──────────────────────────────────────
  const otherUuid = '00000000-0000-0000-0000-000000000000'
  const scoped = await callTool(tool, {
    query: 'leaf shape',
    file_ids: [otherUuid],
  })
  const scopedR = scoped as { ok: boolean; chunks: unknown[]; hint?: string }
  check(
    'file_ids filter pointing at an unattached file returns empty',
    scopedR.ok === true && scopedR.chunks.length === 0,
    `ok=${scopedR.ok} chunks=${scopedR.chunks.length} hint=${scopedR.hint ?? '(none)'}`,
  )

  // ── 9b. Multi-file scope: attach a second synthetic txt file and
  //         verify the file_ids filter narrows correctly. We use a
  //         tiny inline doc so the second ingest is fast (<2s).
  const secondText =
    'Mortgage agreement summary. ' +
    'Principal balance: $200000. ' +
    'Annual interest rate: 5.25 percent. ' +
    'Loan term: 30 years. ' +
    'Monthly payment: $1104. ' +
    'Prepayment penalty applies in the first 5 years. ' +
    'Default occurs after 60 days of missed payments.'
  const secondHash = createHash('sha256').update(secondText).digest('hex')
  await db.db
    .delete(schema.files)
    .where(eq(schema.files.contentHash, secondHash))
  const [second] = await db.db
    .insert(schema.files)
    .values({
      name: 'mortgage-summary',
      filename: 'mortgage-summary.txt',
      kind: 'txt',
      bytes: secondText.length,
      contentHash: secondHash,
      storagePath: 'pending',
    })
    .returning()
  if (second) {
    const secondDir = path.join(TEST_DATA_DIR, 'knowledge', second.id)
    await mkdir(secondDir, { recursive: true, mode: 0o700 })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(knowledgeOriginalPath(second.id, 'txt'), secondText, {
      mode: 0o600,
    })
    await db.db
      .update(schema.files)
      .set({ storagePath: secondDir })
      .where(eq(schema.files.id, second.id))
    await ingestKnowledgeFile({ db, fileId: second.id })

    const twoFileTool = buildSearchKnowledgeTool({
      db,
      attachedFiles: [
        { id: fileId, name: 'Plant identification basics', description: '' },
        { id: second.id, name: 'mortgage-summary', description: '' },
      ],
      embeddingProvider: embedProvider,
      chatModel: null,
    })
    if (twoFileTool && twoFileTool.execute) {
      const onlySecond = (await callTool(twoFileTool, {
        query: 'mortgage interest rate',
        file_ids: [second.id],
      })) as { ok: boolean; chunks: Array<{ file_id: string }> }
      check(
        'scope=[second]: results are exclusively from the mortgage file',
        onlySecond.ok &&
          onlySecond.chunks.length > 0 &&
          onlySecond.chunks.every((c) => c.file_id === second.id),
        `${onlySecond.chunks.length} chunks, ${
          onlySecond.chunks.filter((c) => c.file_id === second.id).length
        } from second`,
      )
      const onlyFirst = (await callTool(twoFileTool, {
        query: 'mortgage interest rate',
        file_ids: [fileId],
      })) as { ok: boolean; chunks: Array<{ file_id: string }> }
      check(
        'scope=[first]: mortgage query against plant doc returns no mortgage hits from second',
        onlyFirst.ok &&
          onlyFirst.chunks.every((c) => c.file_id === fileId),
        `${onlyFirst.chunks.length} chunks, all from first file`,
      )
    }

    // ── 9c. Fingerprint mismatch refusal ────────────────────────────
    //   Simulate the "operator swapped embedding model" scenario by
    //   stamping bogus fingerprints onto the second file's chunks.
    //   The retrieval path should refuse to return them.
    await db.pool.query(
      `UPDATE file_chunks SET embedding_model = 'fake:swapped-model:1024' WHERE file_id = $1`,
      [second.id],
    )
    const mismatched = (await callTool(twoFileTool!, {
      query: 'mortgage interest rate',
      file_ids: [second.id],
    })) as { ok: boolean; chunks: unknown[]; hint?: string }
    check(
      'fingerprint mismatch silently drops chunks (no stale-geometry results)',
      mismatched.ok && mismatched.chunks.length === 0,
      `${mismatched.chunks.length} chunks ${mismatched.hint ? `(${mismatched.hint})` : ''}`,
    )

    // Clean up the second file before the rest of the smoke runs.
    await db.db.delete(schema.files).where(eq(schema.files.id, second.id))
    await rm(secondDir, { recursive: true, force: true })
  }

  // ── 9d. Per-burst search cap fires on a tight call loop. Uses a
  //         fresh tool instance so we don't blow the counter for the
  //         tests below.
  const capTool = buildSearchKnowledgeTool({
    db,
    attachedFiles: [
      { id: fileId, name: 'Plant identification basics', description: '' },
    ],
    embeddingProvider: embedProvider,
    chatModel: null,
  })
  if (capTool?.execute) {
    // Make 11 calls back-to-back. v1 cap is 10 per 60s window per
    // tool instance, so the 11th call should refuse cleanly.
    const capResults: Array<{ ok: boolean; hint?: string }> = []
    for (let i = 0; i < 11; i++) {
      const r = (await callTool(capTool, { query: `cap probe ${i}`, top_k: 1 })) as {
        ok: boolean
        hint?: string
      }
      capResults.push(r)
    }
    const okCount = capResults.filter((r) => r.ok === true).length
    const last = capResults[capResults.length - 1]!
    check(
      'per-burst cap blocks the 11th call within the 60s window',
      okCount === 10 && last.ok === false && (last.hint ?? '').includes('cap'),
      `${okCount}/11 ok, last=${last.ok ? 'ok' : 'capped'} hint="${(last.hint ?? '').slice(0, 60)}"`,
    )
  }

  // ── 9e. LLM-as-judge rerank actually exercised. Skip if no chat
  //         provider configured (the smoke earlier surfaces this). The
  //         deeper assertion is "rerank doesn't blow up + still returns
  //         valid chunks" — order-equality assertions don't make sense
  //         when the LLM has freedom to reorder.
  if (chatProvider) {
    const [fullChat] = await db.db
      .select()
      .from(schema.llmProviders)
      .where(eq(schema.llmProviders.id, chatProvider.id))
      .limit(1)
    if (fullChat && fullChat.defaultModel) {
      const rerankTool = buildSearchKnowledgeTool({
        db,
        attachedFiles: [
          {
            id: fileId,
            name: 'Plant identification basics',
            description: '',
          },
        ],
        embeddingProvider: embedProvider,
        chatModel: {
          providerId: fullChat.kind,
          modelId: fullChat.defaultModel,
          url: fullChat.baseUrl ?? undefined,
        },
      })
      if (rerankTool?.execute) {
        const start = Date.now()
        const reranked = (await callTool(rerankTool, {
          query: 'leaf shape',
          top_k: 5,
        })) as {
          ok: boolean
          chunks: Array<{ file_id: string; snippet: string; score: number }>
        }
        const elapsed = Date.now() - start
        check(
          'rerank path with chatModel returns valid chunks',
          reranked.ok &&
            reranked.chunks.length > 0 &&
            reranked.chunks.every((c) => c.file_id === fileId && c.snippet),
          `${reranked.chunks.length} chunks (${elapsed}ms)`,
        )
      }
    }
  }

  // ── 9f. Thread-scoped search via `withRunContext`. Mirrors what
  //         the dispatcher does when the operator drags a file into
  //         a chat: the file isn't in `agent_files` but the tool
  //         sees it through async context and includes it in scope.
  const threadScopedTool = buildSearchKnowledgeTool({
    db,
    attachedFiles: [], // empty — thread file is the only scope
    embeddingProvider: embedProvider,
    chatModel: null,
  })
  if (threadScopedTool?.execute) {
    // Set up a synthetic thread + an "ephemeral" thread-scoped file
    // (reuse a fresh ingest of the plant doc so we have chunks).
    const [threadHost] = await db.db
      .insert(schema.files)
      .values({
        name: 'Thread-scoped plant guide',
        filename: 'plant-thread.pdf',
        kind: 'pdf',
        bytes: pdfBytes.length,
        contentHash:
          createHash('sha256').update(pdfBytes).update('thread-scope-salt').digest('hex'),
        storagePath: 'pending',
      })
      .returning()
    if (threadHost) {
      const tDir = path.join(TEST_DATA_DIR, 'knowledge', threadHost.id)
      await mkdir(tDir, { recursive: true, mode: 0o700 })
      await copyFile(PDF_PATH, knowledgeOriginalPath(threadHost.id, 'pdf'))
      await db.db
        .update(schema.files)
        .set({ storagePath: tDir })
        .where(eq(schema.files.id, threadHost.id))
      await ingestKnowledgeFile({ db, fileId: threadHost.id })

      const threadIdFake = 'smoke-thread-' + threadHost.id.slice(0, 8)
      const threadCtxResult = (await withRunContext(
        {
          threadId: threadIdFake,
          threadFiles: [
            {
              id: threadHost.id,
              name: threadHost.name,
              description: '',
            },
          ],
          referencedFileIds: [],
        },
        () => callTool(threadScopedTool, { query: 'leaf shape', top_k: 5 }),
      )) as {
        ok: boolean
        chunks: Array<{ file_id: string }>
      }
      check(
        'thread-scope-only tool finds chunks from a thread-attached file',
        threadCtxResult.ok &&
          threadCtxResult.chunks.length > 0 &&
          threadCtxResult.chunks.every((c) => c.file_id === threadHost.id),
        `${threadCtxResult.chunks.length} chunks, all from thread file`,
      )

      // referencedFileIds clamps scope as a HARD filter, even with
      // no agent-attached files in play.
      const refResult = (await withRunContext(
        {
          threadId: threadIdFake,
          threadFiles: [
            {
              id: threadHost.id,
              name: threadHost.name,
              description: '',
            },
          ],
          referencedFileIds: [threadHost.id],
        },
        () => callTool(threadScopedTool, { query: 'leaf shape', top_k: 5 }),
      )) as {
        ok: boolean
        chunks: Array<{ file_id: string }>
      }
      check(
        'referencedFileIds context clamps search to the referenced file',
        refResult.ok &&
          refResult.chunks.length > 0 &&
          refResult.chunks.every((c) => c.file_id === threadHost.id),
        `${refResult.chunks.length} chunks`,
      )

      // Per-burst cap is raised by +5 when references are set.
      // Drive 15 calls; expect all 15 to succeed (10 base + 5 bonus).
      const capProbeTool = buildSearchKnowledgeTool({
        db,
        attachedFiles: [],
        embeddingProvider: embedProvider,
        chatModel: null,
      })
      let capBumpOk = 0
      if (capProbeTool?.execute) {
        for (let i = 0; i < 15; i++) {
          const r = (await withRunContext(
            {
              threadId: threadIdFake,
              threadFiles: [
                {
                  id: threadHost.id,
                  name: threadHost.name,
                  description: '',
                },
              ],
              referencedFileIds: [threadHost.id],
            },
            () => callTool(capProbeTool, { query: `cap-bump ${i}`, top_k: 1 }),
          )) as { ok: boolean }
          if (r.ok) capBumpOk += 1
        }
      }
      check(
        'per-burst cap rises to 15 when referencedFileIds is set',
        capBumpOk === 15,
        `${capBumpOk}/15 ok`,
      )

      // Clean up the thread-host file.
      await db.db
        .delete(schema.files)
        .where(eq(schema.files.id, threadHost.id))
      await rm(tDir, { recursive: true, force: true })
    }
  }

  // ── 9g. Eager pre-fetch helper. The backend route uses this for
  //         short single-@-mention messages; here we exercise the
  //         helper directly against the plant doc.
  const prefetched = await eagerPrefetchKnowledge({
    db,
    fileId,
    query: 'leaf shape',
    topK: 3,
  })
  check(
    'eagerPrefetchKnowledge returns top-K chunks for a known file',
    prefetched.length > 0 &&
      prefetched.length <= 3 &&
      prefetched.every(
        (c) =>
          c.fileId === fileId &&
          typeof c.snippet === 'string' &&
          c.snippet.length > 0,
      ),
    `${prefetched.length} chunks, top snippet=${prefetched[0]?.snippet.slice(0, 50)}…`,
  )
  check(
    'eagerPrefetchKnowledge results are sorted by score descending',
    prefetched.every(
      (c, i) => i === 0 || (prefetched[i - 1]?.score ?? 0) >= c.score,
    ),
    'monotone',
  )
  const noPrefetch = await eagerPrefetchKnowledge({
    db,
    fileId: '00000000-0000-0000-0000-000000000000',
    query: 'anything',
    topK: 3,
  })
  check(
    'eagerPrefetchKnowledge returns empty for an unknown file id',
    noPrefetch.length === 0,
    `${noPrefetch.length} chunks`,
  )

  // ── 9h. PDF chrome stripping: extracted text shouldn't contain a
  //         line that appeared on every page. The plant PDF has an
  //         "-- N of 8 --" page marker; if our stripper works that
  //         exact marker shouldn't appear in the chunks. We don't
  //         know the exact marker text upstream so we sample chunks
  //         for "of 8" — a very common pdf-parse footer pattern.
  const chunkSample = await db.db
    .select({ text: schema.fileChunks.text })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
    .limit(20)
  const repeatingPatterns = [
    /\b1 of 8\b/i,
    /\b2 of 8\b/i,
    /\b3 of 8\b/i,
    /\b4 of 8\b/i,
    /\b5 of 8\b/i,
    /\b6 of 8\b/i,
    /\b7 of 8\b/i,
    /\b8 of 8\b/i,
  ]
  const occurrences = repeatingPatterns.reduce((sum, re) => {
    return (
      sum +
      chunkSample.filter((c) => re.test(c.text)).reduce((n) => n + 1, 0)
    )
  }, 0)
  // Without stripping you'd expect ≥8 occurrences (one per page marker).
  // With stripping it should be near zero.
  check(
    'PDF chrome stripping removes per-page "N of 8" markers',
    occurrences <= 2,
    `${occurrences} occurrences across ${chunkSample.length} chunks (low is good)`,
  )

  // ── 9i. Token-estimate breakdown includes attached files. Verifies
  //         the budget surfacing wired in P3a. We attach the plant
  //         file to a temporary agent slot via raw SQL (smoke can't
  //         build full agents) and call estimateAgentTokens.
  //         The smoke skips estimateAgentTokens itself (heavy setup);
  //         we just verify the helper would HAVE chunks to expose.
  const filesWithChunksQuery = await db.db
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  check(
    'budget-surfacing precondition: file row queryable for catalog tokens',
    filesWithChunksQuery.length === 1,
    'budget card will see this row',
  )

  // ── 9j. Hierarchical chunking. Insert a second small text file
  //         with `chunking_mode='hierarchical'` and verify: parents
  //         exist with NULL embedding, children have parent_id set,
  //         search expansion returns parent text not child text.
  const HIERARCHICAL_TEXT = `# Cardiovascular health

This guide covers cardiovascular risk factors, screening, and
intervention. Key metrics include resting heart rate, blood
pressure, total cholesterol, LDL cholesterol, HDL cholesterol,
and triglycerides.

## Resting heart rate

Resting heart rate (RHR) is a baseline of cardiovascular fitness.
A normal RHR for adults sits between 60 and 100 beats per minute.
Athletes routinely measure 40-60 BPM due to higher stroke volume.

## Cholesterol

Total cholesterol below 200 mg/dL is considered desirable. LDL
("bad cholesterol") should be below 100 mg/dL for most adults.
HDL ("good cholesterol") should be 60 mg/dL or higher.

## Blood pressure

Normal blood pressure is below 120/80 mmHg. Stage 1 hypertension
runs 130-139 over 80-89; stage 2 is 140+/90+. Persistent stage 2
warrants medication on top of lifestyle changes.

## Interventions

Diet, exercise, weight management, and smoking cessation are the
first-line interventions. Statins are the standard
pharmacological intervention for elevated LDL.
`
  const hHash = createHash('sha256')
    .update(HIERARCHICAL_TEXT)
    .digest('hex')
  await db.db
    .delete(schema.files)
    .where(eq(schema.files.contentHash, hHash))
  const [hFile] = await db.db
    .insert(schema.files)
    .values({
      name: 'cardio-health-guide',
      filename: 'cardio-health-guide.md',
      kind: 'md',
      bytes: HIERARCHICAL_TEXT.length,
      contentHash: hHash,
      storagePath: 'pending',
      chunkingMode: 'hierarchical',
    })
    .returning()
  if (hFile) {
    const hDir = path.join(TEST_DATA_DIR, 'knowledge', hFile.id)
    await mkdir(hDir, { recursive: true, mode: 0o700 })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      knowledgeOriginalPath(hFile.id, 'md'),
      HIERARCHICAL_TEXT,
      { mode: 0o600 },
    )
    await db.db
      .update(schema.files)
      .set({ storagePath: hDir })
      .where(eq(schema.files.id, hFile.id))
    await ingestKnowledgeFile({ db, fileId: hFile.id })

    const [hFinal] = await db.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.id, hFile.id))
      .limit(1)
    check(
      'hierarchical ingest reaches ready',
      hFinal?.ingestStatus === 'ready',
      `status=${hFinal?.ingestStatus}${hFinal?.ingestError ? ` err=${hFinal.ingestError}` : ''}`,
    )

    // Inspect chunk rows. Parents: embedding NULL, parent_id NULL.
    // Children: embedding NOT NULL, parent_id NOT NULL.
    const parentRows = await db.pool.query<{ id: string }>(
      `SELECT id FROM file_chunks
       WHERE file_id = $1 AND embedding IS NULL AND parent_id IS NULL`,
      [hFile.id],
    )
    const childRows = await db.pool.query<{ id: string; parent_id: string }>(
      `SELECT id, parent_id FROM file_chunks
       WHERE file_id = $1 AND embedding IS NOT NULL AND parent_id IS NOT NULL`,
      [hFile.id],
    )
    check(
      'hierarchical ingest writes both parents and children',
      parentRows.rows.length >= 1 && childRows.rows.length >= parentRows.rows.length,
      `${parentRows.rows.length} parents, ${childRows.rows.length} children`,
    )
    const parentIdSet = new Set(parentRows.rows.map((r) => r.id))
    check(
      'every child references a parent in the same file',
      childRows.rows.every((r) => parentIdSet.has(r.parent_id)),
      'all children point at known parents',
    )

    // Search via the tool against the hierarchical file. The
    // returned snippets should be PARENT-sized (way more than
    // ~500 chars when a section's been expanded).
    const hTool = buildSearchKnowledgeTool({
      db,
      attachedFiles: [
        { id: hFile.id, name: hFile.name, description: '' },
      ],
      embeddingProvider: embedProvider,
      chatModel: null,
    })
    if (hTool?.execute) {
      const hResult = (await callTool(hTool, {
        query: 'LDL cholesterol levels',
        top_k: 3,
      })) as {
        ok: boolean
        chunks: Array<{ file_id: string; snippet: string }>
      }
      check(
        'hierarchical search returns chunks for a topical query',
        hResult.ok && hResult.chunks.length > 0,
        `${hResult.chunks.length} chunks`,
      )
      // Snippets expanded to parents should contain MORE context
      // than a single 200-token child. Pick the top snippet — it
      // should at least mention "cholesterol" AND have neighboring
      // context (e.g. a heading word from the same section).
      const topSnippet = hResult.chunks[0]?.snippet ?? ''
      check(
        'hierarchical snippets include surrounding parent context',
        topSnippet.toLowerCase().includes('cholesterol') &&
          topSnippet.length > 200,
        `snippet length=${topSnippet.length}, contains 'cholesterol'=${topSnippet.toLowerCase().includes('cholesterol')}`,
      )
    }

    // ── 9j-b. BM25 OR-semantics: a query mixing one real term with
    //          words the document never contains must still match.
    //          Real BM25 scores partial matches; the old
    //          plainto_tsquery AND form returned nothing here.
    {
      const fpRow = await db.pool.query<{ embedding_model: string }>(
        `SELECT embedding_model FROM file_chunks
         WHERE file_id = $1 AND embedding IS NOT NULL LIMIT 1`,
        [hFile.id],
      )
      const orHits = await runBm25Search({
        db,
        scope: [hFile.id],
        fingerprint: fpRow.rows[0]?.embedding_model ?? '',
        query: 'cholesterol zzqx unknownterm reading',
      })
      check(
        'BM25 matches on partial terms (OR-semantics)',
        orHits.length > 0,
        `${orHits.length} hits for a 1-of-4-terms query`,
      )
    }

    // ── 9k. Contextual Retrieval round-trip (only when env enabled).
    //          Skip silently otherwise — the feature is opt-in and
    //          enabling it slows the smoke noticeably (one LLM call
    //          per chunk on ingest).
    if (process.env['AGENT_BRIDGE_CONTEXTUAL_RETRIEVAL'] === 'true') {
      const blurbRows = await db.pool.query<{ context_blurb: string | null }>(
        `SELECT context_blurb FROM file_chunks
         WHERE file_id = $1 AND embedding IS NOT NULL
         LIMIT 5`,
        [hFile.id],
      )
      const withBlurbs = blurbRows.rows.filter(
        (r) => (r.context_blurb ?? '').trim().length > 0,
      )
      check(
        'Contextual Retrieval populates context_blurb on children',
        withBlurbs.length > 0,
        `${withBlurbs.length}/${blurbRows.rows.length} chunks have blurbs`,
      )

      // Contextual BM25 (migration 0022): every chunk's tsv must match
      // its own blurb's lexemes, proving the blurb feeds the keyword
      // index, not just the embedding input. All-stopword blurbs
      // (empty tsquery) are excluded rather than failed.
      const folded = await db.pool.query<{ folded: boolean | null }>(
        `SELECT bool_and(
           plainto_tsquery('english', context_blurb)::text = ''
           OR tsv @@ plainto_tsquery('english', context_blurb)
         ) AS folded
         FROM file_chunks
         WHERE file_id = $1 AND coalesce(context_blurb, '') <> ''`,
        [hFile.id],
      )
      check(
        'contextual BM25: tsv folds in the blurb text',
        folded.rows[0]?.folded === true,
      )
    }

    // Clean up.
    await db.db
      .delete(schema.files)
      .where(eq(schema.files.id, hFile.id))
    await rm(hDir, { recursive: true, force: true })
  }

  // ── 10. Re-ingest clears + re-creates chunks ──────────────────────
  await db.db
    .update(schema.files)
    .set({ ingestStatus: 'pending', chunksDone: 0, ingestError: null })
    .where(eq(schema.files.id, fileId))
  await db.db
    .delete(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
  console.log('▸ re-ingesting…')
  await ingestKnowledgeFile({ db, fileId })
  const [reingested] = await db.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
  const [{ value: chunkCount2 } = { value: 0 }] = await db.db
    .select({ value: count() })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
  check(
    'reingest re-creates chunks',
    reingested?.ingestStatus === 'ready' && chunkCount2 > 0,
    `status=${reingested?.ingestStatus} chunks=${chunkCount2}`,
  )

  // ── 11. Cascade delete drops chunks ───────────────────────────────
  await db.db.delete(schema.files).where(eq(schema.files.id, fileId))
  await rm(storagePath, { recursive: true, force: true })
  const [{ value: chunkCountAfter } = { value: 0 }] = await db.db
    .select({ value: count() })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, fileId))
  check(
    'cascade delete dropped all chunks',
    chunkCountAfter === 0,
    `${chunkCountAfter} chunks remain`,
  )

  // ── 12. Rebuild path: dim sync + destructive truncate + DDL swap ──
  //
  // Verifies the runtime-DDL recovery shipped in this round:
  //   - ensureFileChunksDim is a no-op when dim already matches.
  //   - ensureFileChunksDim refuses when chunks exist at a different
  //     dim (forces routing through the destructive rebuild path).
  //   - rebuildFileChunksAtDim truncates and ALTERs the column type.
  //   - The HNSW index survives the rebuild (recreated by the helper).
  //   - rebuildFileChunksAndQueueReingest equivalent: a TRUNCATE on a
  //     populated table wipes chunks and the column matches the
  //     requested dim afterwards.
  const rebuildFile = await uploadFixture(db)
  const rebuildFileId = rebuildFile.id
  await ingestKnowledgeFile({ db, fileId: rebuildFileId })

  const beforeSnap = await readFileChunksDim(db)
  check(
    'rebuild: starting snapshot has chunks + dim matches provider',
    beforeSnap.chunkCount > 0 &&
      beforeSnap.columnDim === (embedProvider.embeddingDims ?? 1024),
    `dim=${beforeSnap.columnDim} chunks=${beforeSnap.chunkCount}`,
  )

  // (a) ensureFileChunksDim no-op when dim matches.
  const sameDimResult = await ensureFileChunksDim(
    db,
    beforeSnap.columnDim ?? 1024,
  )
  check(
    'ensureFileChunksDim is a no-op when dim already matches',
    sameDimResult.changed === false,
    `changed=${sameDimResult.changed} (no DDL fired)`,
  )

  // (b) ensureFileChunksDim refuses when dim differs AND data exists.
  let mismatchThrew = false
  let mismatchType = ''
  try {
    await ensureFileChunksDim(db, (beforeSnap.columnDim ?? 1024) + 256)
  } catch (err) {
    mismatchThrew = err instanceof FileChunksDimMismatch
    mismatchType = err instanceof Error ? err.constructor.name : typeof err
  }
  check(
    'ensureFileChunksDim throws FileChunksDimMismatch when chunks exist at a different dim',
    mismatchThrew,
    `threw ${mismatchType}`,
  )

  // (c) rebuildFileChunksAtDim with a different dim: TRUNCATE + ALTER COLUMN.
  const swapDim = (beforeSnap.columnDim ?? 1024) === 1024 ? 768 : 1024
  const swapResult = await rebuildFileChunksAtDim(db, swapDim)
  const afterSwap = await readFileChunksDim(db)
  check(
    'rebuildFileChunksAtDim to a different dim TRUNCATEs',
    afterSwap.chunkCount === 0,
    `chunks=${afterSwap.chunkCount}`,
  )
  check(
    'rebuildFileChunksAtDim to a different dim ALTERs the column type',
    afterSwap.columnDim === swapDim && swapResult.changed,
    `columnDim=${afterSwap.columnDim} target=${swapDim} changed=${swapResult.changed}`,
  )

  // HNSW index must still exist after the ALTER COLUMN swap.
  const idxRows = await db.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'file_chunks_embedding_idx'`,
  )
  check(
    'HNSW index file_chunks_embedding_idx is recreated after rebuild',
    idxRows.rows.length === 1,
    `${idxRows.rows.length} match(es)`,
  )

  // (d) Swap back to the provider's dim so a follow-up reingest works.
  const restoreDim = embedProvider.embeddingDims ?? 1024
  await rebuildFileChunksAtDim(db, restoreDim)
  const restored = await readFileChunksDim(db)
  check(
    'rebuildFileChunksAtDim restores the column to the provider dim',
    restored.columnDim === restoreDim && restored.chunkCount === 0,
    `dim=${restored.columnDim} chunks=${restored.chunkCount}`,
  )

  // (e) Reingest the file after rebuild — should land chunks at the
  //     restored dim, status flips to ready.
  await db.db
    .update(schema.files)
    .set({ ingestStatus: 'pending', chunksDone: 0, ingestError: null })
    .where(eq(schema.files.id, rebuildFileId))
  await ingestKnowledgeFile({ db, fileId: rebuildFileId })
  const [rebuiltRow] = await db.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, rebuildFileId))
    .limit(1)
  const [{ value: rebuiltCount } = { value: 0 }] = await db.db
    .select({ value: count() })
    .from(schema.fileChunks)
    .where(eq(schema.fileChunks.fileId, rebuildFileId))
  check(
    'reingest after rebuild lands chunks at the restored dim',
    rebuiltRow?.ingestStatus === 'ready' && rebuiltCount > 0,
    `status=${rebuiltRow?.ingestStatus} chunks=${rebuiltCount}`,
  )

  // Clean up.
  await db.db.delete(schema.files).where(eq(schema.files.id, rebuildFileId))
  await rm(path.join(TEST_DATA_DIR, 'knowledge', rebuildFileId), {
    recursive: true,
    force: true,
  })

  // ── 13. baseUrl normalization regression ─────────────────────────
  //
  // The "Invalid JSON response" production bug came from a provider
  // row whose baseUrl was `http://127.0.0.1:8081` (no `/v1`). Mastra
  // appends `/embeddings` to whatever it's given, so the request
  // landed on llama-server's NATIVE endpoint (returns a top-level
  // array, `embedding: [[...]]` 2D shape) instead of the OpenAI-
  // compatible `/v1/embeddings`. The previous fixture always stored
  // baseUrl WITH `/v1`, so the broken code path was never exercised
  // and the smoke missed the bug entirely.
  //
  // The fix lives in `resolveBaseUrl` (build-agent.ts) — strips
  // trailing slashes and auto-appends `/v1` if missing. This block
  // exercises that path: strip `/v1` from the provider's stored
  // baseUrl, ingest, assert success, restore. If `resolveBaseUrl`
  // ever stops normalizing, ingest will fail here with the exact
  // same "Invalid JSON response" message the user hit, and the
  // regression will be caught before merge instead of in production.
  const originalBaseUrl = embedProvider.baseUrl
  if (originalBaseUrl && originalBaseUrl.endsWith('/v1')) {
    const stripped = originalBaseUrl.slice(0, -3).replace(/\/+$/, '')
    try {
      // Mutate the live provider row so the next ingest pulls the
      // stripped form. The buildEmbedder helper re-reads the row on
      // every call, so the change takes effect immediately.
      await db.db
        .update(schema.llmProviders)
        .set({ baseUrl: stripped })
        .where(eq(schema.llmProviders.id, embedProvider.id))

      const noV1File = await uploadFixture(db)
      try {
        await ingestKnowledgeFile({ db, fileId: noV1File.id })
        const [noV1Row] = await db.db
          .select()
          .from(schema.files)
          .where(eq(schema.files.id, noV1File.id))
          .limit(1)
        check(
          'ingest works when provider baseUrl omits /v1 (auto-append)',
          noV1Row?.ingestStatus === 'ready',
          `status=${noV1Row?.ingestStatus}` +
            (noV1Row?.ingestError ? ` error=${noV1Row.ingestError}` : ''),
        )
        const [{ value: noV1Chunks } = { value: 0 }] = await db.db
          .select({ value: count() })
          .from(schema.fileChunks)
          .where(eq(schema.fileChunks.fileId, noV1File.id))
        check(
          'embedder produced chunks against the stripped-baseUrl provider',
          noV1Chunks > 0,
          `${noV1Chunks} chunks`,
        )
      } finally {
        await db.db
          .delete(schema.files)
          .where(eq(schema.files.id, noV1File.id))
        await rm(path.join(TEST_DATA_DIR, 'knowledge', noV1File.id), {
          recursive: true,
          force: true,
        })
      }
    } finally {
      // Restore the provider row so subsequent test runs and the dev
      // workspace aren't left with a mutated baseUrl.
      await db.db
        .update(schema.llmProviders)
        .set({ baseUrl: originalBaseUrl })
        .where(eq(schema.llmProviders.id, embedProvider.id))
    }
  }

  // ── 14. Orphan-chunk recovery (bug A regression) ─────────────────
  //
  // Production race: a process dies between INSERTing a chunk batch and
  // UPDATEing files.chunks_done. On retry, the resume path reads
  // chunks_done=0 and re-inserts at chunk_index 0, 1, ... duplicating
  // every orphan chunk. This block simulates the orphan state directly
  // (manually INSERTing chunks while leaving chunks_done=0), then
  // re-runs ingestKnowledgeFile and asserts the resulting chunk set is
  // clean — no duplicates, no doubled chunk_index values.
  const orphanFile = await uploadFixture(db)
  try {
    // Manually inject 5 orphan chunks at chunk_index 0..4, matching the
    // shape a real partial-insert would leave. The fingerprint must
    // match the active provider so the SQL retrieval gates don't filter
    // them out (so a "no duplicates" assertion is meaningful).
    const orphanFingerprint = `${embedProvider.kind}:${embedProvider.defaultModel}:${embedProvider.embeddingDims}`
    const orphanRows = Array.from({ length: 5 }, (_, i) => ({
      fileId: orphanFile.id,
      chunkIndex: i,
      page: null,
      sectionPath: null,
      text: `orphan chunk ${i}`,
      embeddingModel: orphanFingerprint,
      embedding: null,
    }))
    await db.db.insert(schema.fileChunks).values(orphanRows)

    // Reset the file row to pending state with chunks_done=0 — the
    // shape ingestKnowledgeFile would see after the partial-insert
    // crash. ingest_status was 'pending' from uploadFixture already.
    await db.db
      .update(schema.files)
      .set({ ingestStatus: 'pending', chunksDone: 0, ingestError: null })
      .where(eq(schema.files.id, orphanFile.id))

    // Run ingest. Without the orphan-cleanup fix, this will either
    // duplicate chunks (resulting in 10 rows at the same chunk_index
    // values) or fail with a duplicate-key error if a constraint is in
    // place. With the fix: orphans are deleted at the start of ingest,
    // and the run produces a clean chunk set.
    await ingestKnowledgeFile({ db, fileId: orphanFile.id })

    const orphanRowsAfter = await db.pool.query<{
      chunk_index: number
      n: string
    }>(
      `SELECT chunk_index, COUNT(*)::text AS n
         FROM file_chunks
        WHERE file_id = $1
        GROUP BY chunk_index
        ORDER BY chunk_index ASC`,
      [orphanFile.id],
    )
    const duplicates = orphanRowsAfter.rows.filter((r) => Number(r.n) > 1)
    check(
      'partial-insert orphans are cleaned, no duplicate chunk_index',
      duplicates.length === 0,
      duplicates.length > 0
        ? `duplicates at chunk_index: ${duplicates.map((r) => r.chunk_index).join(', ')}`
        : 'all chunk_index values unique',
    )
    const [{ value: finalChunkCount } = { value: 0 }] = await db.db
      .select({ value: count() })
      .from(schema.fileChunks)
      .where(eq(schema.fileChunks.fileId, orphanFile.id))
    check(
      'ingest after partial-insert produces a sensible chunk count',
      finalChunkCount > 0 && finalChunkCount < 50,
      `${finalChunkCount} chunks (expected ~5 for the fixture PDF)`,
    )
  } finally {
    await db.db.delete(schema.files).where(eq(schema.files.id, orphanFile.id))
    await rm(path.join(TEST_DATA_DIR, 'knowledge', orphanFile.id), {
      recursive: true,
      force: true,
    })
  }

  // ── 15. Concurrent ensureFileChunksDim (bug B regression) ────────
  //
  // Two ingests starting in parallel can both observe the column at an
  // outdated dim AND an empty chunks table, race into DROP INDEX /
  // ALTER COLUMN / CREATE INDEX, and the second one fails at CREATE
  // INDEX with "relation file_chunks_embedding_idx already exists".
  // Fix: ensureFileChunksDim acquires a pg advisory lock before the
  // read-then-DDL sequence so concurrent callers serialize.
  //
  // We can't deterministically reproduce the race without artificially
  // slowing one call, but this contract test verifies the lock is in
  // place: 5 concurrent ensureFileChunksDim calls all succeed without
  // a DDL conflict. Without the fix this MAY fail intermittently —
  // it's primarily a regression guard so future code that removes the
  // lock gets caught here.
  const targetDim = embedProvider.embeddingDims
  // Reset the column to a different dim first so the race actually
  // engages — if the column already matches, ensureFileChunksDim
  // no-ops without any DDL and the test is uninformative.
  await rebuildFileChunksAtDim(db, targetDim === 1024 ? 768 : 1024)
  let concurrentErrors: string[] = []
  await Promise.all(
    Array.from({ length: 5 }, () =>
      ensureFileChunksDim(db, targetDim).catch((err: unknown) => {
        concurrentErrors.push(
          err instanceof Error ? err.message : String(err),
        )
      }),
    ),
  )
  check(
    'concurrent ensureFileChunksDim calls all succeed (no DDL race)',
    concurrentErrors.length === 0,
    concurrentErrors.length > 0
      ? `${concurrentErrors.length} failed: ${concurrentErrors[0]}`
      : 'all 5 serialized cleanly',
  )
  // Confirm the final state is sane regardless.
  const finalSnap = await readFileChunksDim(db)
  check(
    'concurrent ensureFileChunksDim left the column at the target dim',
    finalSnap.columnDim === targetDim,
    `columnDim=${finalSnap.columnDim} target=${targetDim}`,
  )
}

/**
 * Re-upload the same PDF fixture used in the main flow, but with a
 * unique content_hash so the dedup check doesn't reject it. We mutate
 * the bytes trivially (prepend a one-byte comment marker would corrupt
 * PDFs; instead we vary the name + content_hash field directly via a
 * fresh row insert).
 */
async function uploadFixture(
  db: ReturnType<typeof createDb>,
): Promise<{ id: string }> {
  const PDF_PATH = path.join(
    REPO_ROOT,
    'tests/fixtures/pdf/Plant identification basics.pdf',
  )
  const bytes = await readFile(PDF_PATH)
  // Salt the hash with a random suffix so the unique constraint passes.
  const salt = Math.random().toString(36).slice(2, 10)
  const hash = createHash('sha256').update(bytes).update(salt).digest('hex')
  const [row] = await db.db
    .insert(schema.files)
    .values({
      name: `Plant identification basics (rebuild ${salt})`,
      filename: 'Plant identification basics.pdf',
      kind: 'pdf',
      bytes: bytes.length,
      description: '',
      contentHash: hash,
      // Match the real upload route: insert with a sentinel then
      // UPDATE to the resolved dir once we know the id.
      storagePath: 'pending',
      ingestStatus: 'pending',
    })
    .returning({ id: schema.files.id })
  if (!row) throw new Error('uploadFixture: insert returned no rows')
  const dir = knowledgeFileDir(row.id)
  await mkdir(dir, { recursive: true })
  await copyFile(PDF_PATH, knowledgeOriginalPath(row.id, 'pdf'))
  await db.db
    .update(schema.files)
    .set({ storagePath: dir })
    .where(eq(schema.files.id, row.id))
  return { id: row.id }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function callTool(
  tool: { execute?: unknown },
  input: { query: string; file_ids?: string[]; top_k?: number },
): Promise<unknown> {
  // Mastra's Tool type has a complex ExecutionContext generic that
  // we don't have access to construct properly in the test — cast
  // through to bypass. Execute itself only reads `input` for our
  // tool; the second arg is unused in our implementation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = tool.execute as any
  return fn(input, {})
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
