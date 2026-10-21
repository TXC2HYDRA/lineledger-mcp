// Phase 0 preflight: prove the pinned MCP SDK speaks Streamable HTTP over a real socket.
// Not run yet: dependencies are not installed until the download manifest is approved.
// APIs follow @modelcontextprotocol/sdk 1.32.1 (v1.x). VERIFY the first run against the installed package.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Request, Response } from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod/v4'

const PROTOCOL = '2025-11-25'

function buildServer(): McpServer {
  const server = new McpServer({ name: 'lineledger-preflight', version: '0.0.0' })
  server.registerTool(
    'ping',
    { title: 'Ping', description: 'Preflight smoke-test tool (read-only)', inputSchema: { text: z.string().max(100) } },
    async ({ text }) => ({ content: [{ type: 'text', text: `pong: ${text}` }] }),
  )
  return server
}

// Stateless Streamable HTTP: one server + transport per request, no MCP sessions.
const app = createMcpExpressApp()
app.post('/mcp', async (req: Request, res: Response) => {
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
}
app.get('/mcp', notAllowed)
app.delete('/mcp', notAllowed)

// Raw HTTP initialize: reads the protocol version straight off the wire, independent of the SDK client.
async function rawInitialize(url: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'raw-preflight', version: '0.0.0' } },
    }),
  })
  const text = await res.text()
  const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  const payload = isSse
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .pop()
    : text
  const message = JSON.parse(payload ?? 'null') as { result?: { protocolVersion?: string } }
  const version = message.result?.protocolVersion
  if (res.status !== 200 || !version) throw new Error(`raw initialize failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  return version
}

const httpServer: Server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s))
})

let exitCode = 0
try {
  const { port } = httpServer.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/mcp`

  const wireVersion = await rawInitialize(url)
  console.log(`raw initialize -> protocolVersion ${wireVersion}`)
  if (wireVersion !== PROTOCOL) throw new Error(`expected ${PROTOCOL}, got ${wireVersion}`)

  const client = new Client({ name: 'lineledger-preflight-client', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  const { tools } = await client.listTools()
  console.log(`tools/list -> ${tools.map((t) => t.name).join(', ')}`)
  if (!tools.some((t) => t.name === 'ping')) throw new Error('ping tool missing from tools/list')

  const result = await client.callTool({ name: 'ping', arguments: { text: 'hello' } })
  console.log('tools/call ping ->', JSON.stringify(result.content))
  await client.close()
  console.log('PASS')
} catch (error) {
  console.error('FAIL', error)
  exitCode = 1
} finally {
  httpServer.close()
}
process.exit(exitCode)
