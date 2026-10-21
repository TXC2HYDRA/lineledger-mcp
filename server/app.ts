import express, { type NextFunction, type Request, type Response } from 'express'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Db } from './db.js'
import { registerTools } from './tools.js'
import { TraceTap } from './trace.js'

export interface AppOptions {
  db: Db
  trace?: TraceTap
  /** Browser origins allowed to call the server. Requests without an Origin header (non-browser clients) pass. */
  allowedOrigins: string[]
}

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })

export function createApp({ db, trace = new TraceTap(), allowedOrigins }: AppOptions) {
  const app = express()
  app.disable('x-powered-by')

  // The SDK validates Host only. The transport spec also requires servers to validate Origin.
  app.use(hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']))
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      rpcError(res, 403, -32000, 'Origin not allowed')
      return
    }
    next()
  })
  app.use(express.json({ limit: '64kb' }))

  app.post('/mcp', async (req: Request, res: Response) => {
    // Stateless (decision D2): a new server and transport per request, state lives in SQLite.
    const server = new McpServer({ name: 'lineledger', version: '0.1.0' })
    registerTools(server, db)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    const inbound: unknown = req.body
    for (const message of Array.isArray(inbound) ? inbound : [inbound]) trace.record('in', message)
    const send = transport.send.bind(transport)
    transport.send = (message: JSONRPCMessage, options) => {
      trace.record('out', message)
      return send(message, options)
    }

    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
    }
  })
  const notAllowed = (_req: Request, res: Response) => {
    res.set('Allow', 'POST')
    rpcError(res, 405, -32000, 'Method not allowed.')
  }
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'lineledger', synthetic: true })
  })
  app.get('/api/trace', (req, res) => {
    res.json({ entries: trace.list(Number(req.query.since) || 0) })
  })
  app.get('/api/trace/stream', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    const write = (entry: { id: number }) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`)
    const unsubscribe = trace.subscribe(write)
    for (const entry of trace.list(Number(req.headers['last-event-id']) || 0)) write(entry)
    res.on('close', unsubscribe)
  })

  // JSON-RPC shaped errors for body-parser failures (oversize, bad JSON).
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') return rpcError(res, 413, -32600, 'Request body too large')
    if (err.type === 'entity.parse.failed') return rpcError(res, 400, -32700, 'Parse error')
    return rpcError(res, err.status ?? 500, -32603, 'Internal server error')
  })
  return app
}
