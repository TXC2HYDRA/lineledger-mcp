// Stateful Streamable HTTP (opt-in, LINELEDGER_STATEFUL=1): one McpServer and transport per MCP session,
// kept in memory under the Mcp-Session-Id the server issues on initialize. Sessions let the server push a
// "data changed" notice on the GET stream, so a second tab updates when the first one writes.
// Session state is only the connection. Notes and follow-ups still live in SQLite, so a restart loses
// sessions but never data; clients re-initialize after the 404 (see web/src/mcp.ts).
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Store } from './store.js'
import { registerTools, type ChangeResource } from './tools.js'
import { traceSends, type TraceTap } from './trace.js'

const MAX_SESSIONS = 50
const IDLE_MS = 2 * 60 * 60 * 1000

interface Session {
  server: McpServer
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })

export function createSessionHandlers(store: Store, trace: TraceTap) {
  const sessions = new Map<string, Session>()

  const broadcast = (resource: ChangeResource) => {
    for (const { server } of sessions.values()) {
      server
        .sendLoggingMessage({ level: 'info', logger: 'lineledger', data: { event: 'data_changed', resource } })
        .catch(() => {}) // a session with no open GET stream just misses the notice
    }
  }

  function open(): Session {
    const server = new McpServer({ name: 'lineledger', version: '0.1.0' }, { capabilities: { logging: {} } })
    registerTools(server, store, broadcast)
    const session: Session = {
      server,
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, session)
        },
      }),
    }
    traceSends(session.transport, trace)
    // Set before connect(): the SDK chains onto it, and this keeps the map free of closed sessions.
    session.transport.onclose = () => {
      if (session.transport.sessionId) sessions.delete(session.transport.sessionId)
    }
    return session
  }

  const lookup = (req: Request, res: Response): Session | undefined => {
    const id = req.header('mcp-session-id')
    if (!id) {
      rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required')
      return undefined
    }
    const session = sessions.get(id)
    if (!session) {
      rpcError(res, 404, -32001, 'Session not found')
      return undefined
    }
    session.lastSeen = Date.now()
    return session
  }

  const sweep = setInterval(() => {
    for (const session of sessions.values()) if (Date.now() - session.lastSeen > IDLE_MS) void session.server.close()
  }, 60_000)
  sweep.unref()

  return {
    sessionCount: () => sessions.size,

    async post(req: Request, res: Response) {
      try {
        const inbound: unknown = req.body
        for (const message of Array.isArray(inbound) ? inbound : [inbound]) trace.record('in', message)
        let session: Session | undefined
        if (req.header('mcp-session-id')) {
          session = lookup(req, res)
          if (!session) return
        } else if (isInitializeRequest(req.body)) {
          if (sessions.size >= MAX_SESSIONS) return rpcError(res, 503, -32000, 'Too many sessions')
          session = open()
          await session.server.connect(session.transport)
        } else {
          return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required')
        }
        await session.transport.handleRequest(req, res, req.body)
      } catch {
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
      }
    },

    // GET opens the server-to-client stream, DELETE ends the session.
    async stream(req: Request, res: Response) {
      const session = lookup(req, res)
      if (!session) return
      try {
        await session.transport.handleRequest(req, res)
      } catch {
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
      }
    },
  }
}
