import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ErrorCode,
  isInitializeRequest,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import type { FactorySim } from './sim.js'
import type { Store } from './store.js'
import { registerTools } from './tools.js'
import { EVENTS_URI, FACTORY_RESOURCES, registerFactoryResources, registerSimTools, STATUS_URI } from './tools-sim.js'
import { TraceTap } from './trace.js'

export type McpMode = 'stateful' | 'stateless'

export interface AppOptions {
  store: Store
  /** The production-line simulation. Without it the simulation tools and resources are not offered. */
  sim?: FactorySim
  trace?: TraceTap
  /** Browser origins allowed to call the server. Requests without an Origin header (non-browser clients) pass. */
  allowedOrigins: string[]
  /** 'stateful' (default): MCP sessions. 'stateless': a new server per POST, no sessions, no server push. */
  mode?: McpMode
  /** Stateful only: a session with no request for this long is closed. Default 30 minutes. */
  sessionIdleMs?: number
  /** Stateful only: when a new session would exceed this, the least recently used one is closed. Default 100. */
  maxSessions?: number
  /** Stateful only: at most one resource-updated notification per resource per this many ms. Default 1000. */
  notifyEveryMs?: number
}

interface Session {
  id: string
  server: McpServer
  transport: StreamableHTTPServerTransport
  lastSeen: number
  subscriptions: Set<string>
}

/** In-memory registry of live MCP sessions (decision D2b). */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(
    private readonly idleMs: number,
    private readonly max: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.max(50, Math.min(idleMs / 2, 60_000)))
    this.sweeper.unref()
  }

  get size(): number {
    return this.sessions.size
  }

  touch(id: string): Session | undefined {
    const session = this.sessions.get(id)
    if (session) session.lastSeen = Date.now()
    return session
  }

  add(session: Session): void {
    while (this.sessions.size >= this.max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]!
      void this.close(oldest.id)
    }
    this.sessions.set(session.id, session)
  }

  /** Removes the session from the registry and closes its transport and server. */
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.transport.close().catch(() => undefined)
    await session.server.close().catch(() => undefined)
  }

  forget(id: string): void {
    this.sessions.delete(id)
  }

  subscribers(uri: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.subscriptions.has(uri))
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper)
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleMs
    for (const s of this.sessions.values()) if (s.lastSeen < cutoff) void this.close(s.id)
  }
}

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })

export function createApp({
  store,
  sim,
  trace = new TraceTap(),
  allowedOrigins,
  mode = 'stateful',
  sessionIdleMs = 30 * 60_000,
  maxSessions = 100,
  notifyEveryMs = 1000,
}: AppOptions): Express & { sessions: SessionRegistry } {
  const app = express()
  app.disable('x-powered-by')
  const sessions = new SessionRegistry(sessionIdleMs, maxSessions)

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

  const buildServer = (subscriptions?: Set<string>) => {
    const server = new McpServer(
      { name: 'lineledger', version: '0.2.0' },
      subscriptions && sim ? { capabilities: { resources: { subscribe: true, listChanged: true } } } : undefined,
    )
    registerTools(server, store)
    if (sim) {
      registerSimTools(server, sim)
      registerFactoryResources(server, sim)
      if (subscriptions) {
        server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
          if (!(FACTORY_RESOURCES as readonly string[]).includes(params.uri)) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${params.uri}`)
          subscriptions.add(params.uri)
          return {}
        })
        server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
          subscriptions.delete(params.uri)
          return {}
        })
      }
    }
    return server
  }

  const tap = (transport: StreamableHTTPServerTransport) => {
    const send = transport.send.bind(transport)
    transport.send = (message: JSONRPCMessage, options) => {
      trace.record('out', message)
      return send(message, options)
    }
  }
  const traceInbound = (body: unknown) => {
    for (const message of Array.isArray(body) ? body : [body]) trace.record('in', message)
  }

  if (mode === 'stateless') {
    // Decision D2 (kept as an option, for example for a serverless deploy): one server and transport per POST.
    app.post('/mcp', async (req: Request, res: Response) => {
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      traceInbound(req.body)
      tap(transport)
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
  } else {
    // Decision D2b: stateful Streamable HTTP. initialize creates a session (Mcp-Session-Id header); later
    // POSTs, the GET event stream (server push) and DELETE (end of session) must carry that id.
    const sessionFor = (req: Request, res: Response): Session | undefined => {
      const id = req.header('mcp-session-id')
      if (!id) {
        rpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header. Send initialize first.')
        return undefined
      }
      const session = sessions.touch(id)
      if (!session) rpcError(res, 404, -32001, 'Session not found. It ended or expired; send initialize to start a new one.')
      return session
    }

    app.post('/mcp', async (req: Request, res: Response) => {
      traceInbound(req.body)
      try {
        if (req.header('mcp-session-id') !== undefined) {
          const session = sessionFor(req, res)
          if (session) await session.transport.handleRequest(req, res, req.body)
          return
        }
        if (!isInitializeRequest(req.body)) {
          rpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header. Send initialize first.')
          return
        }
        const subscriptions = new Set<string>()
        const server = buildServer(subscriptions)
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.add({ id, server, transport, lastSeen: Date.now(), subscriptions }),
          onsessionclosed: (id) => {
            sessions.forget(id)
            void server.close()
          },
        })
        transport.onclose = () => {
          if (transport.sessionId) sessions.forget(transport.sessionId)
        }
        tap(transport)
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
      } catch {
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
      }
    })
    const streamOrEnd = async (req: Request, res: Response) => {
      const session = sessionFor(req, res)
      if (!session) return
      try {
        await session.transport.handleRequest(req, res)
      } catch {
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
      }
    }
    app.get('/mcp', streamOrEnd) // server-to-client event stream (resource updates)
    app.delete('/mcp', streamOrEnd) // the client ends its session

    // Push: when the simulation changes, tell subscribed sessions, at most once per notifyEveryMs per resource.
    if (sim) {
      const throttled = (uri: string) => {
        let last = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        const fire = () => {
          last = Date.now()
          timer = undefined
          for (const s of sessions.subscribers(uri)) void s.server.server.sendResourceUpdated({ uri }).catch(() => undefined)
        }
        return () => {
          if (timer) return
          const wait = last + notifyEveryMs - Date.now()
          if (wait <= 0) fire()
          else timer = setTimeout(fire, wait)
          timer?.unref?.()
        }
      }
      const statusChanged = throttled(STATUS_URI)
      const eventsChanged = throttled(EVENTS_URI)
      sim.onChange(({ events }) => {
        statusChanged()
        if (events) eventsChanged()
      })
    }
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'lineledger', synthetic: true, store: store.kind, mcp: mode, simulation: sim !== undefined })
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
  return Object.assign(app, { sessions })
}
