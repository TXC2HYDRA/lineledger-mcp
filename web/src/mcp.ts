import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

export type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, any>
  content: { type: string; text?: string }[]
}

// The server ends a session on DELETE, after 30 minutes idle, or when it restarts; requests with the old
// id then get HTTP 404. A new session is opened and the request is sent once more.
const sessionGone = (error: unknown) => {
  const e = error as { code?: number; message?: string }
  return e?.code === 404 || /\b404\b|Session not found/i.test(e?.message ?? '')
}

// Same-origin /mcp (Vite proxies it to the server), so no CORS is needed.
// Stateful MCP: the SDK keeps the Mcp-Session-Id and opens the server's event stream (GET /mcp) after initialize.
export class McpConnection {
  private client!: Client
  private transport!: StreamableHTTPClientTransport
  private readonly watchers = new Map<string, () => void>()
  protocolVersion: string | undefined
  sessionId: string | undefined
  /** Called when another session wrote a note or follow-up ("data_changed" logging notice). */
  onChange: (resource: string) => void = () => {}
  /** Called after a lost session was replaced by a new one. */
  onReconnect: (() => void) | undefined
  /** When the page last heard from the server: a reply or a push. */
  lastHeard = Date.now()
  /** True after a reconnect failed (the server was down), so the next call tries again. */
  private stale = false
  private reopening: Promise<void> | undefined
  private baseUrl = ''

  /** `baseUrl` is the page address by default; the tests pass the server's. */
  async connect(baseUrl: string = location.href): Promise<void> {
    this.baseUrl = baseUrl
    this.client = new Client({ name: 'lineledger-web', version: '0.2.0' })
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      this.lastHeard = Date.now()
      this.watchers.get(n.params.uri)?.()
    })
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      this.lastHeard = Date.now()
      const data = n.params.data as { event?: string; resource?: string } | undefined
      if (data?.event === 'data_changed' && data.resource) this.onChange(data.resource)
    })
    this.transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl))
    await this.client.connect(this.transport)
    this.protocolVersion = this.transport.protocolVersion
    this.sessionId = this.transport.sessionId
    for (const uri of this.watchers.keys()) await this.client.subscribeResource({ uri })
    this.stale = false
  }

  /** One reconnect at a time: calls that fail together share it. */
  private reopen(): Promise<void> {
    this.reopening ??= (async () => {
      try {
        await this.client.close().catch(() => undefined)
        await this.connect(this.baseUrl)
        this.onReconnect?.()
      } catch (error) {
        this.stale = true
        throw error
      } finally {
        this.reopening = undefined
      }
    })()
    return this.reopening
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const result = await fn()
      this.lastHeard = Date.now()
      return result
    }
    if (this.stale) await this.reopen() // an earlier reconnect failed, for example while the server was down
    try {
      return await run()
    } catch (error) {
      if (!sessionGone(error)) throw error
      await this.reopen()
      return run()
    }
  }

  /** True while a resource is watched: the server then pushes every second or so, so silence means trouble. */
  get watching(): boolean {
    return this.watchers.size > 0
  }

  /** Liveness check. After a server restart the old session id gets a 404, so this opens a new session. */
  async ping(): Promise<void> {
    await this.retry(async () => {
      await this.client.ping()
    })
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.retry(async () => (await this.client.callTool({ name, arguments: args })) as ToolResult)
  }

  async listTools() {
    return this.retry(async () => (await this.client.listTools()).tools)
  }

  async readJson(uri: string): Promise<Record<string, any>> {
    return this.retry(async () => {
      const { contents } = await this.client.readResource({ uri })
      return JSON.parse((contents[0] as { text: string }).text)
    })
  }

  /** Subscribe to a resource; onUpdate runs on each notifications/resources/updated pushed for it. */
  async watch(uri: string, onUpdate: () => void): Promise<void> {
    this.watchers.set(uri, onUpdate)
    try {
      await this.retry(() => this.client.subscribeResource({ uri }))
    } catch (error) {
      this.watchers.delete(uri)
      throw error
    }
  }

  /** Best effort: tell the server this session is over (page closed). */
  close(): void {
    void this.transport?.terminateSession().catch(() => undefined)
  }
}
