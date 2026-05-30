/**
 * Minimal fake MCP stdio server for the lazy-MCP real-model E2E
 * (`scripts/smoke-lazy-mcp.ts`). Speaks just enough JSON-RPC to satisfy
 * `@mastra/mcp`: initialize, tools/list (one `echo` tool), tools/call.
 *
 * On startup it appends to the marker file passed as argv[2], so the harness
 * can prove the process spawned ONLY when the model actually invokes the tool
 * (lazy mount), never at agent-build time. No deps; runs under the worker's
 * sandboxed env.
 */
import { appendFileSync } from 'node:fs'

const markerPath = process.argv[2]
if (markerPath) {
  try {
    appendFileSync(markerPath, `spawned ${Date.now()}\n`)
  } catch {
    // The harness treats a missing/empty marker as "never spawned".
  }
}

const TOOLS = [
  {
    name: 'echo',
    description:
      'Echo back the provided text verbatim. Use this to repeat a word the user gives you.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'the text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // Echo the client's protocol version back so negotiation always
          // agrees regardless of which @mastra/mcp version drives us.
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-echo-mcp', version: '0.0.1' },
        },
      })
      return
    case 'notifications/initialized':
      return // notification — no response
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const text = params?.arguments?.text ?? ''
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `echo: ${text}` }] },
      })
      return
    }
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    default:
      if (id !== undefined && id !== null) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        })
      }
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    try {
      handle(msg)
    } catch {
      // keep serving
    }
  }
})
process.stdin.on('end', () => process.exit(0))
