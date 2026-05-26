/**
 * Pure-function smoke for the typed gitnexus callers + parsers.
 *
 * Drives `callGitnexusQuery` / `callGitnexusRouteMap` /
 * `callGitnexusApiImpact` / `callGitnexusCypher` / `callGitnexusImpact`
 * against synthetic gitnexus payloads. No subprocess, no network, no
 * Mastra.
 *
 * Why this exists: the wrappers (`find_in_codebase`,
 * `assess_change_impact`, `trace_flow`) project gitnexus output into
 * codebase-inspection-report file rows. A subtle shape mismatch — e.g. reading
 * `accessedKeys` when gitnexus emits `accesses` — silently produces
 * empty results in production. The smoke locks in the field names and
 * envelope variants gitnexus emits today, so a future gitnexus version
 * bump that drifts the schema fails CI instead of degrading silently.
 */

import {
  callGitnexusApiImpact,
  callGitnexusCypher,
  callGitnexusImpact,
  callGitnexusQuery,
  callGitnexusRouteMap,
  type GitnexusApiImpactResult,
  type GitnexusCypherResult,
  type GitnexusImpactResult,
  type GitnexusQueryResponse,
  type GitnexusRoute,
} from '@agent-bridge/agents'

// ─── Assertion harness (mirrors smoke-dispatcher-mapper.ts) ─────────────────

console.log('━'.repeat(60))
console.log(' Gitnexus callers + parsers smoke')
console.log('━'.repeat(60))

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, diag = ''): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}${diag ? ' — ' + diag : ''}`)
  } else {
    failed += 1
    failures.push(`${name}${diag ? ' — ' + diag : ''}`)
    console.log(`✗ ${name}${diag ? ' — ' + diag : ''}`)
  }
}

// ─── Mock tool factory ──────────────────────────────────────────────────────

/**
 * Build a fake gitnexus tool dict for a single tool name. The fake's
 * `execute(...)` returns the supplied payload wrapped in the canonical
 * MCP `CallToolResult` envelope so the `unwrap()` helper's text-content
 * path is exercised — same path the real Mastra MCP client uses.
 */
function mockToolDict(toolName: string, payload: unknown): Record<string, {
  execute: (args: unknown) => Promise<unknown>
}> {
  return {
    [toolName]: {
      execute: async () => ({
        content: [
          { type: 'text', text: JSON.stringify(payload) },
        ],
      }),
    },
  }
}

// ─── 1. parseRouteMap: full payload with middleware + consumers + flows ────

console.log('\n• route_map: full payload (handler + middleware + consumers)')

{
  const payload = {
    routes: [
      {
        route: 'POST /api/users',
        handler: 'src/routes/users.ts',
        middleware: ['withAuth', 'withRateLimit'],
        consumers: [
          {
            name: 'UserList',
            filePath: 'src/components/UserList.tsx',
            accessedKeys: ['data', 'pagination'],
            fetchCount: 3,
          },
          {
            name: 'UserDetail',
            filePath: 'src/components/UserDetail.tsx',
            accessedKeys: ['data'],
          },
        ],
        flows: ['UserLogin'],
      },
    ],
    total: 1,
  }
  const tools = mockToolDict('gitnexus_route_map', payload)
  const result = (await callGitnexusRouteMap({
    tools: tools as never,
    repo: 'api-service',
    route: '/api/users',
  })) as readonly GitnexusRoute[]

  check('returns one route', result.length === 1, `len=${result.length}`)
  const r = result[0]!
  check('route field parsed', r.route === 'POST /api/users', `got=${r.route}`)
  check('handler-as-string parsed', r.handlerPath === 'src/routes/users.ts', `got=${r.handlerPath}`)
  check(
    'middleware array kept',
    r.middleware.length === 2 &&
      r.middleware[0] === 'withAuth' &&
      r.middleware[1] === 'withRateLimit',
    `got=${JSON.stringify(r.middleware)}`,
  )
  check('two consumers parsed', r.consumers.length === 2, `len=${r.consumers.length}`)
  check(
    'consumer accessedKeys preserved',
    r.consumers[0]?.accessedKeys.length === 2 &&
      r.consumers[0]?.accessedKeys[0] === 'data',
    `got=${JSON.stringify(r.consumers[0]?.accessedKeys)}`,
  )
  check(
    'fetchCount preserved when > 1',
    r.consumers[0]?.fetchCount === 3,
    `got=${r.consumers[0]?.fetchCount}`,
  )
  check(
    'fetchCount null when absent',
    r.consumers[1]?.fetchCount === null,
    `got=${r.consumers[1]?.fetchCount}`,
  )
  check('flows array kept', r.flows[0] === 'UserLogin', `got=${JSON.stringify(r.flows)}`)
}

// ─── 2. parseRouteMap: handler as nested object (legacy gitnexus shape) ────

console.log('\n• route_map: handler emitted as nested object')

{
  const payload = {
    routes: [
      {
        route: 'GET /api/health',
        handler: { filePath: 'src/routes/health.ts', name: 'healthHandler' },
      },
    ],
  }
  const tools = mockToolDict('gitnexus_route_map', payload)
  const result = await callGitnexusRouteMap({
    tools: tools as never,
    repo: 'api-service',
  })
  check(
    'handler.filePath unwrapped from nested object',
    result[0]?.handlerPath === 'src/routes/health.ts',
    `got=${result[0]?.handlerPath}`,
  )
  check(
    'handler.name unwrapped to handlerSymbol',
    result[0]?.handlerSymbol === 'healthHandler',
    `got=${result[0]?.handlerSymbol}`,
  )
}

// ─── 3. parseRouteMap: zero routes returned (empty index case) ─────────────

console.log('\n• route_map: empty result')

{
  const payload = { routes: [], total: 0, message: 'No routes found' }
  const tools = mockToolDict('gitnexus_route_map', payload)
  const result = await callGitnexusRouteMap({ tools: tools as never, repo: 'r' })
  check('empty payload returns []', result.length === 0, `len=${result.length}`)
}

// ─── 4. parseRouteMap: middleware absent or null defaults to [] ────────────

console.log('\n• route_map: missing middleware/consumers default to []')

{
  const payload = {
    routes: [{ route: '/x', handler: 'src/x.ts' }],
  }
  const tools = mockToolDict('gitnexus_route_map', payload)
  const result = await callGitnexusRouteMap({ tools: tools as never, repo: 'r' })
  const r = result[0]!
  check(
    'missing middleware defaults to []',
    Array.isArray(r.middleware) && r.middleware.length === 0,
  )
  check(
    'missing consumers defaults to []',
    Array.isArray(r.consumers) && r.consumers.length === 0,
  )
  check(
    'missing flows defaults to []',
    Array.isArray(r.flows) && r.flows.length === 0,
  )
}

// ─── 5. parseApiImpact: single-route shape (not wrapped in { routes }) ──

console.log('\n• api_impact: single-route shape, mismatch derivation')

{
  // Gitnexus returns the route object DIRECTLY when only one route
  // matches. Mismatches live in a top-level `mismatches[]`, NOT on the
  // consumer rows. Risk lives at `impactSummary.riskLevel`.
  const payload = {
    route: 'POST /api/users',
    handler: 'src/routes/users.ts',
    middleware: ['withAuth'],
    consumers: [
      { name: 'UserForm', file: 'src/components/UserForm.tsx', accesses: ['data', 'address'] },
      { name: 'UserList', file: 'src/components/UserList.tsx', accesses: ['data'] },
    ],
    mismatches: [
      {
        consumer: 'src/components/UserForm.tsx',
        field: 'address',
        reason: 'accessed but not in response shape',
        confidence: 'high',
      },
    ],
    impactSummary: { directConsumers: 2, affectedFlows: 0, riskLevel: 'MEDIUM' },
  }
  const tools = mockToolDict('gitnexus_api_impact', payload)
  const result = (await callGitnexusApiImpact({
    tools: tools as never,
    repo: 'api-service',
    route: '/api/users',
  })) as GitnexusApiImpactResult
  check(
    'single-route shape detected',
    result.routes.length === 1 && result.routes[0]?.route === 'POST /api/users',
    `routes=${JSON.stringify(result.routes)}`,
  )
  check(
    'two consumers parsed',
    result.consumers.length === 2,
    `len=${result.consumers.length}`,
  )
  check(
    'accesses field parsed (NOT accessedKeys)',
    result.consumers[0]?.accessedKeys.length === 2 &&
      result.consumers[0]?.accessedKeys.includes('data'),
    `got=${JSON.stringify(result.consumers[0]?.accessedKeys)}`,
  )
  const mismatched = result.consumers.find(
    (c) => c.path === 'src/components/UserForm.tsx',
  )
  check(
    'consumer with mismatch tagged status=mismatch',
    mismatched?.status === 'mismatch',
    `got=${mismatched?.status}`,
  )
  check(
    'consumer with mismatch carries confidence',
    mismatched?.confidence === 'high',
    `got=${mismatched?.confidence}`,
  )
  const clean = result.consumers.find(
    (c) => c.path === 'src/components/UserList.tsx',
  )
  check(
    'consumer without mismatch tagged status=ok',
    clean?.status === 'ok',
    `got=${clean?.status}`,
  )
  check(
    'risk read from impactSummary.riskLevel',
    result.risk === 'MEDIUM',
    `got=${result.risk}`,
  )
}

// ─── 6. parseApiImpact: wrapped { routes: [...], total } shape ──────────

console.log('\n• api_impact: multi-route wrapped shape')

{
  const payload = {
    routes: [
      {
        route: 'GET /api/users',
        handler: 'src/routes/users-get.ts',
        consumers: [{ name: 'A', file: 'src/A.tsx', accesses: [] }],
        impactSummary: { riskLevel: 'LOW', directConsumers: 1, affectedFlows: 0 },
      },
      {
        route: 'POST /api/users',
        handler: 'src/routes/users-post.ts',
        consumers: [{ name: 'B', file: 'src/B.tsx', accesses: ['data'] }],
        impactSummary: { riskLevel: 'HIGH', directConsumers: 1, affectedFlows: 0 },
      },
    ],
    total: 2,
  }
  const tools = mockToolDict('gitnexus_api_impact', payload)
  const result = (await callGitnexusApiImpact({
    tools: tools as never,
    repo: 'r',
    route: '/api/users',
  })) as GitnexusApiImpactResult
  check('two routes', result.routes.length === 2, `len=${result.routes.length}`)
  check(
    'two consumers (one per route)',
    result.consumers.length === 2,
    `len=${result.consumers.length}`,
  )
  // `risk` is "first non-null" across the loop. Either LOW or HIGH is
  // acceptable depending on iteration order — we just require it's set.
  check(
    'risk captured from at least one route',
    result.risk === 'LOW' || result.risk === 'HIGH',
    `got=${result.risk}`,
  )
}

// ─── 7. parseApiImpact: empty consumer.repo handled in caller ─────────────

console.log('\n• api_impact: empty consumer.repo (typical case)')

{
  // Gitnexus does not emit a `repo` field on consumers. Verify the
  // parser tolerates this without crashing and surfaces an empty
  // string — the assess_change_impact wrapper then treats empty as
  // same-repo. This is the bug we previously had backwards.
  const payload = {
    route: '/api/x',
    handler: 'src/x.ts',
    consumers: [{ name: 'X', file: 'src/X.tsx', accesses: [] }],
  }
  const tools = mockToolDict('gitnexus_api_impact', payload)
  const result = await callGitnexusApiImpact({
    tools: tools as never,
    repo: 'r',
    route: '/api/x',
  })
  check(
    'consumer.repo defaults to empty string when gitnexus omits it',
    result.consumers[0]?.repo === '',
    `got=${result.consumers[0]?.repo}`,
  )
}

// ─── 8. parseCypher: row_count + markdown table → rows ─────────────────────

console.log('\n• cypher: markdown table parsed back to rows')

{
  const markdown = `| name | filePath | depth |
| --- | --- | --- |
| handleLogin | src/auth.ts | 1 |
| validateJwt | src/auth/jwt.ts | 2 |`
  const payload = { markdown, row_count: 2 }
  const tools = mockToolDict('gitnexus_cypher', payload)
  const result = (await callGitnexusCypher({
    tools: tools as never,
    repo: 'r',
    query: 'MATCH ...',
  })) as GitnexusCypherResult
  check('markdown preserved verbatim', result.markdown === markdown)
  check('rowCount preserved', result.rowCount === 2, `got=${result.rowCount}`)
  check('parsed two rows', result.rows.length === 2, `len=${result.rows.length}`)
  check(
    'row 0 columns mapped by header',
    result.rows[0]?.['name'] === 'handleLogin' &&
      result.rows[0]?.['filePath'] === 'src/auth.ts' &&
      result.rows[0]?.['depth'] === '1',
    `got=${JSON.stringify(result.rows[0])}`,
  )
  check(
    'row 1 mapped',
    result.rows[1]?.['name'] === 'validateJwt',
    `got=${result.rows[1]?.['name']}`,
  )
}

// ─── 9. parseCypher: empty markdown → empty rows ──────────────────────────

console.log('\n• cypher: empty markdown')

{
  const tools = mockToolDict('gitnexus_cypher', { markdown: '', row_count: 0 })
  const result = await callGitnexusCypher({
    tools: tools as never,
    repo: 'r',
    query: 'MATCH (x) RETURN x',
  })
  check('empty markdown → empty rows', result.rows.length === 0)
  check('rowCount zero', result.rowCount === 0)
}

// ─── 10. parseCypher: markdown without table header → empty rows ──────────

console.log('\n• cypher: markdown lacking a header row')

{
  const payload = {
    markdown: 'Some prose here.\nNo table.\nJust text.',
    row_count: 0,
  }
  const tools = mockToolDict('gitnexus_cypher', payload)
  const result = await callGitnexusCypher({
    tools: tools as never,
    repo: 'r',
    query: '',
  })
  check(
    'tableless markdown returns no rows (doesnt throw)',
    result.rows.length === 0,
  )
}

// ─── 11. query: type field surfaced on hits for Route-node detection ────

console.log('\n• query: type field surfaced per hit')

{
  // Mirror the gitnexus shape with a `Route` typed hit alongside
  // regular Function hits. The `type` field is what find_in_codebase
  // dispatches on for the post-hoc route_map enrichment (replaces the
  // old regex-on-query-string gate). Verifying the parser carries it
  // through faithfully.
  const payload = {
    processes: [],
    process_symbols: [],
    definitions: [
      {
        id: 'Function:src/util.ts:helper',
        name: 'helper',
        type: 'Function',
        filePath: 'src/util.ts',
        startLine: 1,
      },
      {
        id: 'Route:POST /api/users',
        name: 'POST /api/users',
        type: 'Route',
        filePath: 'src/routes/users.ts',
        startLine: 5,
      },
    ],
  }
  const tools = mockToolDict('gitnexus_query', payload)
  const result = await callGitnexusQuery({
    tools: tools as never,
    repo: 'api-service',
    query: 'users',
  })
  const fn = result.hits.find((h) => h.symbol === 'helper')
  const route = result.hits.find((h) => h.symbol === 'POST /api/users')
  check('function hit has type=Function', fn?.type === 'Function', `got=${fn?.type}`)
  check('route hit has type=Route', route?.type === 'Route', `got=${route?.type}`)
  check(
    'route hit also surfaces its name in symbol (used as route_map filter)',
    route?.symbol === 'POST /api/users',
    `got=${route?.symbol}`,
  )
}

// ─── 12. query: legacy hits default type to null ────────────────────────

console.log('\n• query: legacy hits default type to null')

{
  const payload = [
    { filePath: 'src/a.ts', name: 'a', startLine: 1, score: 0.5 },
  ]
  const tools = mockToolDict('gitnexus_query', payload)
  const result = await callGitnexusQuery({
    tools: tools as never,
    repo: 'r',
    query: 'a',
  })
  check('legacy hit type defaults to null', result.hits[0]?.type === null)
}

// ─── 13. parseRouteMap: tool execute throws → caller rethrows ────────────

console.log('\n• route_map: tool execute failure propagates')

{
  const tools = {
    gitnexus_route_map: {
      execute: async () => {
        throw new Error('gitnexus subprocess died')
      },
    },
  }
  let threw = false
  try {
    await callGitnexusRouteMap({ tools: tools as never, repo: 'r' })
  } catch (err) {
    threw = true
    check(
      'rethrows original error message',
      err instanceof Error && err.message.includes('gitnexus subprocess died'),
      `got=${err instanceof Error ? err.message : String(err)}`,
    )
  }
  check('execute failure surfaced as throw', threw)
}

// ─── 14a. parseImpact: byDepth shape with relationType per row ──────────

console.log('\n• impact: byDepth grouping flattened, relationType preserved')

{
  const payload = {
    target: { id: 'Function:src/auth.ts:login', name: 'login', type: 'Function' },
    direction: 'upstream',
    impactedCount: 3,
    risk: 'HIGH',
    summary: { direct: 2, processes_affected: 1, modules_affected: 1 },
    affected_processes: [
      { name: 'UserLogin', type: 'login', filePath: 'src/auth/handler.ts' },
      { name: 'PasswordReset' },
    ],
    affected_modules: [
      { name: 'auth', hits: 5, impact: 'direct' },
      { name: 'middleware', hits: 2, impact: 'indirect' },
    ],
    byDepth: {
      '1': [
        {
          depth: 1,
          id: 'Function:src/middleware.ts:auth',
          name: 'auth',
          type: 'Function',
          filePath: 'src/middleware.ts',
          relationType: 'CALLS',
          confidence: 'high',
        },
        {
          depth: 1,
          id: 'File:src/types.ts',
          name: 'types.ts',
          type: 'File',
          filePath: 'src/types.ts',
          relationType: 'IMPORTS',
          confidence: 'medium',
        },
      ],
      '2': [
        {
          depth: 2,
          id: 'Function:src/server.ts:mount',
          name: 'mount',
          type: 'Function',
          filePath: 'src/server.ts',
          relationType: 'CALLS',
          confidence: 'high',
        },
      ],
    },
  }
  const tools = mockToolDict('gitnexus_impact', payload)
  const result = (await callGitnexusImpact({
    tools: tools as never,
    repo: 'api-service',
    target: 'login',
    direction: 'upstream',
  })) as GitnexusImpactResult

  check('byDepth flattened to rows', result.rows.length === 3, `len=${result.rows.length}`)
  check(
    'depth values preserved per row',
    result.rows.filter((r) => r.depth === 1).length === 2 &&
      result.rows.filter((r) => r.depth === 2).length === 1,
    `depths=${result.rows.map((r) => r.depth).join(',')}`,
  )
  const calls = result.rows.filter((r) => r.relationType === 'CALLS')
  const imports = result.rows.filter((r) => r.relationType === 'IMPORTS')
  check(
    'relationType=CALLS preserved on 2 rows',
    calls.length === 2,
    `len=${calls.length}`,
  )
  check(
    'relationType=IMPORTS preserved on 1 row',
    imports.length === 1,
    `len=${imports.length}`,
  )
  check('risk parsed: HIGH', result.risk === 'HIGH', `got=${result.risk}`)
  check('partial=false when gitnexus did not set it', result.partial === false)
  check(
    'affected_processes captured (2 names)',
    result.affectedProcesses.length === 2 &&
      result.affectedProcesses.includes('UserLogin') &&
      result.affectedProcesses.includes('PasswordReset'),
    `got=${JSON.stringify(result.affectedProcesses)}`,
  )
  check(
    'affected_modules captured with direct/indirect tags',
    result.affectedModules.length === 2 &&
      result.affectedModules[0]?.name === 'auth' &&
      result.affectedModules[0]?.impact === 'direct' &&
      result.affectedModules[1]?.impact === 'indirect',
    `got=${JSON.stringify(result.affectedModules)}`,
  )
}

// ─── 14b. parseImpact: partial=true surfaces ─────────────────────────────

console.log('\n• impact: partial flag preserved')

{
  const payload = {
    target: { name: 'login' },
    direction: 'upstream',
    impactedCount: 1,
    partial: true,
    risk: 'MEDIUM',
    byDepth: {
      '1': [
        {
          depth: 1,
          id: 'Function:x',
          name: 'x',
          type: 'Function',
          filePath: 'src/x.ts',
          relationType: 'CALLS',
          confidence: 'high',
        },
      ],
    },
  }
  const tools = mockToolDict('gitnexus_impact', payload)
  const result = await callGitnexusImpact({
    tools: tools as never,
    repo: 'r',
    target: 'login',
    direction: 'upstream',
  })
  check('partial=true preserved', result.partial === true)
  check('still got rows alongside partial flag', result.rows.length === 1)
}

// ─── 14c. parseImpact: legacy `items[]` shape stays supported ────────────

console.log('\n• impact: legacy flat items shape')

{
  // Older gitnexus versions returned a flat `items` array without
  // byDepth grouping. Verify the parser still extracts rows.
  const payload = {
    items: [
      {
        depth: 1,
        path: 'src/a.ts',
        relationType: 'CALLS',
        confidence: 'high',
      },
    ],
  }
  const tools = mockToolDict('gitnexus_impact', payload)
  const result = await callGitnexusImpact({
    tools: tools as never,
    repo: 'r',
    target: 'x',
    direction: 'downstream',
  })
  check('legacy items array parsed', result.rows.length === 1)
  check('relationType from legacy row preserved', result.rows[0]?.relationType === 'CALLS')
  check('no envelope metadata on legacy shape', result.risk === null && result.partial === false)
}

// ─── 14d. parseApiImpact: middleware partial + responseShape + flows ───

console.log('\n• api_impact: extended fields (responseShape, partial detection, flows)')

{
  const payload = {
    route: 'POST /api/users',
    handler: 'src/routes/users.ts',
    middleware: ['withAuth'],
    middlewareDetection: 'partial',
    middlewareNote: 'GET method may use different middleware',
    responseShape: {
      success: ['data', 'pagination'],
      error: ['message'],
    },
    consumers: [],
    executionFlows: ['UserSignup', 'UserOnboarding'],
    impactSummary: { directConsumers: 0, affectedFlows: 2, riskLevel: 'MEDIUM' },
  }
  const tools = mockToolDict('gitnexus_api_impact', payload)
  const result = (await callGitnexusApiImpact({
    tools: tools as never,
    repo: 'r',
    route: '/api/users',
  })) as GitnexusApiImpactResult

  const r = result.routes[0]!
  check('middleware array preserved', r.middleware[0] === 'withAuth')
  check(
    'middlewareDetection partial flag captured',
    r.middlewareDetection === 'partial',
    `got=${r.middlewareDetection}`,
  )
  check(
    'middlewareNote captured',
    r.middlewareNote === 'GET method may use different middleware',
    `got=${r.middlewareNote}`,
  )
  check(
    'responseShape.success captured',
    r.responseShape.success.length === 2 &&
      r.responseShape.success[0] === 'data',
    `got=${JSON.stringify(r.responseShape.success)}`,
  )
  check(
    'responseShape.error captured',
    r.responseShape.error[0] === 'message',
    `got=${JSON.stringify(r.responseShape.error)}`,
  )
  check(
    'executionFlows captured',
    r.executionFlows.length === 2 &&
      r.executionFlows[0] === 'UserSignup' &&
      r.executionFlows[1] === 'UserOnboarding',
    `got=${JSON.stringify(r.executionFlows)}`,
  )
}

// ─── 14e. parseApiImpact: defaults when extended fields absent ─────────

console.log('\n• api_impact: extended fields default cleanly when absent')

{
  const payload = {
    route: '/api/x',
    handler: 'src/x.ts',
    consumers: [],
  }
  const tools = mockToolDict('gitnexus_api_impact', payload)
  const result = await callGitnexusApiImpact({
    tools: tools as never,
    repo: 'r',
    route: '/api/x',
  })
  const r = result.routes[0]!
  check('middleware defaults to []', r.middleware.length === 0)
  check('middlewareDetection defaults to null', r.middlewareDetection === null)
  check('middlewareNote defaults to null', r.middlewareNote === null)
  check(
    'responseShape.success/error default to []',
    r.responseShape.success.length === 0 && r.responseShape.error.length === 0,
  )
  check('executionFlows defaults to []', r.executionFlows.length === 0)
}

// ─── 15. parseQueryResponse: process info attached per hit ─────────────

console.log('\n• query: process label + type + step_index attached per hit')

{
  // Mirror gitnexus 1.6.5's emission shape exactly: processes[] with
  // summary/process_type/priority; process_symbols[] with process_id
  // linking back to a process row plus step_index.
  const payload = {
    processes: [
      {
        id: 'Process:UserLogin',
        summary: 'UserLogin',
        priority: 0.875,
        symbol_count: 3,
        process_type: 'http_route',
        step_count: 5,
      },
      {
        id: 'Process:Checkout',
        summary: 'Checkout',
        priority: 0.5,
        symbol_count: 2,
        process_type: 'http_route',
        step_count: 4,
      },
    ],
    process_symbols: [
      {
        id: 'Function:src/auth/login.ts:handleLogin',
        name: 'handleLogin',
        type: 'Function',
        filePath: 'src/auth/login.ts',
        startLine: 12,
        process_id: 'Process:UserLogin',
        step_index: 1,
      },
      {
        id: 'Function:src/auth/session.ts:createSession',
        name: 'createSession',
        type: 'Function',
        filePath: 'src/auth/session.ts',
        startLine: 30,
        process_id: 'Process:UserLogin',
        step_index: 3,
      },
      {
        id: 'Function:src/cart/total.ts:computeTotal',
        name: 'computeTotal',
        type: 'Function',
        filePath: 'src/cart/total.ts',
        startLine: 8,
        process_id: 'Process:Checkout',
        step_index: 2,
      },
    ],
    definitions: [
      // Standalone definition not tied to any process. Should land in
      // the hit list with processLabel=null (no membership).
      {
        id: 'Class:src/utils/fmt.ts:Formatter',
        name: 'Formatter',
        type: 'Class',
        filePath: 'src/utils/fmt.ts',
        startLine: 4,
      },
    ],
    timing: {},
  }
  const tools = mockToolDict('gitnexus_query', payload)
  const result = (await callGitnexusQuery({
    tools: tools as never,
    repo: 'api-service',
    query: 'auth',
  })) as GitnexusQueryResponse

  check('four hits parsed (3 process_symbols + 1 definition)', result.hits.length === 4, `len=${result.hits.length}`)
  const handleLogin = result.hits.find((h) => h.symbol === 'handleLogin')
  check(
    'process_symbol hit gets processLabel from join',
    handleLogin?.processLabel === 'UserLogin',
    `got=${handleLogin?.processLabel}`,
  )
  check(
    'processType captured via lookup',
    handleLogin?.processType === 'http_route',
    `got=${handleLogin?.processType}`,
  )
  check(
    'stepIndex captured from symbol record',
    handleLogin?.stepIndex === 1,
    `got=${handleLogin?.stepIndex}`,
  )
  const computeTotal = result.hits.find((h) => h.symbol === 'computeTotal')
  check(
    'second process resolved correctly via process_id',
    computeTotal?.processLabel === 'Checkout' &&
      computeTotal?.stepIndex === 2,
    `got label=${computeTotal?.processLabel} step=${computeTotal?.stepIndex}`,
  )
  const formatter = result.hits.find((h) => h.symbol === 'Formatter')
  check(
    'definition (no process_id) has null processLabel',
    formatter?.processLabel === null,
    `got=${formatter?.processLabel}`,
  )
  check(
    'definition has null processType',
    formatter?.processType === null,
  )
  check(
    'definition has null stepIndex',
    formatter?.stepIndex === null,
  )
  check(
    'process_symbol hits sort above definition (priority scoring)',
    // Sort is by score desc. handleLogin and createSession both have
    // score 0.875 (UserLogin priority). computeTotal has 0.5. Formatter
    // has 0 (no process). So Formatter ranks LAST.
    result.hits[result.hits.length - 1]?.symbol === 'Formatter',
    `last=${result.hits[result.hits.length - 1]?.symbol}`,
  )
}

// ─── 16. parseQueryResponse: empty processes[] means null labels ────────

console.log('\n• query: empty processes[] (library repo without flows)')

{
  // Realistic case: gitnexus didn't cluster the repo into processes
  // because no entry points were detected. processes[] is empty, all
  // hits land in `definitions[]`, all processLabel/Type/stepIndex are
  // null. This mirrors what we'd see on a frontend lib like
  // react-stripe-js.
  const payload = {
    processes: [],
    process_symbols: [],
    definitions: [
      {
        id: 'Function:src/index.ts:exportCardElement',
        name: 'exportCardElement',
        type: 'Function',
        filePath: 'src/index.ts',
        startLine: 1,
      },
      {
        id: 'Function:src/Element.tsx:Element',
        name: 'Element',
        type: 'Function',
        filePath: 'src/Element.tsx',
        startLine: 5,
      },
    ],
  }
  const tools = mockToolDict('gitnexus_query', payload)
  const result = await callGitnexusQuery({
    tools: tools as never,
    repo: 'react-stripe-js',
    query: 'CardElement',
  })
  check('two hits parsed', result.hits.length === 2, `len=${result.hits.length}`)
  check(
    'all hits have null processLabel (no flows detected)',
    result.hits.every((h) => h.processLabel === null),
  )
  check(
    'all hits have null processType',
    result.hits.every((h) => h.processType === null),
  )
  check(
    'all hits have null stepIndex',
    result.hits.every((h) => h.stepIndex === null),
  )
}

// ─── 17. parseQueryResponse: legacy flat array still works ─────────────

console.log('\n• query: legacy array shape (pre-1.6.3 fallback)')

{
  // Older gitnexus versions returned a bare array. Verify our legacy
  // parser still produces hits with the new fields defaulted to null
  // (no process clustering existed in those versions).
  const payload = [
    {
      filePath: 'src/old.ts',
      name: 'oldFn',
      startLine: 1,
      reason: 'BM25 match',
      score: 0.9,
    },
  ]
  const tools = mockToolDict('gitnexus_query', payload)
  const result = await callGitnexusQuery({
    tools: tools as never,
    repo: 'r',
    query: 'old',
  })
  check('legacy hit parsed', result.hits.length === 1)
  check(
    'legacy hit defaults processLabel to null',
    result.hits[0]?.processLabel === null,
  )
  check(
    'legacy hit defaults stepIndex to null',
    result.hits[0]?.stepIndex === null,
  )
}

// ─── 14. Caller throws when tool not mounted ──────────────────────────────

console.log('\n• callers: throw clearly when tool dict lacks the key')

{
  let threw = false
  try {
    await callGitnexusRouteMap({ tools: {} as never, repo: 'r' })
  } catch (err) {
    threw = true
    check(
      'route_map: missing-tool error mentions the tool name',
      err instanceof Error && err.message.includes('gitnexus_route_map'),
      `got=${err instanceof Error ? err.message : ''}`,
    )
  }
  check('route_map call throws when tool missing', threw)
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log('\n' + '━'.repeat(60))
console.log(` Passed: ${passed}/${passed + failed}`)
if (failed > 0) {
  console.log(' Failed:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(' All checks passed.')
console.log('━'.repeat(60))
process.exit(0)
